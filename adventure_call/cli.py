"""Command line entry point.

Three kinds of command:

* ``analyze ROOT`` -- the original one-shot pipeline (also reached by the bare
  ``adventure-call ROOT ...`` form, kept for compatibility).
* ``init`` / ``update`` -- keep a ``.adventure-call/`` store beside a project
  (tic-49da).
* query commands -- read the store and print compact JSON for agents
  (tic-34c1).  See :mod:`adventure_call.query` for what each one computes.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import textwrap
from pathlib import Path
from typing import Any, Callable, Sequence

from adventure_call import __version__
from adventure_call.graph import CALLS, CONTAINS, IMPORTS, SymbolNotFoundError
from adventure_call.parser import DEFAULT_MAX_FILE_BYTES
from adventure_call.query import CLOSURE_BUDGET, CONE_BUDGET, QueryError, Workspace
from adventure_call.store import STORE_DIRNAME, AnalysisOptions, Store, StoreError, analyse

logger = logging.getLogger("adventure_call")

PROG = "adventure-call"

#: Exit codes, shared by every command (documented in AGENTS.md).
EXIT_OK, EXIT_ERROR, EXIT_NOT_FOUND, EXIT_NO_STORE = 0, 1, 2, 3



class _Formatter(argparse.RawDescriptionHelpFormatter):
    """Wrap long prose lines; leave hand-laid lines (examples, tables) alone."""

    def _fill_text(self, text: str, width: int, indent: str) -> str:
        lines = []
        for line in text.splitlines():
            if len(line) > width and not line.startswith(" "):
                lines.append(textwrap.fill(line, width, initial_indent=indent, subsequent_indent=indent))
            else:
                lines.append(indent + line)
        return "\n".join(lines)


_RAW = _Formatter

_TOP_DESCRIPTION = """\
Static dependency graph of a Python codebase (Tree-sitter + NetworkX), with
JSON queries over it for agents.

Start at a project root:
  adventure-call init                  analyse the project into .adventure-call/
  adventure-call overview              one-shot map of the codebase (JSON)
  adventure-call guide                 how to use the query commands

Query commands find .adventure-call/ by walking up from the current directory,
refresh it automatically when sources changed, and print compact JSON.
Run 'adventure-call COMMAND -h' for each command's options."""

_TOP_EPILOG = """\
exit codes: 0 ok, 1 error / ambiguous id, 2 not found, 3 no .adventure-call/ store

compatibility: 'adventure-call ROOT [options]' still works and means 'analyze ROOT'."""

_ID_HELP = (
    "a symbol id (pkg.mod.Class.method), a unique suffix or bare name (Class.method, "
    "method), a file path (src/x.py), or path:LINE for the innermost symbol on that line"
)


