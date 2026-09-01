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
EdgeType = Literal["CALLS", "IMPORTS", "CONTAINS"]

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


@dataclass(frozen=True)
class CallSite:
    """A call expression, attributed to the definition that encloses it."""

    module: str
    file_path: str
    raw_name: str
    root: str
    attr_path: list[str] = field(default_factory=list)
    caller_id: str | None = None
    line: int = 1
    start_byte: int = 0
    end_byte: int = 0

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

    def to_dict(self) -> JSONDict:
        return asdict(self)
