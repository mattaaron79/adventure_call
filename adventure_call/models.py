"""Typed data structures shared by the parser, resolver, graph builder and writer.

Every path stored on these records is repo-relative and POSIX-style so the JSON
exports are stable across platforms.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

SymbolKind = Literal["module", "function", "method", "class", "variable", "attribute"]
ParamKind = Literal["positional", "posonly", "kwonly", "vararg", "kwarg"]
DiagnosticKind = Literal[
    "syntax_error",
    "missing_node",
    "decode_error",
    "read_error",
    "unsupported",
    "skipped",
    "internal_error",
]
Confidence = Literal["exact", "heuristic", "unresolved"]
CallType = Literal["call", "constructor", "method"]
EdgeType = Literal["CALLS", "IMPORTS", "CONTAINS", "REFERENCES"]

JSONDict = dict[str, Any]


@dataclass(frozen=True)
class Param:
    """One parameter of a function or method signature."""

    name: str
    annotation: str | None = None
    default: str | None = None
    kind: ParamKind = "positional"

    def to_dict(self) -> JSONDict:
        return asdict(self)


@dataclass(frozen=True)
class SymbolDef:
    """A function, method, class or module extracted from a source file."""

    symbol_id: str
    name: str
    kind: SymbolKind
    file_path: str
    module: str
    parent: str | None = None
    start_byte: int = 0
    end_byte: int = 0
    start_line: int = 1
    end_line: int = 1
    params: list[Param] = field(default_factory=list)
    #: Return annotation exactly as written -- ``list[ToolResult]``, the
    #: string forward reference ``"Session"``, ``None`` the type.  Not
    #: normalised, resolved or evaluated: what the source says is the honest
    #: answer, and a consumer decides what to make of it.  ``None`` here means
    #: the source carried no annotation at all, which is different from an
    #: annotation whose text is ``"None"``.
    returns: str | None = None
    signature: str = ""
    docstring: str | None = None
    decorators: list[str] = field(default_factory=list)
    bases: list[str] = field(default_factory=list)
    is_async: bool = False
    #: Cyclomatic-style complexity proxy (tic-d7d1): ``1 +`` the number of
    #: branching constructs in the callable's OWN body -- if/elif, match
    #: cases, ``for``, ``while``, except handlers, boolean ``and``/``or``,
    #: ternaries and comprehension guards.  Constructs in a nested def are
    #: NOT counted; the nested def carries its own number.
    #:
    #: Deliberately NOT textbook cyclomatic complexity.  It is a proxy for
    #: "how many ways can control move through this", it is compared against
    #: other functions in the same codebase, and relative ordering is all it
    #: supports.  Do not "correct" it into a different metric without moving
    #: every consumer that reads it.
    complexity: int = 1
    #: Source lines the definition spans, header included (tic-d7d1).  The
    #: unambiguous companion to :attr:`complexity`: a long simple function
    #: and a short dense one are different problems.
    line_count: int = 0
    code: str = ""
    stub: str = ""

    def to_dict(self, *, include_code: bool = True) -> JSONDict:
        data: JSONDict = {
            "symbol_id": self.symbol_id,
            "name": self.name,
            "kind": self.kind,
            "file_path": self.file_path,
            "module": self.module,
            "parent": self.parent,
            "start_byte": self.start_byte,
            "end_byte": self.end_byte,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "params": [p.to_dict() for p in self.params],
            "returns": self.returns,
            "signature": self.signature,
            "docstring": self.docstring,
            "decorators": list(self.decorators),
            "bases": list(self.bases),
            "is_async": self.is_async,
            "complexity": self.complexity,
            "line_count": self.line_count,
            "stub": self.stub,
        }
        if include_code:
            data["code"] = self.code
        return data


@dataclass(frozen=True)
class ImportRecord:
    """A single name bound into a module by an import statement.

    ``alias`` is the local binding, i.e. the name other code in the module will
    actually use.  ``target_symbol`` is ``None`` for plain ``import x`` forms.
    """

    module: str
    alias: str
    target_module: str
    target_symbol: str | None = None
    is_relative: bool = False
    level: int = 0
    is_wildcard: bool = False
    line: int = 1

    @property
    def target(self) -> str:
        """Dotted path the alias points at, symbol included when there is one."""
        if self.target_symbol:
            return f"{self.target_module}.{self.target_symbol}" if self.target_module else self.target_symbol
        return self.target_module

    def to_dict(self) -> JSONDict:
        data = asdict(self)
        data["target"] = self.target
        return data


#: Control-flow tokens that can SKIP a call (tic-b47a).
#:
#: The word is `guard`, and it is chosen carefully: a call at guard depth 0 is
#: UNGUARDED, which is not the same as unconditional and much less the same as
#: "always runs".  An early ``return`` or ``raise`` above it kills it, and the
#: caller may itself be conditional.  Anything user-facing must say unguarded
#: too, or the UI will repeat a claim the data does not support -- tic-3a20 is
#: where a real "unavoidable" would come from, via a CFG and dominators.
#:
#: A loop body is in here because it may iterate zero times; a ``try`` body,
#: a ``finally`` and a ``with`` body are not, because reaching them runs them.
GUARD_TOKENS = frozenset(
    {
        "if",
        "if:elif",
        "if:else",
        "try:else",
        "try:except",
        "for",
        "for:else",
        "while",
        "while:else",
        "match:case",
        "comprehension",
        "comprehension:if",
        "bool",
        "ternary",
        "lambda",
        "type-checking",
    }
)

#: Tokens whose call may run more than once.
LOOP_TOKENS = frozenset(
    {"for", "while", "while:test", "comprehension", "comprehension:if", "comprehension:test"}
)


@dataclass(frozen=True)
class CallSite:
    """A call expression, attributed to the definition that encloses it."""

    module: str
    file_path: str
    raw_name: str
    root: str
    attr_path: list[str] = field(default_factory=list)
    caller_id: str | None = None
    #: The control-flow constructs between this call and its enclosing
    #: definition, outermost first (tic-b47a) -- e.g.
    #: ``["if", "for", "try:except"]``.  Empty means the call sits directly in
    #: the definition body.  See :data:`GUARD_TOKENS` for what counts as a
    #: guard and why the word matters.
    control: list[str] = field(default_factory=list)
    line: int = 1
    start_byte: int = 0
    end_byte: int = 0

    @property
    def guard_depth(self) -> int:
        """How many enclosing constructs could skip this call."""
        return sum(1 for token in self.control if token in GUARD_TOKENS)

    @property
    def unguarded(self) -> bool:
        """Nothing between this call and its definition body could skip it.

        NOT "always runs" -- see :data:`GUARD_TOKENS`.
        """
        return self.guard_depth == 0

    @property
    def in_loop(self) -> bool:
        """The call may run more than once."""
        return any(token in LOOP_TOKENS for token in self.control)

    @property
    def in_except(self) -> bool:
        """The call is on an error-handling path."""
        return "try:except" in self.control

    @property
    def in_finally(self) -> bool:
        return "try:finally" in self.control

    @property
    def in_type_checking(self) -> bool:
        """The call sits under ``if TYPE_CHECKING``, so it never runs at all."""
        return "type-checking" in self.control

    @property
    def short_circuit(self) -> bool:
        """Guarded by an ``and``/``or``/ternary rather than by a statement."""
        return any(token in ("bool", "ternary") for token in self.control)

    def to_dict(self) -> JSONDict:
        data = asdict(self)
        # Derived, never stored twice: the chain is the source of truth and
        # these are conveniences computed from it.
        data["guard_depth"] = self.guard_depth
        data["unguarded"] = self.unguarded
        data["in_loop"] = self.in_loop
        return data


#: Builtin container and scalar types a literal binds a local name to.
#: Keyed by tree-sitter node type, so the parser never has to evaluate anything.
LITERAL_TYPES: dict[str, str] = {
    "list": "list",
    "list_comprehension": "list",
    "dictionary": "dict",
    "dictionary_comprehension": "dict",
    "set": "set",
    "set_comprehension": "set",
    "tuple": "tuple",
    "string": "str",
    "concatenated_string": "str",
    "integer": "int",
    "float": "float",
    "true": "bool",
    "false": "bool",
}


@dataclass(frozen=True)
class LocalBinding:
    """A local name bound to something type-bearing inside one function body.

    Deliberately shallow (tic-97ce).  This is not type inference: it records
    what a name was bound to ONCE, syntactically, so the resolver can say what
    KIND of thing a method call on that name goes to.  A name bound twice to
    different things is dropped by the resolver rather than guessed at, and
    nothing here tracks flow, reassignment or container element types.

    The type-bearing expression is stored as a dotted path -- ``root`` plus
    ``attr_path`` -- exactly as :class:`CallSite` stores a callee, so the
    resolver can walk it with the same machinery instead of a second,
    subtly-different name lookup.
    """

    #: Symbol id of the function or method whose body contains the binding.
    scope_id: str
    #: The local name being bound.
    name: str
    #: Which syntax bound it.  ``param`` never appears here -- annotated
    #: parameters are already on :attr:`SymbolDef.params` and the resolver
    #: reads them from there rather than having the parser say it twice.
    source: Literal["assign", "annotation", "with"]
    #: First segment of the type-bearing expression: ``Foo`` for ``x = Foo()``,
    #: ``build_app`` for ``x = build_app()``, ``a`` for ``x = a.b.Foo()``,
    #: ``Bar`` for ``x: Bar``.  Empty when the expression names nothing that
    #: could be a type -- an arithmetic expression, a call on a computed
    #: callee -- in which case the binding still exists and still blocks a
    #: second binding from being trusted.
    root: str = ""
    #: The remaining segments of the dotted expression.
    attr_path: list[str] = field(default_factory=list)
    #: The builtin type a literal binds directly, e.g. ``list`` for ``x = []``.
    #: Mutually exclusive with :attr:`root`.
    literal: str | None = None
    line: int = 1

    def to_dict(self) -> JSONDict:
        return asdict(self)


#: Where a reference was written.  Chosen by measurement, not by taste: see
#: tic-89fa's notes for what each position rescues, and for the three
#: positions (decorator, parameter default, return) that rescue nothing at all
#: on either codebase and are therefore not captured.
RefPosition = Literal["argument", "assign-value", "collection"]


@dataclass(frozen=True)
class Reference:
    """A callable NAMED somewhere without being called (tic-89fa).

    ``path("o/m/<slug>/", views.menu_items)`` names a view and does not call
    it, so a call graph never sees it and the view reads as dead code.  The
    same shape covers every callback registration -- ``Thread(target=worker)``,
    ``signal.connect(handler)``, a dispatch table ``[_cmd_state, _cmd_add]``.

    A reference is emphatically NOT a call, and is kept as its own edge type
    for that reason: it is evidence that something can reach this callable,
    not evidence that anything does.  Consumers reasoning about FLOW must
    ignore these; consumers asking "is this dead" must not.

    The dotted expression is stored as ``root`` plus ``attr_path``, exactly as
    :class:`CallSite` stores a callee, so the resolver can walk it with the
    same machinery rather than a second name lookup that could disagree.
    """

    module: str
    file_path: str
    #: The expression as written, e.g. ``views.menu_items``.
    raw_name: str
    root: str
    attr_path: list[str] = field(default_factory=list)
    #: The definition containing the reference; None at module or class level,
    #: which is where framework configuration usually lives.
    scope_id: str | None = None
    position: RefPosition = "argument"
    line: int = 1
    start_byte: int = 0
    end_byte: int = 0

    def to_dict(self) -> JSONDict:
        return asdict(self)


@dataclass(frozen=True)
class ReferenceLink:
    """A resolved :class:`Reference`: who named which in-project callable."""

    #: The definition containing the reference, or the module when it sits at
    #: module or class level.
    referrer_id: str
    target_id: str
    raw_name: str
    line: int
    file_path: str
    position: RefPosition

    def to_dict(self) -> JSONDict:
        return asdict(self)


@dataclass(frozen=True)
class ParseDiagnostic:
    """Something the parser could not fully understand.

    Diagnostics never abort a run; they are collected and exported so the graph
    can be trusted (or distrusted) with the evidence in hand.
    """

    file_path: str
    kind: DiagnosticKind
    detail: str
    line: int = 0

    def to_dict(self) -> JSONDict:
        return asdict(self)


@dataclass
class ParsedFile:
    """Everything extracted from one source file."""

    file_path: str
    module: str
    language: str
    symbols: list[SymbolDef] = field(default_factory=list)
    imports: list[ImportRecord] = field(default_factory=list)
    calls: list[CallSite] = field(default_factory=list)
    #: Local names bound to something type-bearing, per function body
    #: (tic-97ce).  Not symbols -- a local is not indexed, addressed or
    #: exported; this exists only so the resolver can classify method calls
    #: on a receiver it would otherwise call an unknown name.
    locals: list[LocalBinding] = field(default_factory=list)
    #: Callables named without being called (tic-89fa).
    references: list[Reference] = field(default_factory=list)
    diagnostics: list[ParseDiagnostic] = field(default_factory=list)
    module_docstring: str | None = None

    @property
    def ok(self) -> bool:
        """True when nothing at all went wrong while parsing this file."""
        return not self.diagnostics


@dataclass(frozen=True)
class Resolution:
    """The outcome of matching one call site against the symbol table."""

    caller_id: str
    raw_name: str
    line: int
    callee_id: str | None = None
    confidence: Confidence = "unresolved"
    call_type: CallType = "call"
    reason: str | None = None
    file_path: str = ""
    #: The originating call site's control-flow breadcrumb (tic-b47a), carried
    #: through so it can reach the graph edge and the unresolved-call export.
    #: A resolution is per call SITE, so this is one chain, not a merge.
    control: list[str] = field(default_factory=list)

    def to_dict(self) -> JSONDict:
        return asdict(self)