# -- parser ---------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG, description=_TOP_DESCRIPTION, epilog=_TOP_EPILOG, formatter_class=_RAW
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="COMMAND", title="commands")

    # Shared option groups -------------------------------------------------

    analysis = argparse.ArgumentParser(add_help=False)
    group = analysis.add_argument_group("analysis options")
    group.add_argument("--strip-prefix", default=None, metavar="PATH",
                       help="path prefix dropped from module names, e.g. 'src' (default: none)")
    group.add_argument("--module-prefix", default=None, metavar="NAME",
                       help="prefix for every module id (default: the root's own name when it is a "
                       "package; pass '' to opt out)")
    group.add_argument("--exclude", action="append", default=None, metavar="GLOB",
                       help="skip paths matching this glob (repeatable)")
    group.add_argument("--exclude-dir", action="append", default=None, metavar="NAME",
                       help="prune this directory name during the walk (repeatable; .git, .venv, "
                       "node_modules, build, dist and similar are always pruned)")
    group.add_argument("--max-file-bytes", type=int, default=None, metavar="N",
                       help=f"skip files larger than N bytes (default: {DEFAULT_MAX_FILE_BYTES})")
    group.add_argument("--no-source", action="store_true", default=None,
                       help="omit full function bodies from symbol_registry.json")
    group.add_argument("--no-heuristic", action="store_true", default=None,
                       help="drop CALLS edges that rely on the unique-name fallback")
    group.add_argument("--module-calls", action="store_true", default=None,
                       help="also emit CALLS edges for calls made at module level")
    group.add_argument("--contains-edges", action="store_true", default=None,
                       help="also emit CONTAINS edges (module to symbol, class to method)")
    group.add_argument("--external-imports", action="store_true", default=None,
                       help="include placeholder nodes for third-party imports")

    logging_opts = argparse.ArgumentParser(add_help=False)
    logging_opts.add_argument("-q", "--quiet", action="store_true", help="only print errors")
    logging_opts.add_argument("-v", "--verbose", action="store_true", help="log every parse diagnostic")

    query = argparse.ArgumentParser(add_help=False)
    group = query.add_argument_group("store options")
    group.add_argument("--store", type=Path, metavar="DIR",
                       help=f"use this {STORE_DIRNAME}/ (or the project root holding one) instead of "
                       "searching upward from the current directory")
    group.add_argument("--no-refresh", action="store_true",
                       help="do not re-analyse when sources changed since the last update; a "
                       "warning is printed to stderr instead")
    group.add_argument("--pretty", action="store_true", help="indent the JSON output")

    # analyze ----------------------------------------------------------------

    p = sub.add_parser(
        "analyze", parents=[analysis, logging_opts], formatter_class=_RAW,
        help="one-shot analysis of ROOT into --out-dir (no store)",
        description="Analyse ROOT and write codebase_graph.json and symbol_registry.json to "
        "--out-dir. Used by the web viewer (which reads ./out). For agent use prefer 'init'.",
        epilog="examples:\n  adventure-call analyze ../project -o out\n"
        "  adventure-call analyze . --no-write --room pkg.mod.func",
    )
    p.add_argument("root", type=Path, help="directory (or single file) to analyse")
    p.add_argument("-o", "--out-dir", type=Path,
                   help="where the JSON files are written (default: .)")
    p.add_argument("--no-write", action="store_true", help="analyse without writing files")
    p.add_argument("--room", metavar="SYMBOL_ID",
                   help="print the 1-hop context for a symbol: full code, callers, callees")
    p.add_argument("--room-edges", default=CALLS,
                   help=f"edge types a room follows, comma separated ({CALLS},{IMPORTS},{CONTAINS}); "
                   f"default {CALLS}")
    p.add_argument("--max-neighbors", type=int, default=None, help="cap each side of a room")
    p.add_argument("--format", choices=("md", "json"), default="md", help="room output format")
    p.set_defaults(handler=cmd_analyze)

    # init / update / guide --------------------------------------------------

    p = sub.add_parser(
        "init", parents=[analysis, logging_opts], formatter_class=_RAW,
        help=f"create {STORE_DIRNAME}/ at the project root and analyse",
        description=f"Create ROOT/{STORE_DIRNAME}/ holding config.json (the analysis options "
        "given here), the analysis JSON, a manifest for staleness checks, a .gitignore for the "
        "generated files, and AGENTS.md describing how an agent uses the query commands. "
        "Then run the first analysis.\n\nPrints a one-line JSON summary on stdout.",
        epilog="examples:\n  adventure-call init\n  adventure-call init ~/code/app --strip-prefix src "
        "--exclude-dir fixtures\n\nTo let agents discover it, add a line such as\n"
        f"  'Code navigation: read {STORE_DIRNAME}/AGENTS.md'\nto the project's CLAUDE.md or AGENTS.md.",
    )
    p.add_argument("root", type=Path, nargs="?",
                   help="project root (default: the enclosing git work tree, else the current "
                   "directory)")
    p.add_argument("--force", action="store_true",
                   help="re-initialise an existing store, replacing its saved options")
    p.set_defaults(handler=cmd_init)

    p = sub.add_parser(
        "update", parents=[analysis, logging_opts], formatter_class=_RAW,
        help="re-run the analysis with the store's saved options",
        description=f"Find the nearest {STORE_DIRNAME}/ above the current directory (or --store) "
        "and re-analyse the project with its saved options. Any analysis option given here "
        "replaces the saved value and is saved. AGENTS.md is regenerated.\n\n"
        "Query commands already refresh automatically when sources change, so running this by "
        "hand is only needed after changing options or with --no-refresh.",
        epilog="examples:\n  adventure-call update\n  adventure-call update --exclude-dir generated",
    )
    p.add_argument("--store", type=Path, metavar="DIR", help=f"the {STORE_DIRNAME}/ to update")
    p.add_argument("--if-stale", action="store_true",
                   help="only re-analyse when sources changed since the last update")
    p.set_defaults(handler=cmd_update)

    p = sub.add_parser(
        "guide", formatter_class=_RAW, help="print the agent guide (AGENTS.md) to stdout",
        description="Print the agent guide that init writes to .adventure-call/AGENTS.md.",
    )
    p.set_defaults(handler=cmd_guide)

    # queries ----------------------------------------------------------------

    def query_parser(name: str, help_: str, description: str, epilog: str) -> argparse.ArgumentParser:
        qp = sub.add_parser(name, parents=[query], formatter_class=_RAW, help=help_,
                            description=description, epilog=epilog)
        return qp

    p = query_parser(
        "overview", "one-shot map: counts, top dirs, entry points, hubs, cycles",
        "A codebase map for an agent arriving cold: counts, top-level directories by symbol "
        "count, the most far-reaching entry points, the most-called and most complex callables, "
        "the most-imported files, import cycles and the possibly-unused count.",
        "example:\n  adventure-call overview --limit 5",
    )
    p.add_argument("--limit", type=int, default=10, help="rows per list (default: 10)")
    p.set_defaults(handler=_query(lambda ws, a: ws.overview(limit=a.limit)))

    p = query_parser(
        "find", "search symbols and files by name",
        "Case-insensitive substring search over symbol ids, names and file paths. Exact name "
        "matches rank first. Each match is 'ID KIND path:line'.",
        "examples:\n  adventure-call find login\n  adventure-call find '^get_' --regex --kind "
        "function,method",
    )
    p.add_argument("pattern", help="text to look for")
    p.add_argument("--kind", metavar="KINDS",
                   help="comma-separated kinds: module,class,function,method,variable,attribute")
    p.add_argument("-r", "--regex", action="store_true", help="treat PATTERN as a regular expression")
    p.add_argument("--limit", type=int, default=30, help="most matches to print (default: 30)")
    p.set_defaults(handler=_query(lambda ws, a: ws.find(a.pattern, kind=a.kind, regex=a.regex, limit=a.limit)))

    p = query_parser(
        "refs", "syntactic occurrences of an attribute, identifier or string",
        "Structured grep over current analysed files. Attribute matches are name-based, not type-checked; "
        "an 'exact' marker means an existing READS/WRITES edge confirms it. Use impact for known graph callers.",
        "examples:\n  adventure-call refs FIELD --kind attr\n  adventure-call refs login --kind string --match substring",
    )
    p.add_argument("name", help="attribute, identifier, or string text to find")
    p.add_argument("--kind", default="all", help="comma-separated: attr,name,string,all (default: all)")
    p.add_argument("--match", choices=("exact", "substring", "regex"), default="exact",
                   help="how NAME matches (default: exact)")
    p.add_argument("--path", help="glob restricting files, e.g. 'src/**/*.py'")
    p.add_argument("--limit", type=int, default=100, help="most hits to return (default: 100)")
    p.set_defaults(handler=_query(lambda ws, a: ws.refs(a.name, kinds=a.kind, match=a.match, path=a.path, limit=a.limit)))

    p = query_parser(
        "symbol", "one symbol: signature, doc, role, metrics, callers, callees, state",
        "Everything known about one symbol, one hop out: location, signature, first docstring "
        "paragraph, decorators, role (how execution reaches it), metrics (fan in/out, transitive "
        "reach down/up, complexity), callers (pointing at the call site), callees, references, "
        "variables read and written, effects (filesystem/network/process/env/console/"
        "nondeterminism, transitive), external and unresolved calls. A file path gives the "
        "'file' view instead.",
        "examples:\n  adventure-call symbol auth.login_user\n  adventure-call symbol src/api.py:42 --code",
    )
    p.add_argument("id", help=_ID_HELP)
    p.add_argument("--code", action="store_true", help="include the symbol's source")
    p.add_argument("--full-doc", action="store_true", help="the whole docstring, not its first paragraph")
    p.add_argument("--limit", type=int, default=25, help="most entries per list (default: 25)")
    p.set_defaults(handler=cmd_symbol)

    p = query_parser(
        "file", "one file: importers, imports, externals, outline",
        "A file's detail view: which files import it, which in-project files and symbols it "
        "imports, its external imports, an outline of its definitions ('L<start>-<end> "
        "<signature>', class members indented) and the import cycle it sits in, if any.",
        "examples:\n  adventure-call file src/api.py\n  adventure-call file src/api.py --kind method --outline-only",
    )
    p.add_argument("path", help="file path, or any symbol id inside the file")
    p.add_argument("--kind", help="comma-separated outline kinds: class,function,method,variable,attribute")
    p.add_argument("--match", help="case-insensitive substring filter for outline labels")
    p.add_argument("--outline-only", action="store_true", help="omit imports, importers and external imports")
    p.add_argument("--limit", type=int, default=60, help="most entries per list (default: 60)")
    p.set_defaults(handler=_query(lambda ws, a: ws.file(a.path, kind=a.kind, match=a.match, outline_only=a.outline_only, limit=a.limit)))

    p = query_parser(
        "tree", "directory tree sized by symbols, lines or files",
        "The directory tree (the fs-tree and sunburst views). Directories end in '/' and carry "
        "'_total'; files map to their size. Directories deeper than --depth collapse to their "
        "total.",
        "examples:\n  adventure-call tree --depth 1\n  adventure-call tree src/pkg --metric lines",
    )
    p.add_argument("dir", nargs="?", default="", help="subdirectory to root the tree at (default: project root)")
    p.add_argument("--depth", type=int, default=2, help="directory levels to expand (default: 2)")
    p.add_argument("--metric", choices=("symbols", "lines", "files"), default="symbols",
                   help="what a file's size counts (default: symbols)")
    p.set_defaults(handler=_query(lambda ws, a: ws.tree(a.dir, depth=a.depth, metric=a.metric)))

    p = query_parser(
        "imports", "file import graph: whole, or local view around one file",
        "The import graph (file -> file). With FILE: its local view -- files within --depth "
        "import hops, as 'imports' (what it depends on) and 'imported_by' (what depends on it), "
        "each mapped to its hop count, plus every import edge between the files shown and any "
        "import cycles touching them. Without FILE: every edge and every cycle.",
        "examples:\n  adventure-call imports src/api.py --depth 2\n  adventure-call imports "
        "src/api.py --direction in\n  adventure-call imports --cycles",
    )
    p.add_argument("file", nargs="?", help="centre file (path or any symbol inside it)")
    p.add_argument("--depth", type=int, default=1, help="import hops from the centre (default: 1)")
    p.add_argument("--direction", choices=("in", "out", "both"), default="both",
                   help="out = what it imports, in = what imports it (default: both)")
    p.add_argument("--symbols", action="store_true", help="append the imported names to each edge")
    p.add_argument("--cycles", action="store_true", help="whole graph: print only the import cycles")
    p.add_argument("--limit", type=int, default=400, help="most edges to print (default: 400)")
    p.set_defaults(handler=_query(_imports))

    p = query_parser(
        "calls", "call-flow cone from a symbol: what it reaches / what reaches it",
        "The rooted call-flow view. 'nodes' maps each symbol to '<hop> path:line': +N is N calls "
        "below the root (it calls them), -N is N calls above (they call it). 'edges' lists every "
        "call between the nodes shown. Mutual-recursion knots are listed in 'cycles'. The walk "
        "grows by whole levels and stops before exceeding --budget call components; 'truncated' "
        "and 'beyond' (count just outside the view) say what was left out.",
        "examples:\n  adventure-call calls api.handle_login --depth 3\n  adventure-call calls "
        "models.make_user --direction up",
    )
    p.add_argument("id", help=_ID_HELP)
    p.add_argument("--depth", type=int, default=2, help="call hops in each direction (default: 2)")
    p.add_argument("--direction", choices=("down", "up", "both"), default="down",
                   help="down = callees, up = callers (default: down)")
    p.add_argument("--externals", action="store_true", help="add the external modules each node calls")
    p.add_argument("--budget", type=int, default=CONE_BUDGET,
                   help=f"most call components to include (default: {CONE_BUDGET})")
    p.set_defaults(handler=_query(lambda ws, a: ws.calls(a.id, depth=a.depth, direction=a.direction, externals=a.externals, budget=a.budget)))

    p = query_parser(
        "entries", "where execution enters: entry points ranked by reach",
        "Entry points -- callables nothing in the project calls -- ranked by how much they "
        "transitively reach. Each row is 'ID path:line reach=N ROLE'. ROLE is 'entry' (no known "
        "caller), 'framework-entry: <evidence>' (a test, route, CLI command, dunder, property...) "
        "or 'referenced: named by X' (passed somewhere as a value). Test files are hidden unless "
        "--include-tests.",
        "example:\n  adventure-call entries --limit 10",
    )
    p.add_argument("--limit", type=int, default=20, help="rows to print (default: 20)")
    p.add_argument("--include-tests", action="store_true", help="include entry points in test files")
    p.set_defaults(handler=_query(lambda ws, a: ws.entries(limit=a.limit, include_tests=a.include_tests)))

    p = query_parser(
        "impact", "what is affected if this changes (callers / readers / importers)",
        "The blast radius of a change. For a function or method: direct callers (at the call "
        "site) and transitive callers. For a class: the same over the class and its methods. For "
        "a variable or attribute: readers, writers, and everything reaching them via calls. For a "
        "file: importers by hop count. 'files' and 'test_files' summarise where to look and which "
        "tests to run. Transitive sets are counts unless --all. A lower bound: unresolved and dynamic calls are invisible.",
        "examples:\n  adventure-call impact auth.login_user\n  adventure-call impact src/models.py",
    )
    p.add_argument("id", help=_ID_HELP)
    p.add_argument("--budget", type=int, default=CLOSURE_BUDGET,
                   help=f"most symbols or files to collect (default: {CLOSURE_BUDGET})")
    p.add_argument("--all", action="store_true", help="list transitive callers/readers instead of counting them")
    p.set_defaults(handler=_query(lambda ws, a: ws.impact(a.id, budget=a.budget, full=a.all)))

    p = query_parser(
        "state", "module/class state a function touches, directly and through calls",
        "Variables and attributes a callable reads and writes itself, and those touched by "
        "everything it transitively calls ('through_calls', grouped by owning class or module, "
        "each 'name:r|w|rw').",
        "example:\n  adventure-call state api.handle_login",
    )
    p.add_argument("id", help=_ID_HELP)
    p.add_argument("--budget", type=int, default=CLOSURE_BUDGET,
                   help=f"most callees to walk (default: {CLOSURE_BUDGET})")
    p.set_defaults(handler=_query(lambda ws, a: ws.state(a.id, budget=a.budget)))

    p = query_parser(
        "orphans", "callables with no callers, callees or framework role",
        "Callables nothing calls, that call nothing, and that no framework rule or reference "
        "explains. POSSIBLY unused -- dynamic dispatch is invisible to static analysis.",
        "example:\n  adventure-call orphans --limit 50",
    )
    p.add_argument("--limit", type=int, default=100, help="rows to print (default: 100)")
    p.add_argument("--include-tests", action="store_true", help="include test files")
    p.set_defaults(handler=_query(lambda ws, a: ws.orphans(include_tests=a.include_tests, limit=a.limit)))

    p = query_parser(
        "source", "print symbols' source as plain text",
        "Print the source of one or more symbols, each under a '# ID path:start-end' header. "
        "Plain text, not JSON: cheaper than escaped code. Read from disk, so it is current.",
        "example:\n  adventure-call source auth.login_user models.User.greet",
    )
    p.add_argument("ids", nargs="+", metavar="id", help=_ID_HELP)
    p.set_defaults(handler=cmd_source)

    return parser


