"""Build a codebase dependency graph with Tree-sitter and NetworkX."""

from __future__ import annotations

__version__ = "0.1.0"

from adventure_call.graph import (
    CALLS,
    CONTAINS,
    IMPORTS,
    GraphBuilder,
    RoomContext,
    SymbolNotFoundError,
    build_codebase_graph,
)
from adventure_call.models import (
    CallSite,
    ImportRecord,
    Param,
    ParseDiagnostic,
    ParsedFile,
    Resolution,
    SymbolDef,
)
from adventure_call.parser import CodebaseParser
from adventure_call.resolver import Binding, ResolutionIndex, SymbolResolver
from adventure_call.writer import OutputWriter

__all__ = [
    "CALLS",
    "CONTAINS",
    "IMPORTS",
    "Binding",
    "CallSite",
    "CodebaseParser",
    "GraphBuilder",
    "ImportRecord",
    "OutputWriter",
    "Param",
    "ParseDiagnostic",
    "ParsedFile",
    "Resolution",
    "ResolutionIndex",
    "RoomContext",
    "SymbolDef",
    "SymbolNotFoundError",
    "SymbolResolver",
    "__version__",
    "build_codebase_graph",
]
