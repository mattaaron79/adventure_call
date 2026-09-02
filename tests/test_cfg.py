"""Per-function CFGs and the `certain` claim (tic-3a20).

Every case here is hand-derived: the source is small enough to read, and the
expected set of always-run lines is worked out by eye before the code is asked.
"""

from __future__ import annotations

from textwrap import dedent

import pytest
import tree_sitter_python
from tree_sitter import Language, Parser

from adventure_call.cfg import (
    CFG,
    ENTRY,
    build_cfg,
    certain_bytes,
    certain_statements,
    dominators,
    is_generator,
)

LANGUAGE = Language(tree_sitter_python.language())
PARSER = Parser(LANGUAGE)


def certain_lines(source: str) -> set[int]:
    """1-based line numbers of the statements that run on every path."""
    text = dedent(source).lstrip("\n").encode("utf8")
    tree = PARSER.parse(text)
    function = tree.root_node.named_children[0]
    assert function.type == "function_definition"
    body = function.child_by_field_name("body")
    return {text[:byte].count(b"\n") + 1 for byte in certain_bytes(build_cfg(body))}


# -- the constructs --------------------------------------------------------


def test_a_straight_line_is_all_certain():
    assert certain_lines("def f():\n    a()\n    b()\n") == {2, 3}


def test_an_if_without_an_else_guards_only_its_own_body():
    assert certain_lines("def f(x):\n    if x:\n        a()\n    b()\n") == {2, 4}


def test_neither_arm_of_an_if_else_is_certain():
    source = "def f(x):\n    if x:\n        a()\n    else:\n        b()\n    c()\n"
    assert certain_lines(source) == {2, 6}


def test_an_elif_chain_leaves_every_arm_uncertain():
    source = (
        "def f(x):\n    if x:\n        a()\n    elif x:\n        b()\n"
        "    else:\n        c()\n    d()\n"
    )
    assert certain_lines(source) == {2, 8}


def test_a_loop_body_may_run_zero_times():
    assert certain_lines("def f(xs):\n    for x in xs:\n        a()\n    b()\n") == {2, 4}
    assert certain_lines("def f(x):\n    while x:\n        a()\n    b()\n") == {2, 4}


def test_a_with_body_always_runs():
    """`__exit__` can swallow an exception on the way out; it cannot skip the
    block."""
    source = "def f(p):\n    with open(p) as fh:\n        a()\n    b()\n"
    assert certain_lines(source) == {2, 3, 4}


def test_a_match_case_is_never_certain():
    """Proving a `match` exhaustive needs the pattern semantics, and claiming
    it wrongly would promise a call that does not run."""
    source = "def f(x):\n    match x:\n        case 1:\n            a()\n    b()\n"
    assert certain_lines(source) == {2, 5}


def test_a_nested_definition_is_one_statement():
    """Defining a function completes; its body is somebody else's graph."""
    assert certain_lines("def f():\n    def g():\n        a()\n    b()\n") == {2, 4}


# -- early exits, which is what `unguarded` gets wrong ---------------------


def test_a_call_after_a_conditional_early_return_is_not_certain():
    """The case the whole ticket exists for: `b()` is unguarded and does not
    always run."""
    assert certain_lines("def f(x):\n    if x:\n        return\n    b()\n") == {2}


def test_a_call_after_a_conditional_raise_is_not_certain():
    assert certain_lines("def f(x):\n    if x:\n        raise E\n    b()\n") == {2}


def test_a_call_before_an_early_return_still_is():
    assert certain_lines("def f(x):\n    a()\n    if x:\n        return\n    b()\n") == {2, 3}


def test_a_call_after_an_unconditional_return_is_not_certain():
    """Unreachable, and an unreachable node vacuously dominates everything --
    which is exactly why the condition needs reachability as well as
    dominance."""
    assert certain_lines("def f():\n    return\n    b()\n") == {2}


def test_continue_skips_the_rest_of_the_loop_body():
    source = "def f(xs):\n    for x in xs:\n        if x:\n            continue\n        a()\n    b()\n"
    assert certain_lines(source) == {2, 6}


# -- the Python traps ------------------------------------------------------


def test_a_call_in_a_finally_is_certain():
    """`finally` runs on every path out, exceptional paths included.  The
    other half of the pair the ticket asked for by name."""
    assert certain_lines("def f():\n    try:\n        a()\n    finally:\n        b()\n") == {3, 5}


def test_a_finally_still_runs_when_the_body_returns():
    source = (
        "def f(x):\n    try:\n        if x:\n            return\n        a()\n"
        "    finally:\n        b()\n"
    )
    assert certain_lines(source) == {3, 7}


def test_code_after_a_try_finally_is_not_certain():
    """The `finally` runs and then the exception carries on past it, so
    `c()` is skipped.  This is the case that needs the exceptional edge out
    of the finally: without it every path would look like it continued into
    `c()`, and the `finally` case above would still pass while this one
    quietly went wrong."""
    source = "def f():\n    try:\n        a()\n    finally:\n        b()\n    c()\n"
    assert certain_lines(source) == {3, 5}


def test_only_the_first_statement_of_a_try_body_is_certain():
    """An exception in a `try:` body is a path the code itself wrote down, so
    it is modelled -- unlike the implicit "anything can raise", which would
    make nothing certain anywhere."""
    source = (
        "def f():\n    try:\n        a()\n        b()\n    except E:\n        pass\n    c()\n"
    )
    assert certain_lines(source) == {3, 7}


def test_an_except_body_is_not_certain():
    source = "def f():\n    try:\n        a()\n    except E:\n        b()\n    c()\n"
    assert certain_lines(source) == {3, 6}


