"""Tree-sitter driven extraction of definitions, imports and call sites.

The parser never raises on bad input.  Anything it cannot make sense of -- an
unreadable file, a binary blob, a syntax error, an unresolvable callee -- turns
into a :class:`~adventure_call.models.ParseDiagnostic` attached to the file, and
the walk continues.  Tree-sitter's error recovery means a file with a syntax
error still yields every definition that parsed cleanly around the damage.
"""

from __future__ import annotations

import ast
import fnmatch
import inspect
import logging
import os
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Iterable, Iterator, Sequence

from tree_sitter import Node, QueryCursor

from adventure_call.languages import (
    GrammarUnavailable,
    LanguageSpec,
    load_language,
    module_name_for_path,
    spec_for_path,
)
from adventure_call.models import (
    LITERAL_TYPES,
    CallSite,
    ImportRecord,
    LocalBinding,
    Param,
    ParseDiagnostic,
    ParsedFile,
    Reference,
    SymbolDef,
)

logger = logging.getLogger(__name__)


def _normalise_newlines(text: str) -> str:
    """CRLF and CR sources become LF so downstream text handling stays simple."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _dedent(text: str) -> str:
    """Strip the common leading indentation from ``text``.

    :func:`textwrap.dedent` is not used because it treats a line holding only a
    stray carriage return as unindented content, which silently defeats it on
    CRLF sources.
    """
    lines = text.splitlines(keepends=True)
    margin: str | None = None
    for line in lines:
        content = line.rstrip("\r\n")
        if not content.strip():
            continue
        indent = content[: len(content) - len(content.lstrip(" \t"))]
        if margin is None:
            margin = indent
        else:
            shared = 0
            while shared < min(len(margin), len(indent)) and margin[shared] == indent[shared]:
                shared += 1
            margin = margin[:shared]
        if not margin:
            return text
    if not margin:
        return text
    return "".join(line[len(margin) :] if line.startswith(margin) else line for line in lines)


DEFAULT_EXCLUDE_DIRS: frozenset[str] = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".venv",
        "venv",
        "env",
        ".env",
        "node_modules",
        "__pycache__",
        "build",
        "dist",
        "site-packages",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        ".eggs",
    }
)

DEFAULT_MAX_FILE_BYTES = 1 << 20  # 1 MiB
MAX_DIAGNOSTICS_PER_FILE = 25
_BINARY_SNIFF_BYTES = 8192

#: Node types that introduce a new named scope in Python.
_DEF_NODE_TYPES = frozenset({"function_definition", "class_definition"})
# Receivers an assignment target may name to mean "the instance this method is on".
_SELF_NAMES = frozenset({"self", "cls"})
# Kinds that own a body and can therefore enclose a call site.
_CALLABLE_KINDS = frozenset({"function", "method", "class"})
# Nodes that end the locals walk (tic-799e): a nested def or class binds its
# own names, and a decorated_definition is only ever one of those in wrapper
# clothes.  A `lambda` is deliberately absent -- it is not a scope, so a walrus
# inside one binds in the enclosing function, matching the control-flow walk.
_LOCAL_BOUNDARY = frozenset(
    {"function_definition", "class_definition", "decorated_definition"}
)
# Pattern nodes that merely WRAP bound names; the walk recurses through them.
# `tuple` is here because this grammar parses `with x as (a, b)` as an
# as_pattern_target holding a tuple, not a pattern_list.
_PATTERN_CONTAINERS = frozenset(
    {"pattern_list", "tuple_pattern", "list_pattern", "as_pattern_target", "tuple"}
)
_MAX_VALUE_CHARS = 80  # assignment right-hand sides are summarised, not stored


#: Nodes the control-flow walk stops at: a call's breadcrumb is relative to
#: the definition that owns it (tic-b47a).  `lambda` is deliberately absent --
#: it is not a symbol, so a call inside one still belongs to the enclosing
#: function and merely gains a `lambda` token.
#: Reference capture name -> the position it records (tic-89fa).
_REF_POSITIONS = {
    "ref.argument": "argument",
    "ref.assign": "assign-value",
    "ref.collection": "collection",
}

#: How far up the enclosing-scope chain a shadowing check walks.
_MAX_SCOPE_DEPTH = 8

_CONTROL_STOP = frozenset(
    {"function_definition", "class_definition", "decorated_definition", "module"}
)

#: `except` and `except*`; both put a call on the error path.
_EXCEPT_CLAUSES = frozenset({"except_clause", "except_group_clause"})

_COMPREHENSIONS = frozenset(
    {
        "list_comprehension",
        "set_comprehension",
        "dictionary_comprehension",
        "generator_expression",
    }
)

#: Node types that count one decision toward a callable's complexity proxy
#: (tic-d7d1): if/elif, match cases, for, while, except handlers, boolean
#: ``and``/``or``, ternaries and comprehension guards.  A comprehension's own
#: ``for`` does not count -- its guard (``if_clause``) does -- matching the
#: ticket's list.  ``boolean_operator`` nests left-associatively, so a chain
#: like ``a and b and c`` is two of these nodes and counts 2.
_COMPLEXITY_NODES = frozenset(
    {
        "if_statement",
        "elif_clause",
        "case_clause",
        "for_statement",
        "while_statement",
        "except_clause",
        "except_group_clause",
        "boolean_operator",
        "conditional_expression",
        "if_clause",
    }
)

#: An `else` means something different on each of its four hosts, and all four
#: are guards: the if-else is the obvious one, try-else runs only when nothing
#: raised, and for/while-else only when the loop was not broken out of.
_ELSE_TOKEN = {
    "if_statement": "if:else",
    "try_statement": "try:else",
    "for_statement": "for:else",
    "while_statement": "while:else",
}


def _is_field(parent: Node, child: Node, field: str) -> bool:
    """Whether ``child`` is ``parent``'s ``field``.

    By node id, never by identity: tree-sitter builds a fresh Node wrapper on
    every access, so ``child is parent.child_by_field_name(...)`` is always
    False and would silently classify every call as unguarded.
    """
    target = parent.child_by_field_name(field)
    return target is not None and target.id == child.id


class CodebaseParser:
    """Walk a directory tree and extract graph material from every source file.

    Args:
        root: Directory to traverse.
        strip_prefix: Path prefix removed when deriving module names, e.g.
            ``"src"`` turns ``src/auth.py`` into module ``auth``.
        exclude_dirs: Directory names pruned during the walk, on top of
            :data:`DEFAULT_EXCLUDE_DIRS`.
        exclude_globs: Glob patterns matched against repo-relative POSIX paths.
        max_file_bytes: Files larger than this are skipped with a diagnostic.
        follow_symlinks: Off by default; symlinked trees invite walk cycles.
        module_prefix: Prepended to every module name.  Defaults to the root
            directory's own name when it is a package (it holds an
            ``__init__.py``), so absolute imports still resolve when you point
            the parser straight at a package.  Pass ``""`` to opt out.
    """

    def __init__(
        self,
        root: Path | str,
        *,
        strip_prefix: str = "",
        exclude_dirs: Iterable[str] = (),
        exclude_globs: Iterable[str] = (),
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
        follow_symlinks: bool = False,
        module_prefix: str | None = None,
    ) -> None:
        self.root = Path(root).resolve()
        self.strip_prefix = strip_prefix
        # Pointing at a package directory (`.../networkx`) rather than the repo
        # root would otherwise strip the package name off every module id and
        # leave absolute imports unresolvable.
        base = self.root.parent if self.root.is_file() else self.root
        self.module_prefix = (
            module_prefix
            if module_prefix is not None
            else (base.name if (base / "__init__.py").exists() else "")
        )
        self.exclude_dirs = DEFAULT_EXCLUDE_DIRS | set(exclude_dirs)
        self.exclude_globs = tuple(exclude_globs)
        self.max_file_bytes = max_file_bytes
        self.follow_symlinks = follow_symlinks

    # -- traversal ---------------------------------------------------------

    def iter_source_files(self) -> Iterator[Path]:
        """Yield every file in the tree that an enabled language claims."""
        if self.root.is_file():
            if spec_for_path(self.root):
                yield self.root
            return

        for dirpath, dirnames, filenames in os.walk(
            self.root, topdown=True, followlinks=self.follow_symlinks
        ):
            here = Path(dirpath)
            dirnames[:] = sorted(
                name
                for name in dirnames
                if name not in self.exclude_dirs
                and not self._is_excluded(here / name)
            )
            for name in sorted(filenames):
                path = here / name
                if spec_for_path(path) and not self._is_excluded(path):
                    yield path

    def _is_excluded(self, path: Path) -> bool:
        if not self.exclude_globs:
            return False
        rel = self.relative_path(path)
        return any(
            fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(PurePosixPath(rel).name, pattern)
            for pattern in self.exclude_globs
        )

    def module_name(self, path: Path | str) -> str:
        """Dotted module name for a path, package prefix included."""
        name = module_name_for_path(self.relative_path(Path(path)), self.strip_prefix)
        if not self.module_prefix:
            return name
        return f"{self.module_prefix}.{name}" if name else self.module_prefix

    def relative_path(self, path: Path) -> str:
        """Repo-relative POSIX path, falling back to the name when outside root."""
        try:
            return PurePosixPath(Path(path).resolve().relative_to(self.root)).as_posix()
        except ValueError:
            return Path(path).name

    # -- entry points ------------------------------------------------------

    def parse_tree(self) -> list[ParsedFile]:
        """Parse every supported file under ``root``."""
        return [self.parse_file(path) for path in self.iter_source_files()]

    def parse_file(self, path: Path | str) -> ParsedFile:
        """Parse a single file, returning diagnostics instead of raising."""
        path = Path(path)
        rel = self.relative_path(path)
        module = self.module_name(path)
        spec = spec_for_path(path)

        if spec is None:
            return ParsedFile(
                file_path=rel,
                module=module,
                language="unknown",
                diagnostics=[
                    ParseDiagnostic(rel, "unsupported", f"no grammar for suffix {path.suffix!r}")
                ],
            )

        try:
            size = path.stat().st_size
            if size > self.max_file_bytes:
                return ParsedFile(
                    file_path=rel,
                    module=module,
                    language=spec.name,
                    diagnostics=[
                        ParseDiagnostic(
                            rel,
                            "skipped",
                            f"file is {size} bytes, over the {self.max_file_bytes} byte limit",
                        )
                    ],
                )
            source = path.read_bytes()
        except OSError as exc:
            return ParsedFile(
                file_path=rel,
                module=module,
                language=spec.name,
                diagnostics=[ParseDiagnostic(rel, "read_error", str(exc))],
            )

        if b"\x00" in source[:_BINARY_SNIFF_BYTES]:
            return ParsedFile(
                file_path=rel,
                module=module,
                language=spec.name,
                diagnostics=[ParseDiagnostic(rel, "skipped", "file looks binary")],
            )

        return self.parse_source(source, file_path=rel, module=module, spec=spec)

    def parse_source(
        self,
        source: bytes,
        *,
        file_path: str,
        module: str,
        spec: LanguageSpec | None = None,
    ) -> ParsedFile:
        """Parse in-memory source bytes.  Nothing is written to disk."""
        spec = spec or spec_for_path(file_path)
        if spec is None:
            return ParsedFile(
                file_path=file_path,
                module=module,
                language="unknown",
                diagnostics=[ParseDiagnostic(file_path, "unsupported", "no grammar")],
            )

        try:
            loaded = load_language(spec)
        except GrammarUnavailable as exc:
            return ParsedFile(
                file_path=file_path,
                module=module,
                language=spec.name,
                diagnostics=[ParseDiagnostic(file_path, "unsupported", str(exc))],
            )

        try:
            tree = loaded.parser.parse(source)
            extractor = _PythonExtractor(source, file_path=file_path, module=module)
            matches = QueryCursor(loaded.query).matches(tree.root_node)
            return extractor.extract(tree.root_node, matches)
        except RecursionError as exc:  # pragma: no cover - pathological input
            return ParsedFile(
                file_path=file_path,
                module=module,
                language=spec.name,
                diagnostics=[ParseDiagnostic(file_path, "internal_error", f"tree too deep: {exc}")],
            )
        except Exception as exc:  # pragma: no cover - defensive backstop
            logger.exception("unexpected failure parsing %s", file_path)
            return ParsedFile(
                file_path=file_path,
                module=module,
                language=spec.name,
                diagnostics=[ParseDiagnostic(file_path, "internal_error", repr(exc))],
            )


class _PythonExtractor:
    """Turns one parsed Python tree into definitions, imports and call sites."""

    def __init__(self, source: bytes, *, file_path: str, module: str) -> None:
        self.source = source
        self.file_path = file_path
        self.module = module
        self.diagnostics: list[ParseDiagnostic] = []

    # -- helpers -----------------------------------------------------------

    def text(self, node: Node | None) -> str:
        """Decode a node's byte range.  Undecodable bytes degrade, never raise."""
        if node is None:
            return ""
        return self.source[node.start_byte : node.end_byte].decode("utf-8", "replace")

    def slice(self, start: int, end: int) -> str:
        return self.source[start:end].decode("utf-8", "replace")

    def dedented_slice(self, start: int, end: int) -> str:
        """Source text with the definition's own indentation removed.

        A method sliced straight out of the file starts flush at ``def`` but
        keeps its body indented, which is not valid Python on its own.  Putting
        the leading indentation back before dedenting fixes the whole block.
        Line endings are normalised to ``\\n`` on the way out; byte offsets on
        the symbol still point into the original file.
        """
        raw = self.slice(start, end)
        line_start = self.source.rfind(b"\n", 0, start) + 1
        indent = self.slice(line_start, start)
        if indent and not indent.isspace():
            return _normalise_newlines(raw)  # something shares the line
        return _dedent(_normalise_newlines(indent + raw))

    def note(self, kind: str, detail: str, line: int = 0) -> None:
        if len(self.diagnostics) < MAX_DIAGNOSTICS_PER_FILE:
            self.diagnostics.append(ParseDiagnostic(self.file_path, kind, detail, line))  # type: ignore[arg-type]

    # -- top level ---------------------------------------------------------

    def extract(
        self, root: Node, matches: Sequence[tuple[int, dict[str, list[Node]]]]
    ) -> ParsedFile:
        self._collect_syntax_errors(root)

        def_matches: list[tuple[Node, dict[str, list[Node]]]] = []
        assign_matches: list[tuple[Node, dict[str, list[Node]]]] = []
        with_matches: list[tuple[Node, dict[str, list[Node]]]] = []
        import_nodes: list[tuple[str, Node]] = []
        call_matches: list[dict[str, list[Node]]] = []
        # (position, name node, site node) and the raw bound-name nodes.
        ref_matches: list[tuple[str, Node, Node]] = []
        bind_names: list[Node] = []

        for _pattern, caps in matches:
            if "def.function" in caps or "def.class" in caps:
                node = (caps.get("def.function") or caps.get("def.class"))[0]
                if not self._inside_error(node):
                    def_matches.append((node, caps))
            elif "assign.site" in caps:
                node = caps["assign.site"][0]
                if not self._inside_error(node):
                    assign_matches.append((node, caps))
            elif "with.item" in caps:
                node = caps["with.item"][0]
                if not self._inside_error(node):
                    with_matches.append((node, caps))
            elif "import.plain" in caps:
                import_nodes.append(("plain", caps["import.plain"][0]))
            elif "import.from" in caps:
                import_nodes.append(("from", caps["import.from"][0]))
            elif "call.site" in caps:
                call_matches.append(caps)
            elif "bind.name" in caps:
                bind_names.extend(caps["bind.name"])
            else:
                for capture, position in _REF_POSITIONS.items():
                    site_nodes = caps.get(capture)
                    if not site_nodes:
                        continue
                    for name_node in caps.get("ref.name") or []:
                        ref_matches.append((position, name_node, site_nodes[0]))

        symbols = self._build_symbols(def_matches, assign_matches)
        imports = self._build_imports(import_nodes)
        calls = self._build_calls(call_matches, symbols)
        local_bindings = self._build_locals(assign_matches, with_matches, symbols)
        references = self._build_references(ref_matches, bind_names, symbols)

        return ParsedFile(
            file_path=self.file_path,
            module=self.module,
            language="python",
            symbols=symbols,
            imports=imports,
            calls=calls,
            locals=local_bindings,
            references=references,
            diagnostics=self.diagnostics,
            module_docstring=self._docstring_of_block(root),
        )

    def _collect_syntax_errors(self, root: Node) -> None:
        """Record ERROR/MISSING nodes without descending into the wreckage."""
        if not root.has_error:
            return
        stack: list[Node] = [root]
        while stack:
            node = stack.pop()
            if node.is_missing:
                self.note(
                    "missing_node",
                    f"missing {node.type!r}",
                    node.start_point.row + 1,
                )
                continue
            if node.type == "ERROR" or node.is_error:
                self.note(
                    "syntax_error",
                    f"unparseable region: {self.text(node)[:60]!r}",
                    node.start_point.row + 1,
                )
                continue  # do not descend; the subtree is not trustworthy
            if node.has_error:
                stack.extend(node.children)

    @staticmethod
    def _inside_error(node: Node) -> bool:
        """True when a captured node sits inside an unparseable region."""
        parent = node.parent
        while parent is not None:
            if parent.type == "ERROR" or parent.is_error:
                return True
            parent = parent.parent
        return False

    # -- definitions -------------------------------------------------------

    def _build_symbols(
        self,
        def_matches: Sequence[tuple[Node, dict[str, list[Node]]]],
        assign_matches: Sequence[tuple[Node, dict[str, list[Node]]]] = (),
    ) -> list[SymbolDef]:
        symbols: list[SymbolDef] = []
        for node, caps in sorted(def_matches, key=lambda item: item[0].start_byte):
            if self._header_damaged(node):
                self.note(
                    "syntax_error",
                    f"skipping definition with an unparseable header: "
                    f"{self.slice(node.start_byte, min(node.end_byte, node.start_byte + 40))!r}",
                    node.start_point.row + 1,
                )
                continue
            try:
                symbols.append(self._build_symbol(node, caps))
            except Exception as exc:  # pragma: no cover - defensive per-node guard
                self.note(
                    "internal_error",
                    f"could not extract definition: {exc!r}",
                    node.start_point.row + 1,
                )

        # An instance attribute may be assigned in several methods, and may
        # collide with a class-body attribute of the same name.  All of those
        # describe one member, so the first binding in source order wins --
        # the same rule ``resolver._build_indexes`` applies across files.
        taken = {symbol.symbol_id for symbol in symbols}
        for node, caps in sorted(assign_matches, key=lambda item: item[0].start_byte):
            try:
                symbol = self._build_assignment(node, caps)
            except Exception as exc:  # pragma: no cover - defensive per-node guard
                self.note(
                    "internal_error",
                    f"could not extract assignment: {exc!r}",
                    node.start_point.row + 1,
                )
                continue
            if symbol is None or symbol.symbol_id in taken:
                continue
            taken.add(symbol.symbol_id)
            symbols.append(symbol)

        symbols.sort(key=lambda s: (s.start_byte, -s.end_byte))
        return symbols

    def _build_symbol(self, node: Node, caps: dict[str, list[Node]]) -> SymbolDef:
        is_class = node.type == "class_definition"
        name_nodes = caps.get("def.name") or []
        name = self.text(name_nodes[0]) if name_nodes else "<anonymous>"

        qualifiers = self._enclosing_names(node)
        parent_id = ".".join(filter(None, [self.module, *qualifiers])) or None
        symbol_id = ".".join(filter(None, [self.module, *qualifiers, name]))

        enclosing = self._nearest_def(node)
        in_class_body = enclosing is not None and enclosing.type == "class_definition"
        kind = "class" if is_class else ("method" if in_class_body else "function")

        decorated = node.parent if node.parent and node.parent.type == "decorated_definition" else None
        decorators = (
            [self.text(child) for child in decorated.children if child.type == "decorator"]
            if decorated
            else []
        )

        body = (caps.get("def.body") or [None])[0]
        start_byte = decorated.start_byte if decorated else node.start_byte
        end_byte = node.end_byte

        signature = self._signature(node, body)
        params = (
            []
            if is_class
            else self._params(node.child_by_field_name("parameters"))
        )
        bases = self._bases(node) if is_class else []
        returns = None if is_class else self._returns(node)
        docstring = self._docstring_of_block(body)
        is_async = any(child.type == "async" for child in node.children)

        if is_class:
            complexity, line_count, locals_names = 1, 0, []
        else:
            complexity = self._complexity(node)
            line_count = node.end_point.row - (decorated or node).start_point.row + 1
            locals_names = self._local_names(node)

        return SymbolDef(
            symbol_id=symbol_id,
            name=name,
            kind=kind,  # type: ignore[arg-type]
            file_path=self.file_path,
            module=self.module,
            parent=parent_id if qualifiers else None,
            start_byte=start_byte,
            end_byte=end_byte,
            start_line=(decorated or node).start_point.row + 1,
            end_line=node.end_point.row + 1,
            params=params,
            returns=returns,
            signature=signature,
            docstring=docstring,
            decorators=decorators,
            bases=bases,
            is_async=is_async,
            complexity=complexity,
            line_count=line_count,
            locals=locals_names,
            code=self.dedented_slice(start_byte, end_byte),
            stub=self._stub(signature, docstring, decorators),
        )

    def _build_assignment(
        self, node: Node, caps: dict[str, list[Node]]
    ) -> SymbolDef | None:
        """Turn a name-binding assignment into a variable or attribute symbol.

        Three scopes produce a symbol: the module top level (``variable``), a
        class body (``attribute``) and ``self.x = ...`` inside a method, which
        is an ``attribute`` on the class rather than on the method that happens
        to assign it.  A plain local is invisible from outside, so not a symbol.
        """
        receiver_nodes = caps.get("assign.receiver") or []
        name_nodes = caps.get("assign.name") or []
        if not name_nodes:  # pragma: no cover - the query always binds the name
            return None
        name = self.text(name_nodes[0])

        if receiver_nodes:
            qualifiers = self._instance_attribute_owner(node, receiver_nodes[0])
            if qualifiers is None:
                return None
            # `self.` is kept in the signature: it is what the source says, and
            # it separates an instance attribute from a class-body one without
            # needing a second SymbolKind for it.
            kind = "attribute"
            display = f"{self.text(receiver_nodes[0])}.{name}"
        else:
            enclosing = self._nearest_def(node)
            if enclosing is not None and enclosing.type == "function_definition":
                return None
            kind = "attribute" if enclosing is not None else "variable"
            qualifiers, display = self._enclosing_names(node), name

        parent_id = ".".join(filter(None, [self.module, *qualifiers])) or None
        symbol_id = ".".join(filter(None, [self.module, *qualifiers, name]))

        annotation = self.text(node.child_by_field_name("type")) or None
        value = self._truncate_value(node.child_by_field_name("right"))
        signature = display
        if annotation:
            signature += f": {annotation}"
        if value is not None:
            signature += f" = {value}"

        return SymbolDef(
            symbol_id=symbol_id,
            name=name,
            kind=kind,  # type: ignore[arg-type]
            file_path=self.file_path,
            module=self.module,
            parent=parent_id if qualifiers else None,
            start_byte=node.start_byte,
            end_byte=node.end_byte,
            start_line=node.start_point.row + 1,
            end_line=node.end_point.row + 1,
            line_count=node.end_point.row - node.start_point.row + 1,
            signature=signature,
            code=self.dedented_slice(node.start_byte, node.end_byte),
            stub=signature,
        )

    def _instance_attribute_owner(self, node: Node, receiver: Node) -> list[str] | None:
        """Qualifiers of the class owning ``self.x = ...``, or None if it is not one.

        Two things have to hold: the receiver is spelled ``self``/``cls``, and
        the assignment sits in a method body rather than straight in a class
        body or in a free function that merely names a parameter ``self``.  The
        symbol then hangs off the class -- ``mod.Class.x``, not
        ``mod.Class.__init__.x`` -- because that is where a reader looks for it.
        """
        name = self.text(receiver)
        if name not in _SELF_NAMES:
            return None
        nearest = self._nearest_def(node)
        if nearest is None or nearest.type != "function_definition":
            return None

        owner = nearest
        while owner is not None and owner.type != "class_definition":
            owner = self._nearest_def(owner)
        if owner is None:
            return None

        name_node = owner.child_by_field_name("name")
        class_name = self.text(name_node) if name_node else "<anonymous>"
        return [*self._enclosing_names(owner), class_name]

    def _truncate_value(self, value: Node | None) -> str | None:
        """One-line summary of an assignment's right-hand side.

        A constant may be a hundred-line dict literal; the graph wants to know
        *that a name is bound and roughly to what*, not to carry the payload.
        """
        if value is None:
            return None
        text = " ".join(self.text(value).split())
        if len(text) > _MAX_VALUE_CHARS:
            return text[: _MAX_VALUE_CHARS - 3].rstrip() + "..."
        return text

    @staticmethod
    def _header_damaged(node: Node) -> bool:
        """True when the signature of a definition did not parse cleanly.

        A body full of syntax errors still leaves a usable signature, so only
        damage *before* the body disqualifies a definition.  Without this a
        half-recovered ``def broken(:`` produces a symbol whose name, params and
        signature are all nonsense.
        """
        if node.child_by_field_name("name") is None:
            return True
        body = node.child_by_field_name("body")
        limit = body.start_byte if body is not None else node.end_byte
        for child in node.children:
            if child.start_byte >= limit:
                break
            if child.is_missing or child.has_error or child.type == "ERROR":
                return True
        return False

    @staticmethod
    def _nearest_def(node: Node) -> Node | None:
        """The definition node immediately enclosing ``node``, if any."""
        parent = node.parent
        while parent is not None:
            if parent.type in _DEF_NODE_TYPES:
                return parent
            parent = parent.parent
        return None

    def _enclosing_names(self, node: Node) -> list[str]:
        """Names of the definitions enclosing ``node``, outermost first."""
        names: list[str] = []
        parent = node.parent
        while parent is not None:
            if parent.type in _DEF_NODE_TYPES:
                name_node = parent.child_by_field_name("name")
                names.append(self.text(name_node) if name_node else "<anonymous>")
            parent = parent.parent
        names.reverse()
        return names

    def _signature(self, node: Node, body: Node | None) -> str:
        """Source text from the ``def``/``class`` keyword through the colon."""
        end = body.start_byte if body is not None else node.end_byte
        raw = self.slice(node.start_byte, end).rstrip()
        # Trim the trailing block opener remnants, then flatten wrapped params.
        raw = raw.rstrip()
        if "\n" in raw:
            raw = " ".join(raw.split())
        return raw

    def _returns(self, node: Node) -> str | None:
        """The return annotation as written, or None when there is none.

        Taken from the ``return_type`` field rather than picked out of the
        signature text, so a wrapped or commented annotation needs no parsing
        to recover.  Whitespace inside a multi-line annotation is flattened
        the same way :meth:`_signature` flattens wrapped parameters, so
        ``-> tuple[
    int,
    str,
]`` reads back as one line.
        """
        annotation = node.child_by_field_name("return_type")
        if annotation is None:
            return None
        text = self.text(annotation).strip()
        return " ".join(text.split()) if text else None

    def _params(self, params_node: Node | None) -> list[Param]:
        """Destructure a ``parameters`` node into typed :class:`Param` records."""
        if params_node is None:
            return []

        params: list[Param] = []
        kwonly = False
        posonly_upto = -1

        for child in params_node.named_children:
            ctype = child.type
            if ctype == "comment":
                continue
            if ctype == "positional_separator":
                posonly_upto = len(params)
                continue
            if ctype == "keyword_separator":
                kwonly = True
                continue

            kind = "kwonly" if kwonly else "positional"
            name = annotation = default = None

            if ctype == "identifier":
                name = self.text(child)
            elif ctype == "typed_parameter":
                # The parameter itself may still be a splat: `*args: int`.
                annotation = self.text(child.child_by_field_name("type"))
                inner = child.named_children[0] if child.named_children else None
                inner_type = inner.type if inner is not None else ""
                if inner_type in ("list_splat_pattern", "list_splat"):
                    name = self.text(inner).lstrip("*")
                    kind = "vararg"
                    kwonly = True
                elif inner_type in ("dictionary_splat_pattern", "dictionary_splat"):
                    name = self.text(inner).lstrip("*")
                    kind = "kwarg"
                else:
                    name = self.text(inner)
            elif ctype == "default_parameter":
                name = self.text(child.child_by_field_name("name"))
                default = self.text(child.child_by_field_name("value"))
            elif ctype == "typed_default_parameter":
                name = self.text(child.child_by_field_name("name"))
                annotation = self.text(child.child_by_field_name("type"))
                default = self.text(child.child_by_field_name("value"))
            elif ctype in ("list_splat_pattern", "list_splat"):
                name = self.text(child).lstrip("*")
                kind = "vararg"
                kwonly = True  # everything after *args is keyword-only
            elif ctype in ("dictionary_splat_pattern", "dictionary_splat"):
                name = self.text(child).lstrip("*")
                kind = "kwarg"
            elif ctype == "tuple_pattern":  # legacy nested params
                name = self.text(child)
            else:
                # Unknown shape: keep the source text so nothing silently vanishes.
                name = self.text(child)
                self.note(
                    "syntax_error",
                    f"unrecognised parameter node {ctype!r}",
                    child.start_point.row + 1,
                )

            params.append(
                Param(
                    name=name or "",
                    annotation=annotation or None,
                    default=default or None,
                    kind=kind,  # type: ignore[arg-type]
                )
            )

        if posonly_upto >= 0:
            params = [
                Param(p.name, p.annotation, p.default, "posonly") if i < posonly_upto else p
                for i, p in enumerate(params)
            ]
        return params

    def _bases(self, class_node: Node) -> list[str]:
        """Superclass expressions as written, e.g. ``["Base", "Mixin"]``."""
        arglist = class_node.child_by_field_name("superclasses")
        if arglist is None:
            return []
        return [
            self.text(child)
            for child in arglist.named_children
            if child.type not in ("comment",)
        ]

    def _docstring_of_block(self, block: Node | None) -> str | None:
        """The leading string literal of a block or module, cleaned up."""
        if block is None:
            return None
        for child in block.named_children:
            if child.type == "comment":
                continue
            if child.type != "expression_statement" or not child.named_children:
                return None
            literal = child.named_children[0]
            if literal.type != "string":
                return None
            raw = self.text(literal)
            try:
                value = ast.literal_eval(raw)
            except (ValueError, SyntaxError, MemoryError, RecursionError):
                return None  # f-string or otherwise not a plain literal
            if not isinstance(value, str):
                return None
            return inspect.cleandoc(_normalise_newlines(value))
        return None

    @staticmethod
    def _stub(signature: str, docstring: str | None, decorators: Sequence[str]) -> str:
        """Signature + docstring with the body replaced by ``...``."""
        lines = list(decorators)
        lines.append(signature)
        if docstring:
            quoted = docstring.replace('"""', r"\"\"\"")
            if "\n" in quoted:
                lines.append('    """')
                lines.extend(f"    {line}".rstrip() for line in quoted.splitlines())
                lines.append('    """')
            else:
                lines.append(f'    """{quoted}"""')
        lines.append("    ...")
        return "\n".join(lines)

    # -- imports -----------------------------------------------------------

    def _build_imports(self, import_nodes: Sequence[tuple[str, Node]]) -> list[ImportRecord]:
        records: list[ImportRecord] = []
        for flavour, node in sorted(import_nodes, key=lambda item: item[1].start_byte):
            if self._inside_error(node):
                continue
            try:
                if flavour == "plain":
                    records.extend(self._plain_import(node))
                else:
                    records.extend(self._from_import(node))
            except Exception as exc:  # pragma: no cover - defensive per-node guard
                self.note(
                    "internal_error",
                    f"could not extract import: {exc!r}",
                    node.start_point.row + 1,
                )
        return records

    def _plain_import(self, node: Node) -> Iterator[ImportRecord]:
        """``import a.b`` binds ``a``; ``import a.b as c`` binds ``c``."""
        line = node.start_point.row + 1
        for child in node.children_by_field_name("name"):
            if child.type == "aliased_import":
                target = self.text(child.child_by_field_name("name"))
                alias = self.text(child.child_by_field_name("alias"))
            elif child.type == "dotted_name":
                target = self.text(child)
                alias = target.split(".", 1)[0]
            else:
                continue
            yield ImportRecord(
                module=self.module,
                alias=alias,
                target_module=target,
                target_symbol=None,
                line=line,
            )

    def _from_import(self, node: Node) -> Iterator[ImportRecord]:
        """``from .pkg import a as b`` -- resolve dots, alias and symbol names."""
        line = node.start_point.row + 1
        module_node = node.child_by_field_name("module_name")
        level = 0
        target_module = ""

        if module_node is not None and module_node.type == "relative_import":
            prefix = next(
                (c for c in module_node.children if c.type == "import_prefix"), None
            )
            level = len(self.text(prefix)) if prefix is not None else 0
            dotted = next((c for c in module_node.children if c.type == "dotted_name"), None)
            target_module = self.text(dotted) if dotted is not None else ""
        elif module_node is not None:
            target_module = self.text(module_node)

        is_relative = level > 0

        if any(child.type == "wildcard_import" for child in node.children):
            yield ImportRecord(
                module=self.module,
                alias="*",
                target_module=target_module,
                target_symbol=None,
                is_relative=is_relative,
                level=level,
                is_wildcard=True,
                line=line,
            )
            return

        for child in node.children_by_field_name("name"):
            if child.type == "aliased_import":
                symbol = self.text(child.child_by_field_name("name"))
                alias = self.text(child.child_by_field_name("alias"))
            elif child.type == "dotted_name":
                symbol = self.text(child)
                alias = symbol.split(".", 1)[0]
            else:
                continue
            yield ImportRecord(
                module=self.module,
                alias=alias,
                target_module=target_module,
                target_symbol=symbol,
                is_relative=is_relative,
                level=level,
                line=line,
            )

    # -- call sites --------------------------------------------------------

    def _build_calls(
        self, call_matches: Sequence[dict[str, list[Node]]], symbols: Sequence[SymbolDef]
    ) -> list[CallSite]:
        # Only definitions can own a call: a call in `X = compute()` belongs to
        # the module, not to `X`, so variables and attributes stay out of the
        # enclosing-symbol search.
        owners = [s for s in symbols if s.kind in _CALLABLE_KINDS]
        starts = [s.start_byte for s in owners]
        calls: list[CallSite] = []

        for caps in call_matches:
            site = caps["call.site"][0]
            callee_nodes = caps.get("call.callee") or []
            if not callee_nodes or self._inside_error(site):
                continue
            callee = callee_nodes[0]

            path = self._attribute_path(callee)
            raw_name = self.text(callee)
            root = path[0] if path else ""
            attr_path = path[1:] if path else []

            calls.append(
                CallSite(
                    module=self.module,
                    file_path=self.file_path,
                    raw_name=raw_name,
                    root=root,
                    attr_path=attr_path,
                    caller_id=self._enclosing_symbol(site.start_byte, owners, starts),
                    control=self._control_path(site),
                    line=site.start_point.row + 1,
                    start_byte=site.start_byte,
                    end_byte=site.end_byte,
                )
            )

        calls.sort(key=lambda c: c.start_byte)
        return calls

    # -- local bindings ----------------------------------------------------

    def _build_locals(
        self,
        assign_matches: Sequence[tuple[Node, dict[str, list[Node]]]],
        with_matches: Sequence[tuple[Node, dict[str, list[Node]]]],
        symbols: Sequence[SymbolDef],
    ) -> list[LocalBinding]:
        """Local names bound to something type-bearing, per function body.

        Only bindings inside a FUNCTION are collected.  A name bound at module
        or class level is already a symbol (see :meth:`_build_assignment`), and
        the resolver reaches those through ``module_members``; recording them
        again here would give the same name two sources of truth.

        Nothing is resolved, evaluated or inferred at this stage -- the
        expression is flattened to a dotted path and handed on.  What it means
        is the resolver's business, because only the resolver knows the import
        bindings and the symbol table.
        """
        owners = [s for s in symbols if s.kind in _CALLABLE_KINDS]
        starts = [s.start_byte for s in owners]
        bindings: list[LocalBinding] = []

        def scope_of(node: Node) -> str | None:
            """The enclosing FUNCTION, or None for module and class level."""
            scope_id = self._enclosing_symbol(node.start_byte, owners, starts)
            if scope_id is None:
                return None
            owner = next((s for s in owners if s.symbol_id == scope_id), None)
            return scope_id if owner is not None and owner.kind != "class" else None

        for node, caps in assign_matches:
            if caps.get("assign.receiver"):
                continue  # `self.x = ...` is an attribute symbol, not a local
            name_nodes = caps.get("assign.name") or []
            if not name_nodes:
                continue
            scope_id = scope_of(node)
            if scope_id is None:
                continue

            # An annotation beats the assigned value: `x: Session = _make()`
            # says what the author means, and the value may be a factory whose
            # return type is vaguer than the annotation.
            annotation = node.child_by_field_name("type")
            if annotation is not None:
                root, attr_path = self._type_path(annotation)
                bindings.append(
                    LocalBinding(
                        scope_id=scope_id,
                        name=self.text(name_nodes[0]),
                        source="annotation",
                        root=root,
                        attr_path=attr_path,
                        line=node.start_point.row + 1,
                    )
                )
                continue

            value = node.child_by_field_name("right")
            bindings.append(
                self._value_binding(
                    scope_id, self.text(name_nodes[0]), "assign", value, node
                )
            )

        for node, caps in with_matches:
            name_nodes = caps.get("with.name") or []
            if not name_nodes:
                continue
            scope_id = scope_of(node)
            if scope_id is None:
                continue
            pattern = node.child_by_field_name("value")
            value = pattern.named_children[0] if pattern is not None and pattern.named_children else None
            bindings.append(
                self._value_binding(
                    scope_id, self.text(name_nodes[0]), "with", value, node
                )
            )

        bindings.sort(key=lambda b: (b.scope_id, b.name, b.line))
        return bindings

    def _value_binding(
        self,
        scope_id: str,
        name: str,
        source: str,
        value: Node | None,
        site: Node,
    ) -> LocalBinding:
        """One binding from an expression: a literal type, a call, or nothing.

        A binding is recorded even when the expression says nothing useful.
        That is deliberate: an unusable binding still means the name WAS bound
        here, so a second binding elsewhere in the same body cannot be trusted
        on its own, and the resolver's drop-if-ambiguous rule needs to see it.
        """
        line = site.start_point.row + 1
        if value is None:
            return LocalBinding(scope_id=scope_id, name=name, source=source, line=line)  # type: ignore[arg-type]

        literal = LITERAL_TYPES.get(value.type)
        if literal is not None:
            return LocalBinding(
                scope_id=scope_id, name=name, source=source, literal=literal, line=line  # type: ignore[arg-type]
            )

        # `await f()` binds whatever `f()` does; the await is not a type.
        inner = value
        while inner.type == "await" and inner.named_children:
            inner = inner.named_children[0]

        if inner.type == "call":
            callee = inner.child_by_field_name("function")
            if callee is not None:
                path = self._attribute_path(callee)
                if path:
                    return LocalBinding(
                        scope_id=scope_id,
                        name=name,
                        source=source,  # type: ignore[arg-type]
                        root=path[0],
                        attr_path=path[1:],
                        line=line,
                    )
        return LocalBinding(scope_id=scope_id, name=name, source=source, line=line)  # type: ignore[arg-type]

    def _type_path(self, annotation: Node) -> tuple[str, list[str]]:
        """Flatten an annotation to a dotted path, or ("", []) if it is not one.

        Shallow on purpose: a subscripted or unioned annotation names a shape
        rather than a class, and calling a method on ``list[Session]`` is a
        list operation, not a Session one.  Stripping the wrapper here would
        turn a container into its element and make the classification lie.
        A quoted forward reference is unwrapped, because that is the same
        name written to survive an import cycle.
        """
        node = annotation
        if node.type == "type" and node.named_children:
            node = node.named_children[0]
        if node.type == "string":
            text = self.text(node).strip("\"'")
            segments = [s for s in text.split(".") if s.isidentifier()]
            return (segments[0], segments[1:]) if segments else ("", [])
        path = self._attribute_path(node)
        return (path[0], path[1:]) if path else ("", [])

    # -- references (tic-89fa) ---------------------------------------------

    def _build_references(
        self,
        ref_matches: Sequence[tuple[str, Node, Node]],
        bind_names: Sequence[Node],
        symbols: Sequence[SymbolDef],
    ) -> list[Reference]:
        """Callables named without being called, minus everything shadowed.

        A reference is only worth recording if the name could actually reach
        the definition it looks like.  A name the enclosing function BINDS
        cannot: ``def test_x(session): do(session)`` names its own parameter,
        not the module-level ``session`` it happens to share a spelling with.
        Measured on ../carnot, skipping that check made 85% of the argument
        references wrong -- so the bound-name set is built first and is
        deliberately over-broad, since a binding form missed here becomes a
        false reference while one caught unnecessarily costs only a true
        reference we decline to draw.
        """
        owners = [s for s in symbols if s.kind in _CALLABLE_KINDS]
        starts = [s.start_byte for s in owners]
        by_id = {s.symbol_id: s for s in owners}
        bound = self._bound_names(bind_names, owners, starts)

        references: list[Reference] = []
        for position, name_node, site in ref_matches:
            if self._inside_error(site):
                continue
            # A class's superclass list is an `argument_list` in this grammar,
            # so `class Greet(Tool)` looks exactly like `f(Tool)`.  Inheritance
            # is a different relationship from a callback registration, it is
            # already recorded on `SymbolDef.bases`, and on ../carnot it was
            # 231 of 434 references -- more than half the edge type, saying
            # something the export already said.  If inheritance is ever worth
            # drawing it deserves its own edge type, not a share of this one.
            if site.parent is not None and site.parent.type == "class_definition":
                continue
            path = self._attribute_path(name_node)
            if not path:
                continue
            root = path[0]
            # `self.x` and `cls.x` name a member, which the call machinery
            # already understands and which is never a free reference.
            if root in _SELF_NAMES:
                continue

            scope_id = self._enclosing_symbol(name_node.start_byte, owners, starts)
            if self._is_bound(root, scope_id, by_id, bound):
                continue

            references.append(
                Reference(
                    module=self.module,
                    file_path=self.file_path,
                    raw_name=self.text(name_node),
                    root=root,
                    attr_path=path[1:],
                    scope_id=scope_id,
                    position=position,  # type: ignore[arg-type]
                    line=name_node.start_point.row + 1,
                    start_byte=name_node.start_byte,
                    end_byte=name_node.end_byte,
                )
            )

        references.sort(key=lambda r: r.start_byte)
        return references

    def _bound_names(
        self,
        bind_names: Sequence[Node],
        owners: Sequence[SymbolDef],
        starts: Sequence[int],
    ) -> dict[str | None, set[str]]:
        """Every name each scope binds, keyed by scope id (None = module level).

        Two sources: the query's assignment/loop/with/except/global captures,
        and parameters.

        Deliberately NOT import aliases.  An import is what MAKES a name mean
        the thing it names -- `from . import views` is precisely why
        `views.menu_items` resolves -- so treating the alias as a binding
        suppressed every Django URLconf reference, which is the case this
        whole ticket exists for.

        Deliberately NOT nested definition names either.  A nested `def`
        genuinely shadows an outer name, but the resolver already scopes that
        correctly (`_lookup_local` tries `<scope>.<name>` first), so a
        reference to one resolves to the nested definition rather than to the
        outer symbol -- and referencing a nested helper is a real reference
        worth drawing, not a false one worth dropping.
        """
        bound: dict[str | None, set[str]] = defaultdict(set)

        for node in bind_names:
            scope_id = self._enclosing_symbol(node.start_byte, owners, starts)
            bound[scope_id].add(self.text(node))

        for symbol in owners:
            for param in symbol.params:
                if param.name:
                    bound[symbol.symbol_id].add(param.name)

        return bound

    @staticmethod
    def _is_bound(
        name: str,
        scope_id: str | None,
        by_id: dict[str, SymbolDef],
        bound: dict[str | None, set[str]],
    ) -> bool:
        """Whether `name` is bound anywhere in `scope_id`'s enclosing chain."""
        seen = 0
        current: str | None = scope_id
        while seen <= _MAX_SCOPE_DEPTH:
            if name in bound.get(current, ()):
                return True
            if current is None:
                return False
            symbol = by_id.get(current)
            parent = symbol.parent if symbol else None
            current = parent if parent in by_id else None
            seen += 1
        return False

    def _attribute_path(self, callee: Node) -> list[str]:
        """Flatten ``a.b.c`` into ``["a", "b", "c"]``.

        Returns an empty list when the base of the chain is computed (e.g.
        ``factory().method``), which marks the call as statically unresolvable.
        """
        if callee.type == "identifier":
            return [self.text(callee)]
        if callee.type == "attribute":
            obj = callee.child_by_field_name("object")
            attr = callee.child_by_field_name("attribute")
            if obj is None or attr is None:
                return []
            base = self._attribute_path(obj)
            if not base:
                return []
            return [*base, self.text(attr)]
        return []

    # -- control flow ------------------------------------------------------

    def _complexity(self, node: Node) -> int:
        """Cyclomatic-style complexity proxy for one callable (tic-d7d1).

        ``1 +`` the number of branching constructs in the definition's OWN
        body: see :data:`_COMPLEXITY_NODES` for the list and
        :attr:`SymbolDef.complexity` for what the number is and is not.

        The walk starts at the body block, not the whole definition:
        parameter defaults and annotations evaluate at def time, so a decision
        written inside one says nothing about the paths a CALL can take.

        A nested def or class ends the walk: it carries its own number, and
        charging its decisions to the outer function would make every
        function-with-helpers look hairier than it is.  A ``lambda`` is not
        such a boundary -- it is not a symbol, matching the control-flow walk
        above -- so a decision written inside one belongs to the enclosing
        function.
        """
        body = node.child_by_field_name("body")
        if body is None:  # pragma: no cover - a parsed def always has a body
            return 1
        count = 1
        stack: list[Node] = [body]
        while stack:
            current = stack.pop()
            if current.type in _COMPLEXITY_NODES:
                count += 1
            for child in current.named_children:
                # `decorated_definition` is only ever a def/class wrapper
                # inside a body, so it is a boundary for the same reason.
                if child.type not in _DEF_NODE_TYPES and child.type != "decorated_definition":
                    stack.append(child)
        return count

    # -- locals (tic-799e) ---------------------------------------------------

    def _pattern_names(self, node: Node | None) -> Iterator[str]:
        """The plain names a binding TARGET introduces.

        An identifier is itself; container patterns recurse; splats bind the
        name under the stars.  An attribute or subscript target binds nothing
        plain and yields nothing -- ``self.x = 1`` and ``cache[k] = v`` are
        mutations, not locals.
        """
        if node is None:
            return
        kind = node.type
        if kind == "identifier":
            yield self.text(node)
        elif kind in _PATTERN_CONTAINERS:
            for child in node.named_children:
                yield from self._pattern_names(child)
        elif kind in ("list_splat_pattern", "dictionary_splat_pattern", "list_splat", "dictionary_splat"):
            inner = node.named_children[0] if node.named_children else None
            if inner is not None:
                yield from self._pattern_names(inner)
            else:  # pragma: no cover - a bare `*` target is not valid Python
                yield self.text(node).lstrip("*")

    def _local_names(self, node: Node) -> list[str]:
        """Names bound anywhere in one callable's OWN body (tic-799e).

        Deduplicated, first binding wins, source order.  The sources are the
        ones that introduce a name: assignment targets (tuple and starred
        targets included -- the very shapes :meth:`_build_assignment`
        deliberately declines), ``for`` targets, ``with ... as``,
        ``except ... as``, walrus and comprehension targets.  Augmented
        assignment and ``global``/``nonlocal`` are NOT here: they rebind or
        re-export an existing name rather than introduce one, and this is a
        reading aid, not a scope analysis.  Params live on :attr:`SymbolDef.params`
        and a nested def's locals are its own, so both stay out.

        A name list and nothing more -- deliberately not a symbol table.
        What a local BINDS is tic-97ce's business (:class:`LocalBinding`);
        this answers only "what does this function actually handle".
        """
        body = node.child_by_field_name("body")
        if body is None:  # pragma: no cover - a parsed def always has a body
            return []

        seen: set[str] = set()
        ordered: list[str] = []

        def bind(target: Node | None) -> None:
            for name in self._pattern_names(target):
                if name not in seen:
                    seen.add(name)
                    ordered.append(name)

        def walk(current: Node) -> None:
            kind = current.type
            if kind in _LOCAL_BOUNDARY:
                return  # a nested def's locals are its own
            if kind == "assignment":
                bind(current.child_by_field_name("left"))
            elif kind in ("for_statement", "for_in_clause"):
                bind(current.child_by_field_name("left"))
            elif kind == "named_expression":
                bind(current.child_by_field_name("name"))
            elif kind == "as_pattern":
                bind(current.child_by_field_name("alias"))
            elif kind in _EXCEPT_CLAUSES:
                bind(current.child_by_field_name("name"))
            for child in current.named_children:
                walk(child)

        walk(body)
        return ordered

    def _control_path(self, node: Node) -> list[str]:
        """The control-flow constructs between ``node`` and its enclosing def.

        Outermost first, so the list reads the way the source nests.  The walk
        stops at the first definition boundary, which makes a nested
        function's breadcrumb relative to ITS body rather than the outer one;
        a ``lambda`` is not such a boundary, because it is not a symbol, so a
        call inside one keeps the enclosing function's context and gains a
        ``lambda`` token of its own.

        A construct contributes a token only when the call actually sits in a
        part of it that the construct governs.  ``if check():`` does not guard
        ``check`` -- the test runs whenever the ``if`` is reached -- and nor
        does ``for x in source():`` guard ``source``, which is evaluated once
        before the loop.  Getting that wrong would mark a large share of
        ordinary calls as conditional and quietly devalue the whole signal.
        """
        tokens: list[str] = []
        child = node
        parent = child.parent
        while parent is not None and parent.type not in _CONTROL_STOP:
            token = self._control_token(parent, child)
            if token is not None:
                tokens.append(token)
            child = parent
            parent = child.parent
        tokens.reverse()
        return tokens

    def _control_token(self, parent: Node, child: Node) -> str | None:
        """The token ``parent`` contributes for a call sitting in ``child``.

        None means this construct does not govern the call at all, either
        because the call is in a position it does not control (a test, an
        iterable) or because another node in the chain already accounts for it
        (an ``elif`` is reached through ``if_statement.alternative``, and the
        ``elif_clause`` itself emits the token).
        """
        kind = parent.type

        if kind == "if_statement":
            if not _is_field(parent, child, "consequence"):
                return None  # the test, or an alternative that speaks for itself
            return "type-checking" if self._is_type_checking(parent) else "if"
        if kind == "elif_clause":
            # Both the test and the body are guarded: reaching either means
            # every earlier branch's test already failed.
            return "if:elif"
        if kind == "else_clause":
            return _ELSE_TOKEN.get(parent.parent.type if parent.parent else "", "if:else")

        if kind == "for_statement":
            # The iterable is evaluated once, before anything iterates.
            return "for" if _is_field(parent, child, "body") else None
        if kind == "while_statement":
            if _is_field(parent, child, "body"):
                return "while"
            if _is_field(parent, child, "condition"):
                # Runs at least once if the loop is reached, and again per
                # iteration: a loop position, but not a guarded one.
                return "while:test"
            return None

        if kind == "try_statement":
            return "try" if _is_field(parent, child, "body") else None
        if kind in _EXCEPT_CLAUSES:
            return "try:except"
        if kind == "finally_clause":
            return "try:finally"

        if kind == "with_statement":
            return "with" if _is_field(parent, child, "body") else None

        if kind == "match_statement":
            return None  # the subject is unguarded; a case speaks for itself
        if kind == "case_clause":
            return "match:case" if _is_field(parent, child, "consequence") else None

        if kind == "boolean_operator":
            # `a and f()` / `a or f()`: the right operand may never evaluate.
            return "bool" if _is_field(parent, child, "right") else None
        if kind == "conditional_expression":
            # The grammar gives this node no field names, so position is the
            # only way to tell the test from the two branches: the named
            # children are [consequence, condition, alternative].
            named = parent.named_children
            if len(named) == 3 and child.id == named[1].id:
                return None
            return "ternary"

        if kind in _COMPREHENSIONS:
            if not _is_field(parent, child, "body"):
                return None  # a for-in clause's iterable, or a filter test
            # A comprehension body runs once per item, so it may not run at
            # all; a filter narrows that further.
            filtered = any(c.type == "if_clause" for c in parent.children)
            return "comprehension:if" if filtered else "comprehension"
        if kind == "if_clause":
            # Inside the filter itself: evaluated per item, but nothing about
            # the filter guards it.
            return "comprehension:test"

        if kind == "lambda":
            return "lambda" if _is_field(parent, child, "body") else None
        if kind == "assert_statement":
            return "assert"
        if kind == "decorator":
            return "decorator"
        return None

    def _is_type_checking(self, if_node: Node) -> bool:
        """Whether this is an ``if TYPE_CHECKING:`` block.

        Text matching rather than resolution: the name is a convention rather
        than a semantic the parser can check, and both ``TYPE_CHECKING`` and
        ``typing.TYPE_CHECKING`` are written in the wild.
        """
        condition = if_node.child_by_field_name("condition")
        return condition is not None and "TYPE_CHECKING" in self.text(condition)

    @staticmethod
    def _enclosing_symbol(
        byte: int, symbols: Sequence[SymbolDef], starts: Sequence[int]
    ) -> str | None:
        """Innermost definition containing ``byte``, or None at module level."""
        index = bisect_right(starts, byte) - 1
        while index >= 0:
            candidate = symbols[index]
            if candidate.end_byte > byte:
                return candidate.symbol_id
            index -= 1
        return None
