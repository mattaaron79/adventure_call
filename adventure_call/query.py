"""Queries over a written analysis: the web views, as JSON for agents (tic-5671).

The web app derives its views -- fs-tree, sunburst, import graph, call flow --
in TypeScript over ``codebase_graph.json`` and ``symbol_registry.json``.  An
agent driving the CLI has no browser, so this module ports the derivations
those views stand on and answers the same questions as plain data:

==================  =====================================================
web view            here
==================  =====================================================
fs-tree / sunburst  :meth:`Workspace.tree` (sized by symbols/lines/files)
file detail rows    :meth:`Workspace.file`
import graph        :meth:`Workspace.imports` (whole graph or local view)
call flow overview  :meth:`Workspace.entries`
call flow rooted    :meth:`Workspace.calls`
inspector           :meth:`Workspace.symbol`
variable impact     :meth:`Workspace.impact`, :meth:`Workspace.state`
==================  =====================================================

The TypeScript modules under ``web/src/data`` hold the reasoning behind every
rule (why classes join the call graph only by taking part in a call, why an
entry point is not the same as in-degree zero, why a cone is two walks and not
one).  This port keeps their semantics and does not repeat the essays.

Output is shaped for a reader paying per token: no nulls, no empty lists,
locations as ``path:line`` strings, neighbours as ``"ID path:line"`` strings.
Everything returned is JSON-serialisable.
"""

from __future__ import annotations

import ast
import difflib
import fnmatch
import json
import re
from functools import cached_property
from pathlib import Path
from typing import Any, Callable, Iterable

from adventure_call.languages import GrammarUnavailable, load_language, spec_for_path
from adventure_call.writer import GRAPH_FILENAME, REGISTRY_FILENAME

#: Kinds that can sit at either end of a call edge.  Classes are here because
#: the exporter resolves ``Foo()`` to the class (web/src/data/derive.ts).
_CALL_KINDS = frozenset({"function", "method", "class"})
_CALLABLE_KINDS = frozenset({"function", "method"})
_STATE_KINDS = frozenset({"variable", "attribute"})

#: The most components a rooted call cone draws (callFlow.ts ROOTED_BUDGET).
CONE_BUDGET = 80
#: The most symbols a closure walk collects (dataFlow.ts CLOSURE_BUDGET).
CLOSURE_BUDGET = 200

# -- framework roles (web/src/data/roles.ts) ---------------------------------

_TEST_FILE = r"(^|/)tests?/|(^|/)test_[^/]*$|_test\.[^/]*$|(^|/)tests?([-_]v\d+)?\.[^/]*$"
_TEST_FILE_RE = re.compile(_TEST_FILE)

#: (role, decorator, name regex, file regex); every declared field must match.
ROLE_RULES: tuple[tuple[str, str | None, str | None, str | None], ...] = (
    ("test", None, r"^test_", _TEST_FILE),
    ("fixture", "pytest.fixture", None, None),
    ("fixture", None, r"^(setup|teardown)(_module|_function|_class|_method)?$", _TEST_FILE),
    ("fixture", None, r"^(setUp|tearDown)(Class|Module)?$", _TEST_FILE),
    ("dunder", None, r"^__[a-z0-9_]+__$", None),
    ("property", "property", None, None),
    ("property", "cached_property", None, None),
    *(("route", f"{obj}.{verb}", None, None) for obj, verb in (
        ("app", "route"), ("router", "get"), ("router", "post"), ("router", "put"),
        ("router", "delete"), ("app", "get"), ("app", "post"), ("app", "put"),
        ("app", "patch"), ("app", "delete"), ("app", "websocket"), ("app", "middleware"),
    )),
    ("command", "click.command", None, None),
    ("command", "click.group", None, None),
    ("command", "app.command", None, None),
    ("handler", "on", None, None),
    ("task", "work", None, None),
    ("task", "app.task", None, None),
    ("task", "shared_task", None, None),
)


def is_test_path(path: str) -> bool:
    """Whether a test runner collects from this root-relative path."""
    return bool(_TEST_FILE_RE.search(path))


def _decorator_head(decorator: str) -> str:
    return decorator.strip().lstrip("@").split("(")[0].strip()


def match_role(node: dict[str, Any]) -> tuple[str, str] | None:
    """The first framework rule matching a symbol, as ``(role, reason)``."""
    name, path = node.get("name", ""), node.get("file_path", "")
    heads = [_decorator_head(d) for d in node.get("decorators") or []]
    for role, decorator, name_re, file_re in ROLE_RULES:
        if name_re is not None and not re.search(name_re, name):
            continue
        if file_re is not None and not re.search(file_re, path):
            continue
        if decorator is None:
            return role, f"name matches /{name_re}/"
        bare = decorator.rsplit(".", 1)[-1]
        for head in heads:
            if head == decorator or (bare != decorator and head == bare):
                return role, f"@{head}"
    return None


# -- effects (web/src/data/effects.ts) ----------------------------------------

EFFECT_KINDS = ("filesystem", "network", "process", "env", "console", "nondeterminism")
EFFECT_RULES: tuple[tuple[str, str], ...] = (
    ("open", "filesystem"), ("pathlib", "filesystem"), ("shutil", "filesystem"),
    ("socket", "network"), ("requests", "network"), ("httpx", "network"),
    ("urllib", "network"), ("subprocess", "process"), ("os.environ", "env"),
    ("print", "console"), ("logging", "console"), ("random", "nondeterminism"),
    ("time", "nondeterminism"), ("datetime.datetime", "nondeterminism"),
    ("datetime.now", "nondeterminism"),
)
_EXTERNAL = "external: "


def effects_for_target(target: str) -> int:
    """Effect kinds of one external dotted target, as a bitmask."""
    mask = 0
    for prefix, kind in EFFECT_RULES:
        if target == prefix or target.startswith(prefix + "."):
            mask |= 1 << EFFECT_KINDS.index(kind)
    return mask


def _effect_names(mask: int) -> list[str]:
    return [kind for bit, kind in enumerate(EFFECT_KINDS) if mask >> bit & 1]


# -- errors -------------------------------------------------------------------