# -- entry ----------------------------------------------------------------------

_COMMANDS = frozenset({
    "analyze", "init", "update", "guide", "overview", "find", "refs", "symbol", "file", "tree",
    "imports", "calls", "entries", "impact", "state", "orphans", "source",
})


def main(argv: Sequence[str] | None = None) -> int:
    """Run the CLI.  Returns a process exit code."""
    argv = list(sys.argv[1:] if argv is None else argv)
    _reconfigure_streams()
    # The pre-subcommand form, `adventure-call ROOT [options]`.
    if argv and not argv[0].startswith("-") and argv[0] not in _COMMANDS:
        argv.insert(0, "analyze")
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "handler", None):
        parser.print_help()
        return EXIT_OK
    _configure_logging(args)
    return args.handler(args)


# -- analysis commands ------------------------------------------------------------


def _options_from_args(args: argparse.Namespace, base: AnalysisOptions | None = None) -> AnalysisOptions:
    """Saved options overlaid with whatever was given on the command line."""
    options = base or AnalysisOptions()
    for key in AnalysisOptions.__dataclass_fields__:
        value = getattr(args, key, None)
        if value is not None:
            setattr(options, key, value)
    return options


def cmd_analyze(args: argparse.Namespace) -> int:
    if not args.root.exists():
        logger.error("no such path: %s", args.root)
        return EXIT_NOT_FOUND
    # Stores default to module calls; preserve analyze's compact web-graph
    # default unless the caller explicitly asks for them.
    out_dir = args.out_dir or Path(".")
    result = analyse(
        args.root,
        _options_from_args(args, AnalysisOptions(module_calls=False)),
        None if args.no_write else out_dir,
    )
    if result is None:
        logger.error("found no parseable source files under %s", args.root)
        return EXIT_ERROR
    for kind, path in result.written.items():
        logger.info("wrote %s -> %s", kind, path)
    if args.out_dir is None and (args.root / STORE_DIRNAME).is_dir():
        logger.warning("queries use %s/ and refresh automatically; you probably want vcall update", STORE_DIRNAME)
    _report(result, verbose=args.verbose)

    if args.room:
        try:
            room = result.builder.get_room_context(
                args.room,
                edge_types=[e.strip() for e in args.room_edges.split(",") if e.strip()],
                max_neighbors=args.max_neighbors,
            )
        except SymbolNotFoundError as exc:
            logger.error("%s", exc)
            return EXIT_ERROR
        print()
        if args.format == "json":
            print(json.dumps(room.to_dict(), indent=2, ensure_ascii=False))
        else:
            print(room.to_markdown())
    return EXIT_OK