def test_a_try_else_is_not_certain():
    """`try/else` runs only when the body did not raise."""
    source = (
        "def f():\n    try:\n        a()\n    except E:\n        pass\n"
        "    else:\n        b()\n    c()\n"
    )
    assert certain_lines(source) == {3, 8}


def test_a_for_else_is_not_certain_when_the_body_can_break():
    """`for/else` runs only when the loop was not broken out of."""
    source = (
        "def f(xs):\n    for x in xs:\n        if x:\n            break\n"
        "    else:\n        a()\n    b()\n"
    )
    assert certain_lines(source) == {2, 7}


def test_a_bare_raise_still_leaves_by_the_exit():
    """So `b()` below the try is NOT certain: the handler re-raises rather
    than falling through, and that is the only thing keeping `b()` off every
    path.  I expected {3, 6} writing this, and the CFG was right."""
    source = "def f(x):\n    try:\n        a()\n    except E:\n        raise\n    b()\n"
    assert certain_lines(source) == {3}

    # Swap the bare `raise` for a `pass` and `b()` is certain again, which
    # is exactly the difference the exit edge makes.
    swallowed = "def f(x):\n    try:\n        a()\n    except E:\n        pass\n    b()\n"
    assert certain_lines(swallowed) == {3, 6}


def test_nothing_in_a_generator_is_certain():
    """Calling a generator builds an iterator and runs none of the body."""
    text = dedent("def f(x):\n    a()\n    yield x\n").encode("utf8")
    function = PARSER.parse(text).root_node.named_children[0]
    assert is_generator(function) is True
    certain, every = certain_statements(function)
    assert certain == set()
    assert len(every) == 2  # the statements are in the graph; none of them run


def test_a_yield_in_a_nested_def_does_not_make_the_outer_one_a_generator():
    text = dedent(
        "def f(x):\n    def g():\n        yield 1\n    a()\n"
    ).encode("utf8")
    function = PARSER.parse(text).root_node.named_children[0]
    assert is_generator(function) is False


# -- module level ----------------------------------------------------------


def test_module_level_code_gets_the_same_question_asked():
    """A Django URLconf's `path(...)` runs on import, and reading it as
    conditional would be wrong in the one place it matters most."""
    text = dedent("from x import path\nurlpatterns = [path('', home)]\n").encode("utf8")
    module = PARSER.parse(text).root_node
    certain, every = certain_statements(module)
    assert len(certain) == 2
    assert certain == every


# -- the algorithm itself --------------------------------------------------


def test_the_graph_does_not_evaluate_conditions():
    """`while True:` is a `while` like any other here.

    Its test is certain -- reaching the function reaches the test -- and its
    body is not, because nothing in a syntactic CFG knows the condition never
    goes false.  Claiming otherwise needs constant folding, and the failure
    mode of not doing it is a call we decline to promise.
    """
    assert certain_lines("def f():\n    while True:\n        a()\n") == {2}


def test_no_certain_statements_when_the_exit_is_unreachable():
    """The guard in `certain_bytes`, exercised directly.

    No real Python reaches it -- even `while True` keeps a syntactic edge
    past the loop -- but a graph with no path to its exit has to answer
    "nothing" rather than walk off the end of the dominator chain.
    """
    cfg = CFG()
    stranded = cfg.synthetic()
    cfg.edge(ENTRY, stranded)
    cfg.edge(stranded, stranded)
    assert certain_bytes(cfg) == set()


def test_dominators_reach_only_what_is_reachable():
    text = dedent("def f():\n    return\n    b()\n").encode("utf8")
    function = PARSER.parse(text).root_node.named_children[0]
    cfg = build_cfg(function.child_by_field_name("body"))
    idom = dominators(cfg)
    unreachable = [
        node for node, byte in cfg.byte_of.items() if text[:byte].count(b"\n") + 1 == 3
    ]
    assert unreachable and all(node not in idom for node in unreachable)


# -- through the parser ----------------------------------------------------


@pytest.mark.parametrize(
    "source, expected",
    [
        ("def f():\n    a()\n", {"a": True}),
        ("def f(x):\n    if x:\n        return\n    a()\n", {"a": False}),
        ("def f():\n    try:\n        pass\n    finally:\n        a()\n", {"a": True}),
        ("def f(x):\n    a()\n    yield x\n", {"a": False}),
        # Sub-statement guards the CFG cannot see, which tic-b47a's breadcrumb
        # can -- `certain` is the conjunction of the two checks.
        ("def f(x):\n    y = 1 if x else a()\n", {"a": False}),
        ("def f(x):\n    y = x and a()\n", {"a": False}),
        ("def f(xs):\n    y = [a() for x in xs]\n", {"a": False}),
        ("def f(x):\n    assert a()\n", {"a": False}),
    ],
)
def test_the_parser_marks_each_call_site(parse_source, source, expected):
    parsed = parse_source(source)
    got = {call.raw_name: call.certain for call in parsed.calls if call.raw_name in expected}
    assert got == expected


def test_certain_is_always_a_stronger_claim_than_unguarded(parse_source):
    """`certain` is a strict subset of `unguarded` by construction, which is
    the right relationship between a claim and the weaker one it replaces.
    Measured on ../carnot, zero of 2441 certain sites are guarded."""
    source = """
        def f(x, xs):
            a()
            if x:
                b()
                return
            for i in xs:
                c()
            y = 1 if x else d()
            assert e()
            with open(x) as fh:
                g()
    """
    for call in parse_source(source).calls:
        if call.certain:
            assert call.guard_depth == 0, call.raw_name
