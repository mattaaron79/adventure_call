"""Command line entry point: parse a tree, build the graph, write the JSON."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Sequence

from adventure_call import __version__
from adventure_call.graph import CALLS, CONTAINS, IMPORTS, GraphBuilder, SymbolNotFoundError
from adventure_call.parser import DEFAULT_MAX_FILE_BYTES, CodebaseParser
from adventure_call.resolver import SymbolResolver
from adventure_call.writer import OutputWriter

logger = logging.getLogger("adventure_call")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="adventure-call",
        description="Build a codebase dependency graph with Tree-sitter and NetworkX.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("root", type=Path, help="directory (or single file) to analyse")
    parser.add_argument(
        "-o", "--out-dir", type=Path, default=Path("."), help="where the JSON files are written"
    )
    parser.add_argument(
        "--strip-prefix",
        default="",
        help="path prefix dropped from module names, e.g. 'src'",
    )
    parser.add_argument(
        "--module-prefix",
        default=None,
        metavar="NAME",
        help="prefix for every module id (default: the root's own name when it "
        "is a package; pass an empty string to opt out)",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="GLOB",
        help="skip paths matching this glob (repeatable)",
    )
    parser.add_argument(
        "--exclude-dir",
        action="append",
        default=[],
        metavar="NAME",
        help="prune this directory name during the walk (repeatable)",
    )
    parser.add_argument(
        "--max-file-bytes",
        type=int,
        default=DEFAULT_MAX_FILE_BYTES,
        help="skip files larger than this",
    )
    parser.add_argument(
        "--no-source",
        action="store_true",
        help="omit full function bodies from symbol_registry.json",
    )
    parser.add_argument(
        "--no-heuristic",
        action="store_true",
        help="drop CALLS edges that rely on the unique-name fallback",
    )
    parser.add_argument(
        "--module-calls",
        action="store_true",
        help="also emit CALLS edges for calls made at module level",
    )
    parser.add_argument(
        "--contains-edges",
        action="store_true",
        help="also emit CONTAINS edges (module to symbol, class to method)",
    )
    parser.add_argument(
        "--external-imports",
        action="store_true",
        help="include placeholder nodes for third-party imports",
    )
    parser.add_argument("--no-write", action="store_true", help="analyse without writing files")
    parser.add_argument(
        "--room",
        metavar="SYMBOL_ID",
        help="print the 1-hop LOD context for a symbol, e.g. src.auth.login_user",
    )
    parser.add_argument(
        "--room-edges",
        default=CALLS,
        help=f"edge types a room follows, comma separated ({CALLS},{IMPORTS},{CONTAINS})",
    )
    parser.add_argument(
        "--max-neighbors", type=int, default=None, help="cap each side of a room"
    )
    parser.add_argument(
        "--format", choices=("md", "json"), default="md", help="room output format"
    )
    parser.add_argument("-q", "--quiet", action="store_true", help="only print errors")
    parser.add_argument("-v", "--verbose", action="store_true", help="log every skipped file")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the pipeline.  Returns a process exit code."""
    args = build_arg_parser().parse_args(argv)
    _configure_output(args)

    if not args.root.exists():
        logger.error("no such path: %s", args.root)
        return 2

    parser = CodebaseParser(
        args.root,
        strip_prefix=args.strip_prefix,
        module_prefix=args.module_prefix,
        exclude_dirs=args.exclude_dir,
        exclude_globs=args.exclude,
        max_file_bytes=args.max_file_bytes,
    )
    parsed_files = parser.parse_tree()
    if not parsed_files:
        logger.error("found no parseable source files under %s", args.root)
        return 1

    index = SymbolResolver(parsed_files, root=args.root).resolve()
    builder = GraphBuilder(
        parsed_files,
        index,
        include_heuristic=not args.no_heuristic,
        module_call_edges=args.module_calls,
        contains_edges=args.contains_edges,
        external_imports=args.external_imports,
    )
    graph = builder.build()

    writer = OutputWriter(args.out_dir, include_source=not args.no_source)
    stats = writer.stats(graph, index, parsed_files)

    if not args.no_write:
        written = writer.write_all(graph, index, parsed_files, root=args.root)
        for kind, path in written.items():
            logger.info("wrote %s -> %s", kind, path)

    _report(stats, parsed_files, builder, verbose=args.verbose)

    if args.room:
        try:
            room = builder.get_room_context(
                args.room,
                edge_types=[e.strip() for e in args.room_edges.split(",") if e.strip()],
                max_neighbors=args.max_neighbors,
            )
        except SymbolNotFoundError as exc:
            logger.error("%s", exc)
            return 1
        print()
        if args.format == "json":
            print(json.dumps(room.to_dict(), indent=2, ensure_ascii=False))
        else:
            print(room.to_markdown())

    return 0


def _configure_output(args: argparse.Namespace) -> None:
    """Quiet, readable logging -- and a stdout that survives odd code pages."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:  # pragma: no branch - always present on 3.7+
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):  # pragma: no cover - exotic streams
                pass

    level = logging.ERROR if args.quiet else (logging.DEBUG if args.verbose else logging.INFO)
    logging.basicConfig(level=level, format="%(message)s", stream=sys.stderr)


def _report(stats: dict, parsed_files: Sequence, builder: GraphBuilder, *, verbose: bool) -> None:
    logger.info(
        "%(files)s files -> %(symbols)s symbols, %(nodes)s nodes, %(edges)s edges", stats
    )
    logger.info(
        "  edges: %s",
        ", ".join(f"{k} {v}" for k, v in stats["edge_types"].items()) or "none",
    )
    logger.info(
        "  calls: %s resolved (%s heuristic), %s unresolved, %s builtin",
        stats["calls_resolved"],
        stats["calls_heuristic"],
        stats["calls_unresolved"],
        stats["calls_builtin"],
    )
    if stats["diagnostics"]:
        logger.info(
            "  diagnostics: %s across %s files (see symbol_registry.json)",
            stats["diagnostics"],
            stats["files_with_diagnostics"],
        )
    if builder.conflicts:
        logger.info("  id conflicts (symbol shadows module): %s", ", ".join(builder.conflicts))
    if verbose:
        for parsed in parsed_files:
            for diagnostic in parsed.diagnostics:
                logger.debug(
                    "    %s:%s %s: %s",
                    diagnostic.file_path,
                    diagnostic.line,
                    diagnostic.kind,
                    diagnostic.detail,
                )


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
