"""NetworkX graph construction and level-of-detail context extraction.

Graph nodes carry *stubbed* definitions -- signature, docstring and a ``...``
body -- so the whole graph stays small enough to load, ship and reason about.
Full source is kept on the node too, but the writer strips it from the graph
export; :meth:`GraphBuilder.get_room_context` is what hands it back, and only
for the one symbol in focus.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import networkx as nx

from adventure_call.models import ParsedFile
from adventure_call.resolver import ResolutionIndex, SymbolResolver

CALLS = "CALLS"
IMPORTS = "IMPORTS"
CONTAINS = "CONTAINS"

_CONFIDENCE_RANK = {"exact": 2, "heuristic": 1, "unresolved": 0}


class SymbolNotFoundError(KeyError):
    """Raised when a requested symbol id is not in the graph."""

    def __init__(self, symbol_id: str, suggestions: Sequence[str] = ()) -> None:
        self.symbol_id = symbol_id
        self.suggestions = list(suggestions)
        hint = f"  Did you mean: {', '.join(self.suggestions)}?" if suggestions else ""
        super().__init__(f"{symbol_id!r} is not in the graph.{hint}")

    def __str__(self) -> str:  # KeyError repr()s its arg, which reads badly
        return self.args[0]


@dataclass
class RoomContext:
    """A 1-hop level-of-detail slice of the graph around one symbol.

    Full code for the focus, signatures for whoever calls it, signatures plus
    docstrings for whatever it calls.  Exactly enough to understand the symbol
    without reading the repository.
    """

    symbol_id: str
    focus: dict[str, Any]
    upstream: list[dict[str, Any]] = field(default_factory=list)
    downstream: list[dict[str, Any]] = field(default_factory=list)
    unresolved: list[dict[str, Any]] = field(default_factory=list)
    truncated: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol_id": self.symbol_id,
            "focus": self.focus,
            "upstream": self.upstream,
            "downstream": self.downstream,
            "unresolved": self.unresolved,
            "truncated": self.truncated,
        }

    def to_markdown(self) -> str:
        """Render the room as prompt-ready markdown."""
        focus = self.focus
        where = f"{focus.get('file_path', '?')}:{focus.get('start_line', '?')}-{focus.get('end_line', '?')}"
        lines = [
            f"# {self.symbol_id}",
            "",
            f"`{where}` · {focus.get('kind', 'symbol')}",
            "",
            "## Definition",
            "",
            "```python",
            (focus.get("code") or focus.get("stub") or "").rstrip(),
            "```",
            "",
        ]

        lines += self._neighbour_section(
            f"Called by ({len(self.upstream)})",
            self.upstream,
            with_docstring=False,
            empty="Nothing in this codebase calls it.",
        )
        lines += self._neighbour_section(
            f"Calls ({len(self.downstream)})",
            self.downstream,
            with_docstring=True,
            empty="It calls nothing else in this codebase.",
        )

        if self.unresolved:
            lines.append(f"## Unresolved calls ({len(self.unresolved)})")
            lines.append("")
            for item in self.unresolved:
                lines.append(f"- `{item['raw_name']}` (line {item['line']}) — {item['reason']}")
            lines.append("")

        if self.truncated:
            summary = ", ".join(f"{k}: {v} hidden" for k, v in sorted(self.truncated.items()))
            lines.append(f"_Truncated — {summary}._")

        return "\n".join(lines).rstrip() + "\n"

    @staticmethod
    def _neighbour_section(
        title: str, items: Sequence[dict[str, Any]], *, with_docstring: bool, empty: str
    ) -> list[str]:
        lines = [f"## {title}", ""]
        if not items:
            lines += [f"_{empty}_", ""]
            return lines
        for item in items:
            where = f"{item.get('file_path', '?')}:{item.get('start_line', '?')}"
            marker = " *(heuristic)*" if item.get("confidence") == "heuristic" else ""
            lines.append(f"- **`{item['symbol_id']}`** — `{item.get('signature', '')}`{marker}")
            lines.append(f"  <sub>{where}</sub>")
            if with_docstring and item.get("docstring"):
                summary = str(item["docstring"]).strip().splitlines()[0]
                lines.append(f"  > {summary}")
        lines.append("")
        return lines


class GraphBuilder:
    """Assemble a :class:`networkx.DiGraph` from parsed files and resolutions.

    Args:
        parsed_files: Output of the parser.
        index: Output of :meth:`~adventure_call.resolver.SymbolResolver.resolve`.
        include_heuristic: Keep edges resolved by the unique-name fallback.
        module_call_edges: Emit CALLS edges for calls made at module level.
        contains_edges: Also emit CONTAINS edges (module→symbol, class→method).
        external_imports: Create placeholder nodes for third-party imports.
    """

    def __init__(
        self,
        parsed_files: Sequence[ParsedFile],
        index: ResolutionIndex,
        *,
        include_heuristic: bool = True,
        module_call_edges: bool = False,
        contains_edges: bool = False,
        external_imports: bool = False,
    ) -> None:
        self.files = list(parsed_files)
        self.index = index
        self.include_heuristic = include_heuristic
        self.module_call_edges = module_call_edges
        self.contains_edges = contains_edges
        self.external_imports = external_imports
        self.graph: nx.DiGraph = nx.DiGraph()
        self.conflicts: list[str] = []

    # -- construction ------------------------------------------------------

    def build(self) -> nx.DiGraph:
        """Build (or rebuild) and return the graph."""
        self.graph = nx.DiGraph()
        self.conflicts.clear()
        self._add_symbol_nodes()
        self._add_module_nodes()
        self._add_import_edges()
        self._add_call_edges()
        if self.contains_edges:
            self._add_contains_edges()
        return self.graph

    def _add_symbol_nodes(self) -> None:
        for symbol in self.index.symbols.values():
            self.graph.add_node(symbol.symbol_id, **symbol.to_dict(include_code=True))

    def _add_module_nodes(self) -> None:
        for module, parsed in self.index.modules.items():
            if not module:
                continue
            if module in self.graph:
                # A class or function already owns this id; the symbol wins.
                self.conflicts.append(module)
                continue
            stub = f'"""{parsed.module_docstring}"""' if parsed.module_docstring else "..."
            self.graph.add_node(
                module,
                symbol_id=module,
                name=module.rsplit(".", 1)[-1],
                kind="module",
                file_path=parsed.file_path,
                module=module,
                parent=None,
                start_byte=0,
                end_byte=0,
                start_line=1,
                end_line=1,
                params=[],
                signature=f"# module {module}",
                docstring=parsed.module_docstring,
                decorators=[],
                bases=[],
                is_async=False,
                stub=stub,
                code=stub,
            )

    def _add_import_edges(self) -> None:
        for module, aliases in self.index.bindings.items():
            if module not in self.graph:
                continue
            for binding in aliases.values():
                target = binding.target
                if binding.kind == "external":
                    if not self.external_imports:
                        continue
                    target = self._ensure_external_node(target)
                if target not in self.graph or target == module:
                    continue
                self._merge_edge(
                    module,
                    target,
                    IMPORTS,
                    line=binding.record.line,
                    alias=binding.alias,
                    confidence="exact",
                )

    def _ensure_external_node(self, dotted: str) -> str:
        node_id = f"external:{dotted}"
        if node_id not in self.graph:
            self.graph.add_node(
                node_id,
                symbol_id=node_id,
                name=dotted.rsplit(".", 1)[-1],
                kind="external",
                file_path="",
                module=dotted,
                parent=None,
                start_byte=0,
                end_byte=0,
                start_line=0,
                end_line=0,
                params=[],
                signature=f"# external {dotted}",
                docstring=None,
                decorators=[],
                bases=[],
                is_async=False,
                stub="...",
                code="",
            )
        return node_id

    def _add_call_edges(self) -> None:
        for resolution in self.index.resolved:
            if resolution.confidence == "heuristic" and not self.include_heuristic:
                continue
            caller, callee = resolution.caller_id, resolution.callee_id
            if callee is None or caller not in self.graph or callee not in self.graph:
                continue
            if not self.module_call_edges and self.graph.nodes[caller].get("kind") == "module":
                continue
            self._merge_edge(
                caller,
                callee,
                CALLS,
                line=resolution.line,
                confidence=resolution.confidence,
                call_type=resolution.call_type,
                control=resolution.control,
            )

    def _add_contains_edges(self) -> None:
        for symbol in self.index.symbols.values():
            parent = symbol.parent or symbol.module
            if parent and parent in self.graph and parent != symbol.symbol_id:
                self._merge_edge(parent, symbol.symbol_id, CONTAINS, line=symbol.start_line)

    def _merge_edge(
        self,
        source: str,
        target: str,
        edge_type: str,
        *,
        line: int,
        confidence: str = "exact",
        call_type: str | None = None,
        alias: str | None = None,
        control: Sequence[str] | None = None,
    ) -> None:
        """Add an edge, folding repeats into a count plus a line list.

        ``control`` (tic-b47a) is the one thing here that must NOT be folded
        into a set: every other field answers "what is true of this pair",
        while a breadcrumb answers "how was this particular call reached", and
        two sites reaching the same callee differently is exactly the mixed
        case tic-5069 has to detect.  So ``controls`` keeps one entry per call
        site, in the order the sites were resolved, and is parallel to
        ``count`` rather than to the de-duplicated ``lines``.
        """
        data = self.graph.edges.get((source, target))
        if data is None:
            self.graph.add_edge(
                source,
                target,
                type=edge_type,
                types=[edge_type],
                count=1,
                lines=[line],
                confidence=confidence,
                call_types=[call_type] if call_type else [],
                aliases=[alias] if alias else [],
                controls=[list(control)] if control is not None else [],
            )
            return

        data["count"] += 1
        if control is not None:
            data.setdefault("controls", []).append(list(control))
        if line not in data["lines"]:
            data["lines"] = sorted([*data["lines"], line])
        if edge_type not in data["types"]:
            data["types"] = sorted([*data["types"], edge_type])
        if call_type and call_type not in data["call_types"]:
            data["call_types"] = sorted([*data["call_types"], call_type])
        if alias and alias not in data["aliases"]:
            data["aliases"] = sorted([*data["aliases"], alias])
        if _CONFIDENCE_RANK.get(confidence, 0) > _CONFIDENCE_RANK.get(data["confidence"], 0):
            data["confidence"] = confidence

    # -- level of detail ---------------------------------------------------

    def get_room_context(
        self,
        symbol_id: str,
        *,
        edge_types: Iterable[str] = (CALLS,),
        max_neighbors: int | None = None,
        include_unresolved: bool = True,
    ) -> RoomContext:
        """Return the 1-hop LOD context for ``symbol_id``.

        Args:
            symbol_id: Fully qualified id, e.g. ``src.auth.login_user``.
            edge_types: Which relationships count as neighbours.
            max_neighbors: Cap each side; the overflow is reported in
                :attr:`RoomContext.truncated` rather than silently dropped.
            include_unresolved: Attach the symbol's dead-end calls.

        Raises:
            SymbolNotFoundError: No such node, with close-match suggestions.
        """
        if symbol_id not in self.graph:
            raise SymbolNotFoundError(
                symbol_id, difflib.get_close_matches(symbol_id, list(self.graph), n=5, cutoff=0.4)
            )

        wanted = set(edge_types)
        node = self.graph.nodes[symbol_id]

        focus = {
            key: node.get(key)
            for key in (
                "symbol_id",
                "name",
                "kind",
                "file_path",
                "module",
                "parent",
                "start_line",
                "end_line",
                "signature",
                "docstring",
                "decorators",
                "params",
                "code",
            )
        }

        truncated: dict[str, int] = {}
        upstream = self._neighbours(
            symbol_id, wanted, direction="in", with_docstring=False
        )
        downstream = self._neighbours(
            symbol_id, wanted, direction="out", with_docstring=True
        )

        if max_neighbors is not None:
            if len(upstream) > max_neighbors:
                truncated["upstream"] = len(upstream) - max_neighbors
                upstream = upstream[:max_neighbors]
            if len(downstream) > max_neighbors:
                truncated["downstream"] = len(downstream) - max_neighbors
                downstream = downstream[:max_neighbors]

        unresolved = (
            [
                {"raw_name": r.raw_name, "line": r.line, "reason": r.reason or "unresolved"}
                for r in self.index.unresolved_for(symbol_id)
            ]
            if include_unresolved
            else []
        )

        return RoomContext(
            symbol_id=symbol_id,
            focus=focus,
            upstream=upstream,
            downstream=downstream,
            unresolved=unresolved,
            truncated=truncated,
        )

    def _neighbours(
        self, symbol_id: str, wanted: set[str], *, direction: str, with_docstring: bool
    ) -> list[dict[str, Any]]:
        """Signature-level (optionally docstring-level) view of one hop out."""
        pairs = (
            [(other, symbol_id) for other in self.graph.predecessors(symbol_id)]
            if direction == "in"
            else [(symbol_id, other) for other in self.graph.successors(symbol_id)]
        )

        out: list[dict[str, Any]] = []
        for source, target in pairs:
            data = self.graph.edges[source, target]
            if wanted and not wanted.intersection(data.get("types", [data.get("type")])):
                continue
            other = source if direction == "in" else target
            node = self.graph.nodes[other]
            entry: dict[str, Any] = {
                "symbol_id": other,
                "kind": node.get("kind"),
                "signature": node.get("signature"),
                "file_path": node.get("file_path"),
                "start_line": node.get("start_line"),
                "relation": data.get("type"),
                "confidence": data.get("confidence"),
                "call_lines": data.get("lines", []),
            }
            if with_docstring:
                entry["docstring"] = node.get("docstring")
            out.append(entry)

        out.sort(key=lambda item: item["symbol_id"])
        return out


def build_codebase_graph(
    root: Path | str,
    *,
    strip_prefix: str = "",
    exclude_dirs: Iterable[str] = (),
    exclude_globs: Iterable[str] = (),
    max_file_bytes: int | None = None,
    module_prefix: str | None = None,
    **builder_kwargs: Any,
) -> tuple[GraphBuilder, list[ParsedFile], ResolutionIndex]:
    """Run the whole pipeline over ``root`` in one call.

    Returns the builder (with its graph already built), the parsed files and
    the resolution index, so callers can report on diagnostics too.
    """
    from adventure_call.parser import DEFAULT_MAX_FILE_BYTES, CodebaseParser

    parser = CodebaseParser(
        root,
        strip_prefix=strip_prefix,
        exclude_dirs=exclude_dirs,
        exclude_globs=exclude_globs,
        max_file_bytes=max_file_bytes or DEFAULT_MAX_FILE_BYTES,
        module_prefix=module_prefix,
    )
    parsed_files = parser.parse_tree()
    index = SymbolResolver(parsed_files, root=parser.root).resolve()
    builder = GraphBuilder(parsed_files, index, **builder_kwargs)
    builder.build()
    return builder, parsed_files, index