def cmd_init(args: argparse.Namespace) -> int:
    root = (args.root.expanduser().resolve() if args.root else Store.default_root())
    if not root.is_dir():
        logger.error("not a directory: %s", root)
        return EXIT_NOT_FOUND
    store = Store(root / STORE_DIRNAME)
    if store.exists() and not args.force:
        logger.error("%s already exists; run 'adventure-call update' (or 'init --force' to reset "
                     "its options)", store.path)
        return EXIT_ERROR
    options = _options_from_args(args)
    store.save_options(options)
    return _run_update(store, options, args, created=True)


def cmd_update(args: argparse.Namespace) -> int:
    try:
        store = _find_store(args.store)
    except StoreError as exc:
        logger.error("%s", exc)
        return EXIT_NO_STORE
    if args.if_stale and not store.staleness():
        _emit({"store": str(store.path), "current": True}, pretty=False)
        return EXIT_OK
    options = _options_from_args(args, store.load_options())
    store.save_options(options)
    return _run_update(store, options, args, created=False)


def _run_update(store: Store, options: AnalysisOptions, args: argparse.Namespace, *, created: bool) -> int:
    result = store.update(options)
    if result is None:
        logger.error("found no parseable source files under %s", store.root)
        return EXIT_ERROR
    _report(result, verbose=args.verbose)
    summary = {
        "store": str(store.path),
        "files": result.stats["files"],
        "symbols": result.stats["symbols"],
        "seconds": round(result.seconds, 2),
    }
    if created:
        summary["next"] = f"point agents at {STORE_DIRNAME}/AGENTS.md from CLAUDE.md or AGENTS.md"
    _emit(summary, pretty=False)
    return EXIT_OK


