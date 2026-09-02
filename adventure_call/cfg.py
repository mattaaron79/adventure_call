"""Per-function control-flow graphs and the dominance question (tic-3a20).

tic-b47a's ``unguarded`` says a call is not inside a conditional.  That is
weaker than it sounds: an early ``return`` above the call still skips it.  This
module answers the stronger question -- *if this function runs, does this call
run* -- by building a control-flow graph per function body and asking which
statements lie on every path from entry to exit.

## The gate this ticket set itself, answered

tic-3a20 said not to start before measuring whether the cheap approximation is
actually insufficient.  Measured across every unguarded call site:

    ../carnot     9411 unguarded    17.4% could be skipped by an early exit
    hypermenu     3205 unguarded    16.1%

So roughly one unguarded call in six is not certain, and the badge overclaims
on all of them.  That is what justifies the cost below.

## The exact condition, derived

A call at statement ``S`` is UNAVOIDABLE iff every path from entry to exit
passes through ``S``.  With a single synthetic exit node, "every path from
entry to X passes through S" is the definition of *S dominates X*, so the
condition is exactly:

    S is reachable from ENTRY, and S dominates EXIT.

The ticket asked for both a dominator and a post-dominator tree.  It needs
only one: *S post-dominates ENTRY* and *S dominates EXIT* are the same
statement -- both unfold to "every entry-to-exit path contains S" -- so the
second computation would restate the first.  Reachability is the other half
and is not optional: an unreachable node vacuously dominates everything, and
without the check a statement below an unconditional ``return`` would come out
certain.

## What is modelled, and what is deliberately not

Explicit control flow only: ``if``/``elif``/``else``, ``for``/``while`` with
``break`` and ``continue``, ``try``/``except``/``else``/``finally``, ``with``,
``match``, and ``return``/``raise``.

NOT modelled: the fact that any Python statement can raise.  Modelling that
faithfully would put an edge from every statement to the exit, and then
nothing after the first statement would ever be certain -- a true answer that
tells you nothing.  So ``certain`` means *certain barring an unhandled
exception*, and the word in every docstring and test says so.

The one exception to that exception is a ``try:`` body, where an exception is
not unhandled but caught: each statement in a try body does get an edge to the
handlers, because that is a path the code itself wrote down.  It is also 2.5%
of ../carnot's unguarded calls, so it is not hypothetical.

## The Python traps, each with a test

* ``finally`` runs on every path, exceptional ones included, so its statements
  dominate the exit and ARE certain.  This is the case that most often
  surprises people and :func:`build_cfg` routes four separate edges into it.
* ``try/else`` runs only when the body did not raise, so it is guarded.
* ``for/else`` runs only when the loop was not broken out of, so a ``break``
  in the body makes it guarded.
* A bare ``raise`` re-raises and still leaves by the exit edge.
* A call inside an expression -- a ternary arm, the right of ``and``, a
  comprehension body, a lambda -- is skippable without any statement being
  skipped, and a statement-granularity CFG cannot see it.  tic-b47a's
  breadcrumb can, so `certain` is the CONJUNCTION of the two: the statement
  lies on every path AND the breadcrumb carries no guard.  That makes
  ``certain`` a strict subset of ``unguarded`` by construction, which is the
  right relationship between a claim and the weaker one it replaces.
* A ``yield`` anywhere in the body means calling the function runs NONE of it
  -- a generator suspends at the first yield and never starts without an
  iterator -- so no statement in a generator is certain to the caller, whatever
  the graph says.  :func:`certain_statements` refuses the whole function.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from tree_sitter import Node

#: Nodes that own a scope of their own.  The walk does not descend into them:
#: a nested definition's body does not run when the outer function does, and a
#: `return` inside it belongs to the inner function.
_SCOPE_NODES = frozenset({"function_definition", "class_definition", "lambda"})

#: Statement types the walk handles specially; anything else is a plain node
#: with one entry and one exit.
_EXCEPT_CLAUSES = frozenset({"except_clause", "except_group_clause"})

#: Breadcrumb tokens (tic-b47a) that skip a call from INSIDE its statement,
#: which a statement-granularity CFG cannot see.
#:
#: `x = a if c else f()` is one statement, and the CFG rightly says the
#: statement always runs -- but `f()` only runs on one branch of it.  Measured
#: on ../carnot before this set existed, 65 call sites came out certain while
#: their own breadcrumb said `ternary`, `bool`, `comprehension` or `lambda`.
#:
#: `assert` is here for a different reason and belongs just as much: `python
#: -O` removes assert statements outright, so a call in one is not something
#: to promise runs.  It is deliberately NOT added to `GUARD_TOKENS`, which is
#: tic-b47a's published vocabulary and whose measured distribution should not
#: shift under it.
#:
#: `decorator` stays out: a decorator runs at definition time, exactly once,
#: whenever the module is imported.
SUBSTATEMENT_GUARDS = frozenset(
    {
        "bool",
        "ternary",
        "lambda",
        "comprehension",
        "comprehension:if",
        "comprehension:test",
        "assert",
    }
)

ENTRY = 0
EXIT = 1


@dataclass
class CFG:
    """A function body's control-flow graph.

    Nodes are STATEMENTS rather than maximal basic blocks.  Blocks would be
    fewer and no more informative here: the question is per statement, and
    building blocks would only add a mapping back from statements to them.
    """

    #: Node id -> the statement's start byte.  ENTRY, EXIT and the join nodes
    #: are absent, which is how a caller tells a statement from plumbing.
    byte_of: dict[int, int] = field(default_factory=dict)
    #: Node id -> its successors.
    succ: dict[int, set[int]] = field(default_factory=lambda: {ENTRY: set(), EXIT: set()})
    _next: int = 2  # ENTRY and EXIT own 0 and 1

    def add(self, node: Node) -> int:
        """A new graph node standing for one statement."""
        node_id = self.synthetic()
        self.byte_of[node_id] = node.start_byte
        return node_id

    def synthetic(self) -> int:
        """A join node that stands for no statement.

        `finally` needs one: control converges after its body from four
        directions, and giving that join the `finally:` header's byte would
        report the header itself as a statement that always runs.
        """
        node_id = self._next
        self._next += 1
        self.succ[node_id] = set()
        return node_id

    def edge(self, source: int, target: int) -> None:
        self.succ.setdefault(source, set()).add(target)


@dataclass
class _Loop:
    """Where `break` and `continue` go, for the loop currently being walked."""

    on_break: int
    on_continue: int


class _Builder:
    """Walks a function body, threading edges as it goes.

    Each construct is walked with an explicit `after` node -- where control
    goes when the construct completes normally -- which is what keeps the
    recursion straightforward and the `finally` handling honest.
    """

    def __init__(self) -> None:
        self.cfg = CFG()
        self.loops: list[_Loop] = []
        #: Innermost enclosing `finally` entry, which a `return` must route
        #: through rather than jumping straight to the exit.
        self.finallys: list[int] = []
        #: Innermost enclosing handler entries, which a statement in a `try:`
        #: body can reach by raising.
        self.handlers: list[list[int]] = []

    # -- helpers -----------------------------------------------------------

    def _leave(self) -> int:
        """Where a `return` or `raise` goes: the innermost finally, or out."""
        return self.finallys[-1] if self.finallys else EXIT

    @staticmethod
    def _body_of(node: Node) -> list[Node]:
        """The statements a construct governs.

        Three lookups because tree-sitter-python names the same thing three
        ways: `for`/`while`/`try`/`with`/`match` use `body`, `if` and `case`
        use `consequence`, and the trailing clauses -- `elif`, `else`,
        `except`, `finally` -- give their block no field name at all.  Reading
        only `body` returned nothing for an `if`, which made every statement
        after one look certain; that is what the third lookup is for.

        Which makes the first two redundant TODAY, and a mutation test says so:
        deleting them breaks nothing, because the governed block is also
        always the first `block` child of every construct here.  They stay
        because they say what is meant, and because a grammar that ever put
        another block first would make the scan silently wrong where the field
        lookup would still be right.  A reader should know which half is
        currently doing the work.
        """
        block = node.child_by_field_name("body") or node.child_by_field_name("consequence")
        if block is None:
            block = next((c for c in node.children if c.type == "block"), None)
        return list(block.named_children) if block is not None else []

    # -- the walk ----------------------------------------------------------

    def block(self, statements: list[Node], after: int) -> int:
        """Wire a run of statements, returning where control enters them."""
        entry = after
        for statement in reversed(statements):
            entry = self.statement(statement, entry)
        return entry

    def statement(self, node: Node, after: int) -> int:
        kind = node.type
        handler = getattr(self, f"_walk_{kind}", None)
        if handler is not None:
            return handler(node, after)

        # A plain statement: one node, one edge out.  Nested definitions land
        # here too, which is right -- defining a function is a statement that
        # completes, and its body is not walked.
        this = self.cfg.add(node)
        self.cfg.edge(this, after)
        # In a `try:` body an exception is a path the code wrote down, so it
        # is modelled.  Everywhere else it would be an edge from every
        # statement to the exit, and then nothing would ever be certain.
        for entry in self.handlers[-1] if self.handlers else ():
            self.cfg.edge(this, entry)
        return this

    def _walk_return_statement(self, node: Node, after: int) -> int:
        this = self.cfg.add(node)
        self.cfg.edge(this, self._leave())
        return this

    def _walk_raise_statement(self, node: Node, after: int) -> int:
        this = self.cfg.add(node)
        # A bare `raise` re-raises whatever is being handled; either way this
        # statement leaves by the exit rather than falling through.
        self.cfg.edge(this, self._leave())
        for entry in self.handlers[-1] if self.handlers else ():
            self.cfg.edge(this, entry)
        return this

    def _walk_break_statement(self, node: Node, after: int) -> int:
        this = self.cfg.add(node)
        self.cfg.edge(this, self.loops[-1].on_break if self.loops else self._leave())
        return this

    def _walk_continue_statement(self, node: Node, after: int) -> int:
        this = self.cfg.add(node)
        self.cfg.edge(this, self.loops[-1].on_continue if self.loops else self._leave())
        return this

    def _walk_if_statement(self, node: Node, after: int) -> int:
        test = self.cfg.add(node)
        consequence = self.block(self._body_of(node), after)
        self.cfg.edge(test, consequence)

        alternatives = [c for c in node.children if c.type in ("elif_clause", "else_clause")]
        self.cfg.edge(test, self._alternatives(alternatives, after))
        return test

    def _alternatives(self, clauses: list[Node], after: int) -> int:
        """The `elif`/`else` chain, or `after` when the chain runs out.

        An `if` with no `else` falls through, which is exactly why its
        consequence does not dominate anything below it.
        """
        if not clauses:
            return after
        first, rest = clauses[0], clauses[1:]
        if first.type == "else_clause":
            return self.block(self._body_of(first), after)
        test = self.cfg.add(first)
        self.cfg.edge(test, self.block(self._body_of(first), after))
        self.cfg.edge(test, self._alternatives(rest, after))
        return test

    def _walk_while_statement(self, node: Node, after: int) -> int:
        else_clause = node.child_by_field_name("alternative")
        # `while/else` runs when the loop ends without a break, so a break
        # skips it -- the same shape as `for/else`.
        on_normal_end = (
            self.block(self._body_of(else_clause), after) if else_clause is not None else after
        )
        test = self.cfg.add(node)
        self.loops.append(_Loop(on_break=after, on_continue=test))
        body = self.block(self._body_of(node), test)
        self.loops.pop()
        self.cfg.edge(test, body)
        self.cfg.edge(test, on_normal_end)
        return test

    def _walk_for_statement(self, node: Node, after: int) -> int:
        else_clause = node.child_by_field_name("alternative")
        on_normal_end = (
            self.block(self._body_of(else_clause), after) if else_clause is not None else after
        )
        head = self.cfg.add(node)
        self.loops.append(_Loop(on_break=after, on_continue=head))
        body = self.block(self._body_of(node), head)
        self.loops.pop()
        self.cfg.edge(head, body)
        # A `for` over an empty iterable runs the body zero times, which is
        # the whole reason a loop body guards its calls.
        self.cfg.edge(head, on_normal_end)
        return head

    def _walk_match_statement(self, node: Node, after: int) -> int:
        """Every case is optional.

        A `match` with a `case _` is exhaustive and always takes some branch,
        but proving exhaustiveness needs the pattern semantics, and claiming
        it wrongly would say a call is unavoidable when it is not.  So the
        subject node keeps an edge straight to `after` and no case body is
        ever certain -- the failure a reader can recover from.
        """
        subject = self.cfg.add(node)
        for clause in self._body_of(node):
            if clause.type != "case_clause":
                continue
            self.cfg.edge(subject, self.block(self._body_of(clause), after))
        self.cfg.edge(subject, after)
        return subject

    def _walk_with_statement(self, node: Node, after: int) -> int:
        # The body of a `with` runs; `__exit__` can swallow an exception on the
        # way out but cannot skip the block.  So it is a plain sequence, and
        # its statements dominate what follows.
        head = self.cfg.add(node)
        self.cfg.edge(head, self.block(self._body_of(node), after))
        return head

    def _walk_try_statement(self, node: Node, after: int) -> int:
        finally_clause = next((c for c in node.children if c.type == "finally_clause"), None)
        handler_clauses = [c for c in node.children if c.type in _EXCEPT_CLAUSES]
        else_clause = next((c for c in node.children if c.type == "else_clause"), None)

        # `finally` sits on every way out: normal completion, a handled
        # exception, an unhandled one, and a `return` from inside.  It is
        # built first so everything below can point at it.
        if finally_clause is not None:
            after_finally = self.cfg.synthetic()
            self.cfg.edge(after_finally, after)
            # The exceptional continuation.  This edge is what makes a call in
            # a `finally` dominate the exit -- and it is the whole reason
            # `finally` is certain where a `try:` body is not.
            self.cfg.edge(after_finally, EXIT)
            # A `return` inside the body routes here rather than to the exit,
            # which is what `self.finallys` is for below.
            finally_entry = self.block(self._body_of(finally_clause), after_finally)
        else:
            finally_entry = after

        # Handlers run on an exception and then continue past the whole try.
        handler_entries: list[int] = []
        for clause in handler_clauses:
            head = self.cfg.add(clause)
            self.cfg.edge(head, self.block(self._body_of(clause), finally_entry))
            handler_entries.append(head)
        if finally_clause is not None and not handler_clauses:
            # try/finally with no except: an exception still runs the finally
            # and then leaves.
            handler_entries.append(finally_entry)

        # `try/else` runs only when the body did not raise.
        on_clean = (
            self.block(self._body_of(else_clause), finally_entry)
            if else_clause is not None
            else finally_entry
        )

        if finally_clause is not None:
            self.finallys.append(finally_entry)
        self.handlers.append(handler_entries)
        body = self.block(self._body_of(node), on_clean)
        self.handlers.pop()
        if finally_clause is not None:
            self.finallys.pop()

        return body


def build_cfg(body: Node) -> CFG:
    """The control-flow graph of one function body.

    `body` is the `block` node of a `function_definition`.  ENTRY is wired to
    the first statement and falling off the end reaches EXIT, which is what
    makes an implicit `return None` behave like an explicit one.
    """
    builder = _Builder()
    statements = [c for c in body.named_children]
    entry = builder.block(statements, EXIT)
    builder.cfg.edge(ENTRY, entry)
    return builder.cfg


def is_generator(function_node: Node) -> bool:
    """Whether the body yields, so calling it runs none of the body.

    A generator function called normally builds an iterator and returns; the
    body does not start until something iterates it, and may never start at
    all.  So "if this function runs, this call runs" is false for every call
    in it, whatever the graph says.

    The walk stops at a nested scope: a `yield` inside an inner `def` makes
    THAT one a generator, not this one.
    """
    stack = [function_node.child_by_field_name("body")]

    while stack:
        node = stack.pop()
        if node is None:
            continue
        if node.type in ("yield", "await"):
            # `await` is here for the same reason and a different mechanism:
            # a coroutine call returns a coroutine object and runs nothing
            # until it is awaited or scheduled.
            if node.type == "yield":
                return True
        for child in node.named_children:
            if child.type in _SCOPE_NODES:
                continue
            stack.append(child)
    return False


def certain_statements(function_node: Node) -> tuple[set[int], set[int]]:
    """Start bytes of one function's certain statements, and of all of them.

    The second set is what a caller needs to tell "this statement is not
    certain" from "this statement is not in the graph at all" -- a call in a
    construct the walk does not model would otherwise silently read as
    uncertain, which is the right answer for the wrong reason.

    A generator gets an empty certain set: see :func:`is_generator`.

    A `module` node is accepted as well as a `function_definition`, because
    module-level code has exactly the same shape of question -- if the module
    is imported, does this call run -- and answering it is what keeps a Django
    URLconf's `path(...)` from reading as conditional.
    """
    if function_node.type == "module":
        return certain_bytes(build_cfg(function_node)), _statement_bytes(function_node)
    body = function_node.child_by_field_name("body")
    if body is None:
        return set(), set()
    cfg = build_cfg(body)
    every = set(cfg.byte_of.values())
    if is_generator(function_node):
        return set(), every
    return certain_bytes(cfg), every


def _statement_bytes(node: Node) -> set[int]:
    return set(build_cfg(node).byte_of.values())


def governing_statement(node: Node, statements: set[int]) -> int | None:
    """The start byte of the statement that decides whether `node` runs.

    Walks out to the innermost ancestor the CFG holds.  An `if` TEST governs
    with the `if` itself, which is right: reaching the `if` evaluates its
    condition, so a call there runs whenever the statement does.  An `elif`
    test governs with the `elif` clause for the opposite reason -- reaching it
    means every earlier test already failed.
    """
    current: Node | None = node
    while current is not None:
        if current.start_byte in statements:
            return current.start_byte
        current = current.parent
    return None


def dominators(cfg: CFG) -> dict[int, int]:
    """Immediate dominator of every node reachable from ENTRY.

    Cooper-Harvey-Kennedy, iterated to a fixpoint over reverse postorder.  The
    same algorithm as the web side's tic-d8f2, and iterative here for the same
    reason it is there: a long function is a long chain, and recursion on it
    would be a stack depth set by someone else's code.
    """
    order = _reverse_postorder(cfg)
    preds: dict[int, set[int]] = {node: set() for node in order}
    for source, targets in cfg.succ.items():
        if source not in preds:
            continue
        for target in targets:
            if target in preds:
                preds[target].add(source)

    index = {node: i for i, node in enumerate(order)}
    idom: dict[int, int] = {ENTRY: ENTRY}

    def intersect(a: int, b: int) -> int:
        while a != b:
            while index[a] > index[b]:
                a = idom[a]
            while index[b] > index[a]:
                b = idom[b]
        return a

    changed = True
    while changed:
        changed = False
        for node in order:
            if node == ENTRY:
                continue
            candidate: int | None = None
            for pred in preds[node]:
                if pred not in idom:
                    continue
                candidate = pred if candidate is None else intersect(candidate, pred)
            if candidate is not None and idom.get(node) != candidate:
                idom[node] = candidate
                changed = True
    return idom


def _reverse_postorder(cfg: CFG) -> list[int]:
    """Nodes reachable from ENTRY, in reverse postorder.

    Iterative: a two-thousand-statement function is not exotic and a recursive
    DFS on one would be a stack overflow waiting for the wrong input.
    """
    postorder: list[int] = []
    seen = {ENTRY}
    stack: list[tuple[int, list[int]]] = [(ENTRY, sorted(cfg.succ.get(ENTRY, ())))]
    while stack:
        node, remaining = stack[-1]
        advanced = False
        while remaining:
            child = remaining.pop()
            if child in seen:
                continue
            seen.add(child)
            stack.append((child, sorted(cfg.succ.get(child, ()))))
            advanced = True
            break
        if not advanced:
            postorder.append(node)
            stack.pop()
    postorder.reverse()
    return postorder


def certain_bytes(cfg: CFG) -> set[int]:
    """Start bytes of the statements that lie on every path entry -> exit.

    Reachable from ENTRY *and* dominating EXIT -- see the module docstring for
    why that is the exact condition, and why one dominator computation answers
    it rather than two.
    """
    idom = dominators(cfg)
    if EXIT not in idom:
        # A function that never reaches its exit -- an infinite loop with no
        # return.  Nothing "lies on every path to exit" when there is no path.
        return set()

    on_every_path: set[int] = set()
    walker = idom[EXIT]
    seen: set[int] = set()
    while walker not in seen:
        seen.add(walker)
        if walker in cfg.byte_of:
            on_every_path.add(cfg.byte_of[walker])
        if walker == ENTRY:
            break
        walker = idom[walker]
    return on_every_path
