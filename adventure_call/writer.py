"""JSON exports: the node-link graph and the symbol registry.

Two files, two jobs.  ``codebase_graph.json`` is the shape of the codebase --
stubs only, so it stays small and loads fast.  ``symbol_registry.json`` is the
detail behind it: full metadata, byte ranges, imports, unresolved calls and
every diagnostic the parser raised.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import networkx as nx

from adventure_call.models import ParsedFile
from adventure_call.resolver import ResolutionIndex

SCHEMA_VERSION = 3
GRAPH_FILENAME = "codebase_graph.json"
REGISTRY_FILENAME = "symbol_registry.json"


class OutputWriter:
    """Serialise a built graph and its registry to a directory.

    Args:
        out_dir: Destination directory; created if missing.
        include_source: Keep full function bodies in the registry.  The graph
            export never contains them -- that is what stubs are for.
        indent: JSON indentation; pass ``None`` for the compact form.
    """

    def __init__(
        self,
        out_dir: Path | str,
        *,
        include_source: bool = True,
        indent: int | None = 2,
    ) -> None:
        self.out_dir = Path(out_dir)
        self.include_source = include_source
        self.indent = indent

    # -- public API --------------------------------------------------------

    def write_all(
        self,
        graph: nx.DiGraph,
        index: ResolutionIndex,
        parsed_files: Sequence[ParsedFile],
        *,
        root: Path | str = "",
    ) -> dict[str, Path]:
        """Write both files and return their paths keyed by kind."""
        self.out_dir.mkdir(parents=True, exist_ok=True)
        stats = self.stats(graph, index, parsed_files)
        return {
            "graph": self.write_graph(graph, root=root, stats=stats),
            "registry": self.write_registry(index, parsed_files, root=root, stats=stats),
        }

    def write_graph(
        self,
        graph: nx.DiGraph,
        *,
        root: Path | str = "",
        stats: dict[str, Any] | None = None,
    ) -> Path:
        """Write ``codebase_graph.json`` in NetworkX node-link format.

        The file round-trips through :func:`networkx.node_link_graph`; run
        metadata rides along in the standard ``graph`` attribute dictionary.
        """
        export = nx.DiGraph()
        export.graph.update(
            {
                **graph.graph,
                "schema_version": SCHEMA_VERSION,
                "generated_at": _timestamp(),
                "root": _as_posix(root),
                "root_abs": _as_abs_posix(root),
                "stats": stats or {},
            }
        )
        for node_id, data in graph.nodes(data=True):
            # Stubs only: bodies live in the registry, one lookup away.
            export.add_node(node_id, **{k: v for k, v in data.items() if k != "code"})
        for source, target, data in graph.edges(data=True):
            export.add_edge(source, target, **data)

        payload = nx.node_link_data(export, edges="edges")
        return self._write_json(self.out_dir / GRAPH_FILENAME, payload)

    def write_registry(
        self,
        index: ResolutionIndex,
        parsed_files: Sequence[ParsedFile],
        *,
        root: Path | str = "",
        stats: dict[str, Any] | None = None,
    ) -> Path:
        """Write ``symbol_registry.json`` with the full symbol metadata."""
        payload: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "generated_at": _timestamp(),
            "root": _as_posix(root),
            "root_abs": _as_abs_posix(root),
            "includes_source": self.include_source,
            "stats": stats or {},
            "symbols": {
                symbol_id: symbol.to_dict(include_code=self.include_source)
                for symbol_id, symbol in sorted(index.symbols.items())
            },
            "modules": {
                parsed.module: {
                    "file_path": parsed.file_path,
                    "language": parsed.language,
                    "docstring": parsed.module_docstring,
                    "symbol_ids": [s.symbol_id for s in parsed.symbols],
                    "imports": [i.to_dict() for i in parsed.imports],
                }
                for parsed in sorted(parsed_files, key=lambda p: p.file_path)
            },
            "bindings": {
                module: {alias: binding.to_dict() for alias, binding in sorted(aliases.items())}
                for module, aliases in sorted(index.bindings.items())
            },
            "unresolved_calls": [r.to_dict() for r in index.unresolved],
            "diagnostics": [
                diagnostic.to_dict()
                for parsed in parsed_files
                for diagnostic in parsed.diagnostics
            ],
        }
        return self._write_json(self.out_dir / REGISTRY_FILENAME, payload)

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def stats(
        graph: nx.DiGraph, index: ResolutionIndex, parsed_files: Sequence[ParsedFile]
    ) -> dict[str, Any]:
        """Counts worth printing and worth keeping in both files."""
        edge_types: dict[str, int] = {}
        for _, _, data in graph.edges(data=True):
            edge_types[data.get("type", "?")] = edge_types.get(data.get("type", "?"), 0) + 1

        node_kinds: dict[str, int] = {}
        for _, data in graph.nodes(data=True):
            node_kinds[data.get("kind", "?")] = node_kinds.get(data.get("kind", "?"), 0) + 1

        resolved = index.resolved
        return {
            "files": len(parsed_files),
            "files_with_diagnostics": sum(1 for p in parsed_files if p.diagnostics),
            "symbols": len(index.symbols),
            "nodes": graph.number_of_nodes(),
            "edges": graph.number_of_edges(),
            "node_kinds": dict(sorted(node_kinds.items())),
            "edge_types": dict(sorted(edge_types.items())),
            "calls_resolved": len(resolved),
            "calls_heuristic": sum(1 for r in resolved if r.confidence == "heuristic"),
            "calls_unresolved": len(index.unresolved),
            "calls_builtin": index.builtin_calls,
            "diagnostics": sum(len(p.diagnostics) for p in parsed_files),
        }

    def _write_json(self, path: Path, payload: dict[str, Any]) -> Path:
        """Serialise atomically so a crash cannot leave half a file behind."""
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        )
        temp_path = Path(handle.name)
        try:
            with handle:
                json.dump(payload, handle, indent=self.indent, ensure_ascii=False, default=str)
                handle.write("\n")
            os.replace(temp_path, path)
        except BaseException:
            temp_path.unlink(missing_ok=True)
            raise
        return path


def _timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _as_posix(root: Path | str) -> str:
    return Path(root).as_posix() if root else ""


def _as_abs_posix(root: Path | str) -> str:
    """The analysed root as an absolute, resolved, POSIX-style path (drive
    letter kept on Windows), or ``""`` when no root was given.

    Written alongside the relative ``root`` (tic-7f0b): ``root`` is recorded
    exactly as the caller passed it -- often relative to the generation cwd --
    so ``vscode://`` deep links cannot resolve it.  ``root_abs`` pins the same
    directory in an absolute form the browser (via the dev server) can use
    directly.
    """
    return Path(root).expanduser().resolve().as_posix() if root else ""