def cmd_guide(args: argparse.Namespace) -> int:
    from adventure_call.agents_doc import render_agents_md

    sys.stdout.write(render_agents_md())
    return EXIT_OK


# -- query commands ---------------------------------------------------------------


def _find_store(given: Path | None) -> Store:
    if given is None:
        return Store.find()
    given = given.expanduser().resolve()
    if given.name != STORE_DIRNAME and (given / STORE_DIRNAME).is_dir():
        given = given / STORE_DIRNAME
    store = Store(given)
    if not store.exists():
        raise StoreError(f"{given} is not an {STORE_DIRNAME}/ store")
    return store


def _open_workspace(args: argparse.Namespace) -> Workspace:
    store = _find_store(args.store)
    changes = store.staleness()
    if changes:
        counts = ", ".join(f"{len(v)} {k}" for k, v in changes.items())
        if args.no_refresh:
            logger.warning("adventure-call: analysis is stale (%s); run 'adventure-call update'", counts)
        else:
            logger.warning("adventure-call: sources changed (%s); re-analysing...", counts)
            if store.update() is None:
                raise StoreError(f"no parseable source files under {store.root}")
    return Workspace.load(store.path)


def _query(run: Callable[[Workspace, argparse.Namespace], Any]) -> Callable[[argparse.Namespace], int]:
    def handler(args: argparse.Namespace) -> int:
        try:
            ws = _open_workspace(args)
        except StoreError as exc:
            _emit({"error": str(exc)}, pretty=args.pretty)
            return EXIT_NO_STORE
        except QueryError as exc:
            _emit(exc.payload, pretty=args.pretty)
            return exc.exit_code
        try:
            _emit(run(ws, args), pretty=args.pretty)
        except QueryError as exc:
            _emit(exc.payload, pretty=args.pretty)
            return exc.exit_code
        return EXIT_OK

    return handler