class QueryError(Exception):
    """A query that cannot be answered; carries a JSON-ready payload."""

    exit_code = 1

    def __init__(self, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.payload = {"error": message, **{k: v for k, v in extra.items() if v}}


class NotFound(QueryError):
    exit_code = 2


# -- graph algorithms ---------------------------------------------------------


def strongly_connected(adjacency: dict[str, list[str]]) -> tuple[dict[str, int], list[list[str]]]:
    """Iterative Tarjan.  Component ids come out in reverse topological order
    (a callee's component id is lower than its caller's), which the bottom-up
    passes below rely on, exactly as derive.ts documents."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    component_of: dict[str, int] = {}
    members: list[list[str]] = []
    counter = 0

    for start in adjacency:
        if start in index:
            continue
        work: list[tuple[str, Iterable[str]]] = [(start, iter(adjacency[start]))]
        index[start] = low[start] = counter
        counter += 1
        stack.append(start)
        on_stack.add(start)
        while work:
            node, children = work[-1]
            advanced = False
            for child in children:
                if child not in index:
                    index[child] = low[child] = counter
                    counter += 1
                    stack.append(child)
                    on_stack.add(child)
                    work.append((child, iter(adjacency.get(child, ()))))
                    advanced = True
                    break
                if child in on_stack:
                    low[node] = min(low[node], index[child])
            if advanced:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] == index[node]:
                group: list[str] = []
                while True:
                    member = stack.pop()
                    on_stack.discard(member)
                    component_of[member] = len(members)
                    group.append(member)
                    if member == node:
                        break
                members.append(group)
    return component_of, members


def closure(seeds: Iterable[str], step: Callable[[str], Iterable[str]], budget: int) -> tuple[list[str], dict[str, int], bool]:
    """Breadth-first closure: (reached in order, hop per reached id, truncated)."""
    seen = set(seeds)
    frontier = list(seen)
    reached: list[str] = []
    hops: dict[str, int] = {}
    hop = 0
    while frontier:
        hop += 1
        nxt: list[str] = []
        for node in frontier:
            for target in step(node):
                if target in seen:
                    continue
                if len(reached) >= budget:
                    return reached, hops, True
                seen.add(target)
                reached.append(target)
                hops[target] = hop
                nxt.append(target)
        frontier = nxt
    return reached, hops, False


# -- the workspace ------------------------------------------------------------


class Workspace:
    """A loaded analysis plus every derivation the queries need, built lazily.

    Args:
        graph: The parsed ``codebase_graph.json`` payload.
        registry_path: ``symbol_registry.json``; read only by the queries that
            need unresolved calls, externals or effects.
    """

    def __init__(self, graph: dict[str, Any], registry_path: Path | None = None) -> None:
        self.meta: dict[str, Any] = graph.get("graph", {})
        self.nodes: dict[str, dict[str, Any]] = {n["id"]: n for n in graph.get("nodes", [])}
        self.edges: list[dict[str, Any]] = graph.get("edges", [])
        self.registry_path = registry_path

    @classmethod
    def load(cls, directory: Path | str) -> "Workspace":
        directory = Path(directory)
        graph_path = directory / GRAPH_FILENAME
        if not graph_path.is_file():
            raise QueryError(f"no analysis at {graph_path}")
        with graph_path.open(encoding="utf-8") as handle:
            graph = json.load(handle)
        return cls(graph, directory / REGISTRY_FILENAME)

    @cached_property
    def registry(self) -> dict[str, Any]:
        if self.registry_path is None or not self.registry_path.is_file():
            return {}
        with self.registry_path.open(encoding="utf-8") as handle:
            return json.load(handle)

    @property
    def root(self) -> Path:
        return Path(self.meta.get("root_abs") or self.meta.get("root") or ".")

    # -- indexes -------------------------------------------------------------

    @cached_property
    def module_of_file(self) -> dict[str, str]:
        return {n["file_path"]: n["id"] for n in self.nodes.values() if n["kind"] == "module"}

    @cached_property
    def by_module(self) -> dict[str, list[dict[str, Any]]]:
        out: dict[str, list[dict[str, Any]]] = {}
        for node in self.nodes.values():
            if node["kind"] not in ("module", "external"):
                out.setdefault(node["module"], []).append(node)
        for bucket in out.values():
            bucket.sort(key=lambda n: n.get("start_line", 0))
        return out

    @cached_property
    def by_parent(self) -> dict[str, list[dict[str, Any]]]:
        out: dict[str, list[dict[str, Any]]] = {}
        for node in self.nodes.values():
            if node.get("parent"):
                out.setdefault(node["parent"], []).append(node)
        for bucket in out.values():
            bucket.sort(key=lambda n: n.get("start_line", 0))
        return out

    def file_of(self, node_id: str) -> str | None:
        node = self.nodes.get(node_id)
        if node is None:
            return None
        module = self.nodes.get(node.get("module", ""))
        if module is not None and module["kind"] == "module":
            return module["file_path"]
        return node.get("file_path") or None

    def _typed(self, edge_type: str) -> Iterable[dict[str, Any]]:
        return (e for e in self.edges if edge_type in (e.get("types") or [e.get("type")]))

    # -- file imports (derive.ts deriveFileImports) --------------------------

    @cached_property
    def file_imports(self) -> dict[tuple[str, str], list[str]]:
        """(importer file, imported file) -> imported symbol ids."""
        out: dict[tuple[str, str], list[str]] = {}
        for edge in self._typed("IMPORTS"):
            source, target = self.file_of(edge["source"]), self.file_of(edge["target"])
            if source is None or target is None or source == target:
                continue
            bucket = out.setdefault((source, target), [])
            if edge["target"] not in bucket:
                bucket.append(edge["target"])
        return out

    @cached_property
    def imports_of(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for source, target in self.file_imports:
            out.setdefault(source, []).append(target)
        return out

    @cached_property
    def importers_of(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for source, target in self.file_imports:
            out.setdefault(target, []).append(source)
        return out

    @cached_property
    def import_cycles(self) -> list[list[str]]:
        adjacency = {f: [] for f in self.module_of_file}
        for source, target in self.file_imports:
            adjacency.setdefault(source, []).append(target)
        _, members = strongly_connected(adjacency)
        return [sorted(group) for group in members if len(group) > 1]

    # -- call graph (derive.ts deriveCallGraph) ------------------------------

    @cached_property
    def call_graph(self) -> "CallGraph":
        return CallGraph(self)

    # -- references and accesses ---------------------------------------------

    def _pairs(self, edge_type: str) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
        forward: dict[str, list[str]] = {}
        backward: dict[str, list[str]] = {}
        for edge in self._typed(edge_type):
            s, t = edge["source"], edge["target"]
            if s == t or s not in self.nodes or t not in self.nodes:
                continue
            forward.setdefault(s, []).append(t)
            backward.setdefault(t, []).append(s)
        return forward, backward

    @cached_property
    def references(self) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
        """(referrer -> named, named -> referrers)."""
        return self._pairs("REFERENCES")

    @cached_property
    def reads(self) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
        """(reader -> variables, variable -> readers)."""
        return self._pairs("READS")

    @cached_property
    def writes(self) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
        """(writer -> variables, variable -> writers)."""
        return self._pairs("WRITES")

    # -- registry-backed -----------------------------------------------------

    @cached_property
    def unresolved_by_caller(self) -> dict[str, list[dict[str, Any]]]:
        out: dict[str, list[dict[str, Any]]] = {}
        for call in self.registry.get("unresolved_calls", []):
            out.setdefault(call["caller_id"], []).append(call)
        return out

    @cached_property
    def effects(self) -> dict[str, int]:
        """Call-graph node -> transitive effect bitmask (effects.ts)."""
        graph = self.call_graph
        direct: dict[str, int] = {}
        for caller, calls in self.unresolved_by_caller.items():
            if caller not in graph.component_of:
                continue
            for call in calls:
                reason = call.get("reason") or ""
                if reason.startswith(_EXTERNAL):
                    direct[caller] = direct.get(caller, 0) | effects_for_target(reason[len(_EXTERNAL):])
        per_component: list[int] = []
        for cid, members in enumerate(graph.members):
            mask = 0
            for member in members:
                mask |= direct.get(member, 0)
            for callee in graph.condensed[cid]:
                mask |= per_component[callee]
            per_component.append(mask)
        return {node: per_component[cid] for node, cid in graph.component_of.items()}

    def external_imports(self, file_path: str) -> list[str]:
        module = self.module_of_file.get(file_path)
        bindings = self.registry.get("bindings", {}).get(module or "", {})
        return sorted({b["target"] for b in bindings.values() if b.get("kind") == "external"})

    # -- formatting ----------------------------------------------------------

    def loc(self, node_id: str, *, span: bool = False) -> str:
        node = self.nodes.get(node_id)
        if node is None:
            return ""
        path = node.get("file_path", "")
        start, end = node.get("start_line", 0), node.get("end_line", 0)
        if node["kind"] == "module":
            return path
        if span and end and end != start:
            return f"{path}:{start}-{end}"
        return f"{path}:{start}"

    def ref(self, node_id: str, line: int | None = None) -> str:
        """The compact neighbour form: ``"ID path:line"``."""
        if line is not None:
            path = self.nodes.get(node_id, {}).get("file_path", "")
            return f"{node_id} {path}:{line}"
        return f"{node_id} {self.loc(node_id)}".rstrip()

    # -- id resolution -------------------------------------------------------

    def resolve(self, ref: str, *, kinds: Iterable[str] | None = None) -> str:
        """Turn what an agent typed into a node id.

        Tries, in order: an exact id; a file path (root-relative, ./-prefixed
        or absolute) meaning its module; ``path:LINE`` meaning the innermost
        symbol defined over that line; a unique dotted-suffix or bare name.
        Raises :class:`NotFound` with candidates otherwise.
        """
        wanted = set(kinds) if kinds else None
        ok = (lambda node_id: wanted is None or self.nodes[node_id]["kind"] in wanted)
        ref = ref.strip()
        if ref in self.nodes and ok(ref):
            return ref

        path_ref, line = ref, None
        match = re.match(r"^(.*?):(\d+)$", ref)
        if match:
            path_ref, line = match.group(1), int(match.group(2))
        file_path = self.normalise_path(path_ref)
        if file_path is not None:
            module = self.module_of_file[file_path]
            if line is None:
                if ok(module):
                    return module
            else:
                hits = [
                    n for n in self.by_module.get(module, [])
                    if n["start_line"] <= line <= n["end_line"] and ok(n["id"])
                ]
                if hits:
                    return min(hits, key=lambda n: (n["end_line"] - n["start_line"], -n["start_line"]))["id"]
                if ok(module):
                    return module
            raise NotFound(f"nothing matching {ref!r} in {file_path}")

        suffix = "." + ref
        matches = sorted(
            node_id for node_id, node in self.nodes.items()
            if (node_id.endswith(suffix) or node.get("name") == ref) and ok(node_id)
        )
        if len(matches) == 1:
            return matches[0]
        if matches:
            raise QueryError(f"{ref!r} is ambiguous", candidates=[self.ref(m) for m in matches[:20]])
        close = difflib.get_close_matches(ref, [i for i in self.nodes if ok(i)], n=5, cutoff=0.5)
        raise NotFound(f"{ref!r} not found", did_you_mean=close)

    def normalise_path(self, text: str) -> str | None:
        """A root-relative file path in this analysis, or None."""
        if not text:
            return None
        candidate = text.replace("\\", "/")
        if candidate in self.module_of_file:
            return candidate
        try:
            absolute = Path(text).expanduser().resolve()
            rel = absolute.relative_to(self.root.resolve()).as_posix()
        except (ValueError, OSError):
            rel = candidate.removeprefix("./")
        return rel if rel in self.module_of_file else None

    # == queries =============================================================

    def find(self, pattern: str, *, kind: str | None = None, regex: bool = False, limit: int = 30) -> dict[str, Any]:
        """Symbols and files whose id, name or path match ``pattern``."""
        if regex:
            try:
                rx = re.compile(pattern, re.IGNORECASE)
            except re.error as exc:
                raise QueryError(f"bad regex: {exc}") from None
            test = lambda text: bool(rx.search(text))  # noqa: E731
        else:
            low = pattern.lower()
            test = lambda text: low in text.lower()  # noqa: E731
        kinds = set(kind.split(",")) if kind else None
        hits = []
        for node_id, node in self.nodes.items():
            if kinds and node["kind"] not in kinds:
                continue
            if node["kind"] == "external":
                continue
            haystack = node.get("file_path", "") if node["kind"] == "module" else node_id
            if test(haystack) or test(node.get("name", "")):
                name = node.get("name", "").lower()
                score = (name != pattern.lower(), not name.startswith(pattern.lower()), len(node_id))
                hits.append((score, node_id))
        hits.sort()
        if not hits:
            raise NotFound(f"nothing matches {pattern!r}")
        out: dict[str, Any] = {
            "matches": [f"{i} {self.nodes[i]['kind']} {self.loc(i)}" for _, i in hits[:limit]]
        }
        if len(hits) > limit:
            out["total"] = len(hits)
        return out

    def refs(self, name: str, *, kinds: str = "all", match: str = "exact", path: str | None = None, limit: int = 100) -> dict[str, Any]:
        """Current syntactic occurrences, grouped by file.

        This is deliberately structured grep, rather than type inference: an
        attribute hit tells us its spelling and enclosing symbol, not that
        every receiver has the same type. Files are read at query time so the
        answer follows the working tree even before a store refresh.
        """
        selected = set(kinds.split(","))
        if "all" in selected:
            selected = {"attr", "name", "string"}
        invalid = selected - {"attr", "name", "string"}
        if invalid:
            raise QueryError(f"unknown ref kind(s): {', '.join(sorted(invalid))}")
        if match not in {"exact", "substring", "regex"}:
            raise QueryError("match must be exact, substring or regex")
        if limit < 1:
            raise QueryError("limit must be at least 1")
        if match == "regex":
            try:
                matcher = re.compile(name, re.IGNORECASE).search
            except re.error as exc:
                raise QueryError(f"bad regex: {exc}") from None
        elif match == "substring":
            needle = name.lower()
            matcher = lambda text: needle in text.lower()
        else:
            matcher = lambda text: text == name

        records: list[tuple[str, int, str]] = []
        for file_path, module_id in sorted(self.module_of_file.items()):
            if path and not fnmatch.fnmatch(file_path, path):
                continue
            spec = spec_for_path(file_path)
            if spec is None:
                continue
            try:
                source = (self.root / file_path).read_bytes()
                tree = load_language(spec).parser.parse(source)
            except (OSError, GrammarUnavailable):
                continue
            for node in _walk_nodes(tree.root_node):
                if node.type == "attribute" and "attr" in selected:
                    attribute = node.child_by_field_name("attribute")
                    text = _node_text(source, attribute)
                    if text and matcher(text):
                        owner = self._enclosing_symbol(module_id, node.start_point.row + 1)
                        mode = _attribute_mode(node)
                        exact = any(
                            edge["source"] == owner and edge["target"].rsplit(".", 1)[-1] == text
                            for kind in ("READS", "WRITES") for edge in self._typed(kind)
                        )
                        label = f"L{node.start_point.row + 1} {mode}{' exact' if exact else ''} {owner}"
                        records.append((file_path, node.start_point.row + 1, label))
                elif node.type == "identifier" and "name" in selected and node.parent and node.parent.type != "attribute":
                    text = _node_text(source, node)
                    if text and matcher(text):
                        owner = self._enclosing_symbol(module_id, node.start_point.row + 1)
                        records.append((file_path, node.start_point.row + 1, f"L{node.start_point.row + 1} r {owner}"))
                elif node.type == "string" and "string" in selected:
                    text = _string_value(_node_text(source, node))
                    if text is not None and matcher(text):
                        owner = self._enclosing_symbol(module_id, node.start_point.row + 1)
                        snippet = text.replace("\n", " ").strip()
                        if len(snippet) > 80:
                            snippet = snippet[:77] + "..."
                        records.append((file_path, node.start_point.row + 1, f"L{node.start_point.row + 1} r {owner} {snippet!r}"))

        records.sort()
        hits: dict[str, list[str]] = {}
        for file_path, _, label in records[:limit]:
            hits.setdefault(file_path, []).append(label)
        out: dict[str, Any] = {"name": name, "total": len(records), "hits": hits}
        if len(records) > limit:
            out["_more"] = len(records) - limit
        return out

    def _enclosing_symbol(self, module_id: str, line: int) -> str:
        """The innermost callable or class owning a current source line."""
        hits = [node for node in self.by_module.get(module_id, []) if node["kind"] in _CALL_KINDS and node["start_line"] <= line <= node["end_line"]]
        if not hits:
            return module_id
        return min(hits, key=lambda node: (node["end_line"] - node["start_line"], -node["start_line"]))["id"]

    def symbol(self, ref: str, *, code: bool = False, full_doc: bool = False, limit: int = 25) -> dict[str, Any]:
        """Everything the inspector knows about one symbol, one hop out."""
        node_id = self.resolve(ref)
        node = self.nodes[node_id]
        if node["kind"] == "module":
            return self.file(node["file_path"])
        graph = self.call_graph
        out: dict[str, Any] = {
            "id": node_id,
            "kind": node["kind"],
            "at": self.loc(node_id, span=True),
            "sig": node.get("signature"),
        }
        doc = node.get("docstring")
        if doc:
            out["doc"] = doc if full_doc else _first_paragraph(doc)
        for key in ("decorators", "bases"):
            if node.get(key):
                out[key] = node[key]
        if node.get("parent"):
            out["parent"] = node["parent"]

        members = self.by_parent.get(node_id, [])
        if members:
            out["members"] = [f"{m['name']} {m['kind']} L{m['start_line']}" for m in members]

        if node_id in graph.component_of:
            role = graph.roles[node_id]
            out["role"] = role[0] + (f" ({role[1]})" if role[1] else "")
            m = graph.metrics(node_id)
            out["metrics"] = m
            callers = [
                self.ref(e["source"], e["lines"][0] if e.get("lines") else None) + _conf(e)
                for e in graph.callers.get(node_id, []) if not e.get("implicit")
            ]
            module_callers = [
                f"{self.nodes[e['source']]['file_path']}:{line}"
                for e in graph.module_callers.get(node_id, [])
                for line in (e.get("lines") or [None])
            ]
            callees = [self.ref(e["target"]) + _conf(e) for e in graph.callees.get(node_id, [])]
            _put_list(out, "callers", callers, limit)
            _put_list(out, "module_callers", module_callers, limit)
            _put_list(out, "callees", callees, limit)
            if graph.recursive_of(node_id):
                out["recursion"] = graph.recursive_of(node_id)
            if self.registry:
                effects = _effect_names(self.effects.get(node_id, 0))
                if effects:
                    out["effects"] = effects
        elif node.get("complexity") and node["kind"] in _CALLABLE_KINDS:
            out["metrics"] = {"complexity": node.get("complexity"), "lines": node.get("line_count")}

        _put_list(out, "referenced_by", [self.ref(i) for i in self.references[1].get(node_id, [])], limit)
        _put_list(out, "reads", self.reads[0].get(node_id, []), limit)
        _put_list(out, "writes", self.writes[0].get(node_id, []), limit)
        if node["kind"] in _STATE_KINDS:
            _put_list(out, "read_by", [self.ref(i) for i in self.reads[1].get(node_id, [])], limit)
            _put_list(out, "written_by", [self.ref(i) for i in self.writes[1].get(node_id, [])], limit)

        if self.registry and node["kind"] in _CALL_KINDS:
            external, unresolved = set(), []
            for call in self.unresolved_by_caller.get(node_id, []):
                reason = call.get("reason") or "unresolved"
                if reason.startswith(_EXTERNAL):
                    external.add(reason[len(_EXTERNAL):])
                else:
                    unresolved.append(f"{call['raw_name']} L{call['line']}: {reason}")
            _put_list(out, "external_calls", sorted(external), limit)
            _put_list(out, "unresolved", unresolved, limit)
        if code:
            out["code"] = self.source_of(node_id)
        return out

    def file(self, ref: str, *, limit: int = 60) -> dict[str, Any]:
        """A file's detail rows: import relationships and an outline."""
        path = self.normalise_path(ref)
        if path is None:
            node_id = self.resolve(ref)
            path = self.file_of(node_id)
            if path is None:
                raise NotFound(f"{ref!r} is not a file in this analysis")
        module = self.module_of_file[path]
        node = self.nodes[module]
        out: dict[str, Any] = {"file": path, "module": module}
        if node.get("docstring"):
            out["doc"] = _first_paragraph(node["docstring"])
        _put_list(out, "imported_by", sorted(self.importers_of.get(path, [])), limit)
        imports = {
            target: [s.rsplit(".", 1)[-1] for s in self.file_imports[(path, target)]]
            for target in sorted(self.imports_of.get(path, []))
        }
        if imports:
            out["imports"] = imports
        if self.registry:
            _put_list(out, "external", self.external_imports(path), limit)
        outline = []
        for symbol in self.by_module.get(module, []):
            if symbol.get("parent") and self.nodes.get(symbol["parent"], {}).get("kind") != "class":
                continue  # nested functions: reachable through `symbol`
            indent = "  " if symbol.get("parent") else ""
            outline.append(f"{indent}L{_span(symbol)} {_outline_label(symbol)}")
        if outline:
            out["outline"] = outline
        cycle = next((c for c in self.import_cycles if path in c), None)
        if cycle:
            out["import_cycle"] = cycle
        return out

    def tree(self, directory: str = "", *, depth: int = 2, metric: str = "symbols") -> dict[str, Any]:
        """The directory tree sized by ``metric`` (fs-tree + sunburst)."""
        if metric not in ("symbols", "lines", "files"):
            raise QueryError(f"unknown metric {metric!r}; use symbols, lines or files")
        prefix = self._dir_prefix(directory)
        root: dict[str, Any] = {}
        matched = False
        for path, module in self.module_of_file.items():
            if prefix and not (path == prefix or path.startswith(prefix + "/")):
                continue
            matched = True
            rel = path[len(prefix):].lstrip("/") if prefix else path
            parts = rel.split("/") if rel else [path.rsplit("/", 1)[-1]]
            here = root
            for segment in parts[:-1]:
                here = here.setdefault(segment + "/", {})
            here[parts[-1]] = self._file_value(module, metric)
        if not matched:
            raise NotFound(f"no analysed files under {directory!r}")

        def fold(tree: dict[str, Any], level: int) -> tuple[Any, int]:
            total = 0
            folded: dict[str, Any] = {}
            for key in sorted(tree, key=lambda k: (not k.endswith("/"), k)):
                value = tree[key]
                if isinstance(value, dict):
                    sub, subtotal = fold(value, level + 1)
                    folded[key] = sub if level < depth else subtotal
                    total += subtotal
                else:
                    folded[key] = value
                    total += value
            if level <= depth:
                folded = {"_total": total, **folded}
            return folded, total

        body, total = fold(root, 1)
        return {"root": prefix or ".", "metric": metric, "tree": body}

    def _dir_prefix(self, directory: str) -> str:
        """A root-relative directory prefix: as typed if files live under it,
        else resolved against the current directory."""
        typed = directory.replace("\\", "/").strip("/").removeprefix("./")
        if typed in ("", "."):
            return ""
        if not Path(directory).is_absolute() and any(
            p == typed or p.startswith(typed + "/") for p in self.module_of_file
        ):
            return typed
        try:
            rel = Path(directory).expanduser().resolve().relative_to(self.root.resolve()).as_posix()
        except (ValueError, OSError):
            return typed
        return "" if rel == "." else rel

    def _file_value(self, module: str, metric: str) -> int:
        if metric == "files":
            return 1
        symbols = self.by_module.get(module, [])
        if metric == "symbols":
            return len(symbols)
        return max((s.get("end_line", 0) for s in symbols), default=0)

    def imports(self, ref: str | None = None, *, depth: int = 1, direction: str = "both", symbols: bool = False, limit: int = 400) -> dict[str, Any]:
        """The import graph, whole or as a local view around one file."""
        if ref is None:
            pairs = sorted(self.file_imports)
            out: dict[str, Any] = {"files": len(self.module_of_file), "edge_count": len(pairs)}
            out["edges"] = [self._import_edge(s, t, symbols) for s, t in pairs[:limit]]
            if len(pairs) > limit:
                out["truncated"] = len(pairs) - limit
            if self.import_cycles:
                out["cycles"] = self.import_cycles
            return out

        path = self.normalise_path(ref) or self.file_of(self.resolve(ref))
        if path is None:
            raise NotFound(f"{ref!r} is not a file in this analysis")
        _check_direction(direction, ("in", "out", "both"))
        out = {"centre": path, "depth": depth}
        shown = {path}
        if direction in ("out", "both"):
            reached, hops, _ = closure([path], lambda f: self.imports_of.get(f, []), 10**9)
            reached = [f for f in reached if hops[f] <= depth]
            out["imports"] = {f: hops[f] for f in reached}
            shown.update(reached)
        if direction in ("in", "both"):
            reached, hops, _ = closure([path], lambda f: self.importers_of.get(f, []), 10**9)
            reached = [f for f in reached if hops[f] <= depth]
            out["imported_by"] = {f: hops[f] for f in reached}
            shown.update(reached)
        edges = [(s, t) for (s, t) in sorted(self.file_imports) if s in shown and t in shown]
        out["edges"] = [self._import_edge(s, t, symbols) for s, t in edges[:limit]]
        if len(edges) > limit:
            out["truncated"] = len(edges) - limit
        cycles = [c for c in self.import_cycles if shown.intersection(c)]
        if cycles:
            out["cycles"] = cycles
        return {k: v for k, v in out.items() if v != {}}

    def _import_edge(self, source: str, target: str, symbols: bool) -> str:
        text = f"{source} -> {target}"
        if symbols:
            names = ",".join(s.rsplit(".", 1)[-1] for s in self.file_imports[(source, target)])
            text += f" [{names}]"
        return text

    def entries(self, *, limit: int = 20, include_tests: bool = False) -> dict[str, Any]:
        """Where execution enters the codebase, most far-reaching first."""
        graph = self.call_graph
        eligible = [
            i for i in graph.entries
            if include_tests or not is_test_path(self.nodes[i].get("file_path", ""))
        ]
        best: dict[int, tuple[int, str]] = {}
        for node_id in eligible:
            cid = graph.component_of[node_id]
            reach = graph.reach_down(node_id)
            if cid not in best or reach > best[cid][0]:
                best[cid] = (reach, node_id)
        ranked = sorted(best.values(), key=lambda item: (-item[0], item[1]))
        rows = []
        for reach, node_id in ranked[:limit]:
            role, reason = graph.roles[node_id]
            label = role if role == "entry" else f"{role}: {reason}"
            rows.append(f"{node_id} {self.loc(node_id)} reach={reach} {label}")
        out: dict[str, Any] = {"entries": rows, "shown": len(rows), "total": len(ranked)}
        hidden = len(graph.entries) - len(eligible)
        if hidden:
            out["hidden_tests"] = hidden
        out["orphans"] = len(graph.orphans)
        return out

    def calls(self, ref: str, *, depth: int = 2, direction: str = "down", externals: bool = False, budget: int = CONE_BUDGET) -> dict[str, Any]:
        """The rooted call-flow view: two cones from one symbol (callFlow.ts coneOf)."""
        _check_direction(direction, ("down", "up", "both"))
        graph = self.call_graph
        node_id = self.resolve(ref, kinds=_CALL_KINDS)
        if node_id not in graph.component_of:
            raise NotFound(f"{node_id} takes part in no call (kind {self.nodes[node_id]['kind']})")
        root = graph.component_of[node_id]
        cone = graph.cone(root, direction, max(0, depth), budget)

        drawn: set[str] = set()
        for cid in cone["components"]:
            drawn.update(graph.members[cid])
        nodes: dict[str, str] = {}
        for cid, hop in sorted(cone["depth"].items(), key=lambda item: (abs(item[1]), item[1])):
            for member in sorted(graph.members[cid]):
                nodes[member] = f"{hop:+d} {self.loc(member)}" if hop else f"0 {self.loc(member)}"
        edges = [
            f"{s} -> {t}" + (" (constructs)" if e.get("implicit") else "")
            for s in sorted(drawn)
            for e in graph.callees.get(s, [])
            if (t := e["target"]) in drawn and t != s
        ]
        out: dict[str, Any] = {"root": node_id, "direction": direction, "depth": depth, "nodes": nodes}
        if edges:
            out["edges"] = edges
        cycles = [sorted(graph.members[c]) for c in cone["components"] if len(graph.members[c]) > 1]
        if cycles:
            out["cycles"] = cycles
        recursive = sorted(i for i in drawn if i in graph.recursive)
        if recursive:
            out["self_recursive"] = recursive
        if cone["beyond"]:
            out["beyond"] = cone["beyond"]
        if cone["truncated"]:
            out["truncated"] = True
        if externals and self.registry:
            ext = {}
            for member in sorted(drawn):
                targets = sorted({
                    (c.get("reason") or "")[len(_EXTERNAL):].split(".")[0]
                    for c in self.unresolved_by_caller.get(member, [])
                    if (c.get("reason") or "").startswith(_EXTERNAL)
                })
                if targets:
                    ext[member] = targets
            if ext:
                out["externals"] = ext
        return out

    def impact(self, ref: str, *, budget: int = CLOSURE_BUDGET, full: bool = False) -> dict[str, Any]:
        """What is affected if this changes: transitive callers, readers or importers.

        The transitive set is a count unless ``full``: the file lists already
        say where to look, and the ids are most of the bytes."""
        node_id = self.resolve(ref)
        node = self.nodes[node_id]
        graph = self.call_graph
        out: dict[str, Any] = {"target": node_id, "kind": node["kind"]}
        callers_step = graph.callers_step

        if node["kind"] == "module":
            path = node["file_path"]
            reached, hops, truncated = closure([path], lambda f: self.importers_of.get(f, []), budget)
            out["target"] = path
            importers = {f: hops[f] for f in reached if not is_test_path(f)}
            if importers:
                out["importers"] = importers
            _put_list(out, "test_importers", sorted(f for f in reached if is_test_path(f)), budget)
            if truncated:
                out["truncated"] = True
            return out
        if node["kind"] in _STATE_KINDS:
            readers = self.reads[1].get(node_id, [])
            writers = self.writes[1].get(node_id, [])
            direct = list(dict.fromkeys([*readers, *writers]))
            reached, _, truncated = closure(direct, callers_step, budget)
            _put_list(out, "readers", [self.ref(i) for i in readers], budget)
            _put_list(out, "writers", [self.ref(i) for i in writers], budget)
            _put_many(out, "reached_via_calls", reached, full)
            files = sorted({self.file_of(i) or "" for i in [*direct, *reached]} - {""})
        else:
            seeds = [node_id]
            if node["kind"] == "class":
                seeds += [m["id"] for m in self.by_parent.get(node_id, []) if m["id"] in graph.component_of]
            referrers = self.references[1].get(node_id, [])
            reached, hops, truncated = closure(seeds, callers_step, budget)
            # Call sites, not definitions: the lines to edit when a signature changes.
            sites = [
                self.ref(e["source"], line) + _conf(e)
                for seed in seeds
                for e in graph.callers.get(seed, [])
                if not e.get("implicit") and e["source"] not in seeds
                for line in (e.get("lines") or [None])
            ]
            module_sites = [
                f"{e['source']} {self.nodes[e['source']]['file_path']}:{line} (module)"
                for seed in seeds
                for e in graph.module_callers.get(seed, [])
                for line in (e.get("lines") or [None])
            ]
            _put_list(out, "direct_callers", list(dict.fromkeys([*sites, *module_sites])), budget)
            _put_many(out, "transitive_callers", [i for i in reached if hops[i] > 1], full)
            _put_list(out, "referenced_by", [self.ref(i) for i in referrers], budget)
            files = sorted(
                {self.file_of(i) or "" for i in [*reached, *referrers]}
                | {self.nodes[e["source"]]["file_path"] for e in graph.module_callers.get(node_id, [])}
                - {""}
            )

        tests = [f for f in files if is_test_path(f)]
        _put_list(out, "files", [f for f in files if not is_test_path(f)], budget)
        _put_list(out, "test_files", tests, budget)
        if truncated:
            out["truncated"] = True
        return out

    def state(self, ref: str, *, budget: int = CLOSURE_BUDGET) -> dict[str, Any]:
        """The module/class state a function touches, directly and through calls."""
        node_id = self.resolve(ref, kinds=_CALL_KINDS)
        reads, writes = self.reads[0].get(node_id, []), self.writes[0].get(node_id, [])
        own = set(reads) | set(writes)
        reached, _, truncated = closure([node_id], self.call_graph.callees_step, budget)
        through: dict[str, str] = {}
        for callee in reached:
            for var in self.reads[0].get(callee, []):
                if var not in own:
                    through.setdefault(var, "r")
            for var in self.writes[0].get(callee, []):
                if var not in own:
                    through[var] = "w" if through.get(var, "w") == "w" else "rw"
        out: dict[str, Any] = {"symbol": node_id}
        _put_list(out, "reads", reads, budget)
        _put_list(out, "writes", writes, budget)
        # Grouped by owner (class or module): the same prefix repeated per
        # attribute is most of the bytes otherwise.
        grouped: dict[str, list[str]] = {}
        for var, mode in sorted(through.items()):
            owner = self.nodes[var].get("parent") or self.nodes[var].get("module") or ""
            name = var[len(owner) + 1:] if owner and var.startswith(owner + ".") else var
            grouped.setdefault(owner, []).append(f"{name}:{mode}")
        if grouped:
            out["through_calls"] = {owner: " ".join(names) for owner, names in grouped.items()}
        if truncated:
            out["truncated"] = True
        return out

    def overview(self, *, limit: int = 10) -> dict[str, Any]:
        """A one-shot map of the codebase for an agent arriving cold."""
        graph = self.call_graph
        stats = self.meta.get("stats", {})
        out: dict[str, Any] = {
            "root": self.meta.get("root_abs") or self.meta.get("root"),
            "generated_at": self.meta.get("generated_at"),
            "counts": {k: stats[k] for k in ("files", "symbols") if k in stats}
            | {"kinds": stats.get("node_kinds", {})},
        }
        resolved, unresolved = stats.get("calls_resolved", 0), stats.get("calls_unresolved", 0)
        if resolved + unresolved:
            out["call_resolution"] = f"{resolved}/{resolved + unresolved} call sites resolved in-project"
        out["top_dirs"] = self.tree(depth=1, metric="symbols")["tree"]
        out["entries"] = self.entries(limit=limit)["entries"]
        hubs = sorted(
            (i for i in graph.component_of if self.nodes[i]["kind"] in _CALLABLE_KINDS),
            key=lambda i: (-len([e for e in graph.callers.get(i, []) if e["source"] != i]), i),
        )[:limit]
        out["most_called"] = [f"{i} {self.loc(i)} callers={len(graph.callers.get(i, []))}" for i in hubs]
        complex_ = sorted(
            (n for n in self.nodes.values() if n["kind"] in _CALLABLE_KINDS and n.get("complexity")),
            key=lambda n: (-n["complexity"], n["id"]),
        )[:limit]
        out["most_complex"] = [f"{n['id']} {self.loc(n['id'])} cx={n['complexity']}" for n in complex_]
        imported = sorted(self.importers_of.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:limit]
        out["most_imported"] = [f"{f} importers={len(v)}" for f, v in imported]
        if self.import_cycles:
            out["import_cycles"] = self.import_cycles[:limit]
        out["possibly_unused"] = len(graph.orphans)
        return out

    def orphans(self, *, include_tests: bool = False, limit: int = 100) -> dict[str, Any]:
        """Callables nothing calls, names, or explains: POSSIBLY unused."""
        ids = [
            i for i in self.call_graph.orphans
            if include_tests or not is_test_path(self.nodes[i].get("file_path", ""))
        ]
        out: dict[str, Any] = {"possibly_unused": [self.ref(i) for i in ids[:limit]]}
        if len(ids) > limit:
            out["total"] = len(ids)
        out["note"] = "static analysis misses dynamic calls; verify before deleting"
        return out

    # -- source --------------------------------------------------------------

    def source_of(self, node_id: str) -> str:
        """A symbol's source, read from disk (current) or the registry."""
        node = self.nodes[node_id]
        path = self.root / node.get("file_path", "")
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            if node["kind"] == "module":
                return "\n".join(lines)
            return "\n".join(lines[node["start_line"] - 1 : node["end_line"]])
        except OSError:
            symbol = self.registry.get("symbols", {}).get(node_id, {})
            return symbol.get("code") or node.get("stub") or ""


class CallGraph:
    """The call graph and its condensation (derive.ts deriveCallGraph)."""

    def __init__(self, ws: Workspace) -> None:
        self.ws = ws
        nodes = ws.nodes
        order: dict[str, None] = {
            i: None for i, n in nodes.items() if n["kind"] in _CALLABLE_KINDS
        }
        self.callees: dict[str, list[dict[str, Any]]] = {}
        self.callers: dict[str, list[dict[str, Any]]] = {}
        # Module calls are evidence for agents, but deliberately excluded from
        # call-flow components: a module is not a call-flow node.
        self.module_callers: dict[str, list[dict[str, Any]]] = {}
        self.recursive: set[str] = set()
        constructed: set[str] = set()
        edges: list[dict[str, Any]] = []
        for edge in ws._typed("CALLS"):
            s, t = nodes.get(edge["source"]), nodes.get(edge["target"])
            if s is None or t is None:
                continue
            if s["kind"] == "module" and t["kind"] in _CALL_KINDS:
                self.module_callers.setdefault(t["id"], []).append(edge)
                continue
            if s["kind"] not in _CALL_KINDS or t["kind"] not in _CALL_KINDS:
                continue
            order[s["id"]] = None
            order[t["id"]] = None
            if t["kind"] == "class":
                constructed.add(t["id"])
            if s["id"] == t["id"]:
                self.recursive.add(s["id"])
            edges.append(edge)
        for class_id in constructed:
            init = f"{class_id}.__init__"
            if nodes.get(init, {}).get("kind") == "method":
                order[init] = None
                edges.append({"source": class_id, "target": init, "lines": [], "implicit": True})
        for edge in edges:
            self.callees.setdefault(edge["source"], []).append(edge)
            self.callers.setdefault(edge["target"], []).append(edge)

        adjacency = {i: [] for i in order}
        for edge in edges:
            adjacency[edge["source"]].append(edge["target"])
        self.component_of, self.members = strongly_connected(adjacency)
        self.condensed: list[list[int]] = [[] for _ in self.members]
        self.condensed_callers: list[list[int]] = [[] for _ in self.members]
        seen: set[tuple[int, int]] = set()
        for edge in edges:
            a, b = self.component_of[edge["source"]], self.component_of[edge["target"]]
            if a != b and (a, b) not in seen:
                seen.add((a, b))
                self.condensed[a].append(b)
                self.condensed_callers[b].append(a)

    def callers_step(self, node_id: str) -> list[str]:
        return [e["source"] for e in self.callers.get(node_id, []) if e["source"] != node_id]

    def callees_step(self, node_id: str) -> list[str]:
        return [e["target"] for e in self.callees.get(node_id, []) if e["target"] != node_id]

    def recursive_of(self, node_id: str) -> str | list[str] | None:
        members = self.members[self.component_of[node_id]]
        if len(members) > 1:
            return sorted(members)
        return "self" if node_id in self.recursive else None

    # -- entry points (entryPoints.ts) ---------------------------------------

    @cached_property
    def roles(self) -> dict[str, tuple[str, str | None]]:
        """Node -> (role, evidence) where role is internal | framework-entry |
        referenced | entry | orphan."""
        referrers = self.ws.references[1]
        out: dict[str, tuple[str, str | None]] = {}
        for node_id in self.component_of:
            match = match_role(self.ws.nodes[node_id])
            if self.callers_step(node_id) or self.module_callers.get(node_id):
                out[node_id] = ("internal", f"{match[0]}: {match[1]}" if match else None)
            elif match:
                out[node_id] = ("framework-entry", f"{match[0]} {match[1]}")
            elif referrers.get(node_id):
                named = [self.ws.nodes[r]["name"] for r in referrers[node_id]]
                extra = f" +{len(named) - 1}" if len(named) > 1 else ""
                out[node_id] = ("referenced", f"named by {named[0]}{extra}")
            elif self.callees_step(node_id):
                out[node_id] = ("entry", None)
            else:
                out[node_id] = ("orphan", None)
        return out

    @cached_property
    def entries(self) -> list[str]:
        return [i for i, (role, _) in self.roles.items() if role in ("framework-entry", "referenced", "entry")]

    @cached_property
    def orphans(self) -> list[str]:
        return [i for i, (role, _) in self.roles.items() if role == "orphan"]

    # -- metrics (callMetrics.ts) --------------------------------------------

    def _reach(self, adjacency: list[list[int]], ascending: bool) -> list[int]:
        """Member count reachable from each component, itself included.

        Bitmask per component; component ids are reverse topological so one
        pass in id order sees every successor finished."""
        count = len(self.members)
        masks = [0] * count
        extra = [len(m) - 1 for m in self.members]
        cyclic_mask = 0
        for cid, e in enumerate(extra):
            if e:
                cyclic_mask |= 1 << cid
        ids = range(count) if ascending else range(count - 1, -1, -1)
        totals = [0] * count
        for cid in ids:
            mask = 1 << cid
            for nxt in adjacency[cid]:
                mask |= masks[nxt]
            masks[cid] = mask
            total = mask.bit_count()
            knots = mask & cyclic_mask
            while knots:
                low = knots & -knots
                total += extra[low.bit_length() - 1]
                knots ^= low
            totals[cid] = total
        return totals

    @cached_property
    def _down(self) -> list[int]:
        return self._reach(self.condensed, ascending=True)

    @cached_property
    def _up(self) -> list[int]:
        return self._reach(self.condensed_callers, ascending=False)

    def reach_down(self, node_id: str) -> int:
        return max(0, self._down[self.component_of[node_id]] - 1)

    def reach_up(self, node_id: str) -> int:
        return max(0, self._up[self.component_of[node_id]] - 1)

    def metrics(self, node_id: str) -> dict[str, Any]:
        node = self.ws.nodes[node_id]
        out = {
            "fan_in": len(self.callers.get(node_id, [])),
            "fan_out": len(self.callees.get(node_id, [])),
            "reach_down": self.reach_down(node_id),
            "reach_up": self.reach_up(node_id),
        }
        if node.get("complexity") is not None and node["kind"] in _CALLABLE_KINDS:
            out["complexity"] = node["complexity"]
        if node.get("line_count"):
            out["lines"] = node["line_count"]
        return out

    # -- cones (callFlow.ts coneOf) ------------------------------------------

    def cone(self, root: int, direction: str, depth: int, budget: int) -> dict[str, Any]:
        components = {root}
        depth_of = {root: 0}
        descendants: set[int] = set()
        ancestors: set[int] = set()
        truncated = False

        def advance(adjacency: list[list[int]], side: set[int], frontier: list[int], step: int, sign: int) -> list[int]:
            nonlocal truncated
            nxt = {t for c in frontier for t in adjacency[c] if t not in components}
            if not nxt:
                return []
            if len(components) + len(nxt) > budget:
                truncated = True
                return []
            for c in nxt:
                components.add(c)
                depth_of[c] = sign * step
                side.add(c)
            return list(nxt)

        want_down, want_up = direction in ("down", "both"), direction in ("up", "both")
        down = [root] if want_down else []
        up = [root] if want_up else []
        for step in range(1, depth + 1):
            if not down and not up:
                break
            next_down = advance(self.condensed, descendants, down, step, 1) if down else []
            next_up = advance(self.condensed_callers, ancestors, up, step, -1) if up else []
            down, up = next_down, next_up

        outside: set[int] = set()
        for c in components:
            at_root = c == root
            if want_down and (at_root or c in descendants):
                outside.update(t for t in self.condensed[c] if t not in components)
            if want_up and (at_root or c in ancestors):
                outside.update(t for t in self.condensed_callers[c] if t not in components)
        return {"components": components, "depth": depth_of, "beyond": len(outside), "truncated": truncated}


# -- small helpers ------------------------------------------------------------


def _first_paragraph(doc: str) -> str:
    return doc.strip().split("\n\n", 1)[0].strip()


def _walk_nodes(node):
    """Yield a Tree-sitter node and every descendant without query coupling."""
    yield node
    for child in node.children:
        yield from _walk_nodes(child)


def _node_text(source: bytes, node) -> str:
    if node is None:
        return ""
    return source[node.start_byte : node.end_byte].decode("utf-8", "replace")


def _string_value(source: str) -> str | None:
    try:
        value = ast.literal_eval(source)
    except (SyntaxError, ValueError):
        return None
    return value if isinstance(value, str) else None


def _attribute_mode(node) -> str:
    """r/w/c for an attribute expression, using immediate syntax only."""
    parent = node.parent
    if parent and parent.type == "call" and parent.child_by_field_name("function") == node:
        return "c"
    current = node
    while current.parent and current.parent.type in {"assignment", "augmented_assignment"}:
        parent = current.parent
        left = parent.child_by_field_name("left")
        if left and left.start_byte <= node.start_byte and node.end_byte <= left.end_byte:
            return "w"
        current = parent
    return "r"


def _span(node: dict[str, Any]) -> str:
    start, end = node.get("start_line", 0), node.get("end_line", 0)
    return f"{start}-{end}" if end and end != start else str(start)


def _outline_label(node: dict[str, Any]) -> str:
    sig = (node.get("signature") or node.get("name", "")).strip()
    sig = sig.removesuffix(":") if node["kind"] in ("class", "function", "method") else sig
    if len(sig) > 160:
        sig = sig[:157] + "..."
    return sig


def _conf(edge: dict[str, Any]) -> str:
    return " ?" if edge.get("confidence") == "heuristic" else ""


def _put_list(out: dict[str, Any], key: str, items: list[Any], limit: int) -> None:
    if not items:
        return
    out[key] = items[:limit]
    if len(items) > limit:
        out[f"{key}_more"] = len(items) - limit


def _put_many(out: dict[str, Any], key: str, items: list[Any], full: bool) -> None:
    if items:
        out[key] = items if full else len(items)


def _check_direction(direction: str, allowed: tuple[str, ...]) -> None:
    if direction not in allowed:
        raise QueryError(f"direction must be one of {', '.join(allowed)}")