def cmd_symbol(args: argparse.Namespace) -> int:
    """Emit symbol metadata, appending its source as readable text on request."""
    try:
        ws = _open_workspace(args)
        payload = ws.symbol(args.id, code=args.code, full_doc=args.full_doc, limit=args.limit)
    except StoreError as exc:
        _emit({"error": str(exc)}, pretty=args.pretty)
        return EXIT_NO_STORE
    except QueryError as exc:
        _emit(exc.payload, pretty=args.pretty)
        return exc.exit_code
    source = payload.pop("code", None) if args.code else None
    _emit(payload, pretty=args.pretty)
    if source is not None:
        sys.stdout.write(f"\n# {payload['id']} {payload['at']}\n{source.rstrip()}\n")
    return EXIT_OK


def _imports(ws: Workspace, args: argparse.Namespace) -> dict[str, Any]:
    if args.cycles and not args.file:
        return {"cycles": ws.import_cycles}
    return ws.imports(args.file, depth=args.depth, direction=args.direction, symbols=args.symbols, limit=args.limit)


def cmd_source(args: argparse.Namespace) -> int:
    try:
        ws = _open_workspace(args)
        blocks = []
        for ref in args.ids:
            node_id = ws.resolve(ref)
            blocks.append(f"# {node_id} {ws.loc(node_id, span=True)}\n{ws.source_of(node_id).rstrip()}\n")
    except StoreError as exc:
        _emit({"error": str(exc)}, pretty=False)
        return EXIT_NO_STORE
    except QueryError as exc:
        _emit(exc.payload, pretty=False)
        return exc.exit_code
    sys.stdout.write("\n".join(blocks))
    return EXIT_OK


# -- output -----------------------------------------------------------------------


def _emit(payload: Any, *, pretty: bool) -> None:
    if pretty:
        text = json.dumps(payload, indent=2, ensure_ascii=False)
    else:
        text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    sys.stdout.write(text + "\n")


def _reconfigure_streams() -> None:
    """A stdout that survives odd code pages (Windows consoles)."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):  # pragma: no cover - exotic streams
                pass


def _configure_logging(args: argparse.Namespace) -> None:
    if getattr(args, "quiet", False):
        level = logging.ERROR
    elif getattr(args, "verbose", False):
        level = logging.DEBUG
    elif args.command in ("analyze", "init", "update"):
        level = logging.INFO
    else:
        level = logging.WARNING  # queries: stdout is the JSON, stderr stays quiet
    logging.basicConfig(level=level, format="%(message)s", stream=sys.stderr, force=True)


def _report(result: Any, *, verbose: bool) -> None:
    stats = result.stats
    logger.info("%(files)s files -> %(symbols)s symbols, %(nodes)s nodes, %(edges)s edges", stats)
    logger.info("  edges: %s", ", ".join(f"{k} {v}" for k, v in stats["edge_types"].items()) or "none")
    logger.info(
        "  calls: %s resolved (%s heuristic), %s unresolved, %s builtin",
        stats["calls_resolved"], stats["calls_heuristic"], stats["calls_unresolved"], stats["calls_builtin"],
    )
    if stats["diagnostics"]:
        logger.info("  diagnostics: %s across %s files (see symbol_registry.json)",
                    stats["diagnostics"], stats["files_with_diagnostics"])
    if result.builder.conflicts:
        logger.info("  id conflicts (symbol shadows module): %s", ", ".join(result.builder.conflicts))
    if verbose:
        for parsed in result.parsed_files:
            for diagnostic in parsed.diagnostics:
                logger.debug("    %s:%s %s: %s", diagnostic.file_path, diagnostic.line,
                             diagnostic.kind, diagnostic.detail)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
