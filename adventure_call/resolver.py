"""Match call-site identifiers against imports and global definitions.

Resolution is deliberately conservative.  Every answer carries a confidence:

``exact``
    Follows directly from an import binding, the enclosing module, or the
    enclosing class (including its in-project base classes).
``heuristic``
    Nothing bound the name, but exactly one symbol in the whole project has it.
    Useful, and flagged so consumers can drop it.
``unresolved``
    Recorded with a reason instead of being silently dropped -- unresolved
    calls out of a symbol are themselves signal when packing context.
"""

from __future__ import annotations

import builtins
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Literal, Sequence

from adventure_call.models import (
    AccessLink,
    CallSite,
    ImportRecord,
    LocalBinding,
    ParsedFile,
    Reference,
    ReferenceLink,
    Resolution,
    SymbolDef,
    VariableAccess,
)

BindingKind = Literal["module", "symbol", "external"]

# Variables and class attributes are symbols, but they are not call targets:
# they are indexed and reachable, and never the answer to "what does this call?"
_CALLABLE_KINDS = frozenset({"function", "method", "class"})
# ...which is exactly why READS/WRITES (tic-13d7) needs its own kind set and
# its own lookup tables: the two vocabularies do not overlap at all.
_VALUE_KINDS = frozenset({"variable", "attribute"})
_BUILTIN_NAMES = frozenset(dir(builtins))
_SELF_NAMES = frozenset({"self", "cls"})
_MAX_MRO_DEPTH = 8
_MAX_REEXPORT_DEPTH = 6
_MAX_ANNOTATION_DEPTH = 4
_MAX_SCOPE_DEPTH = 8

# Directory children that are never the import root of a src-layout project.
_NON_SOURCE_DIRS = frozenset(
    {"tests", "test", "docs", "doc", "examples", "example", "scripts", "benchmarks", "benches", "tools"}
)


def _looks_like_class(name: str) -> bool:
    """Whether a name we hold no definition for is spelled like a class.

    PEP 8 CapWords, excluding SHOUTING constants.  A convention, not a fact --
    used only where nothing better exists (an external name has no definition
    to inspect) and only to decide whether to record a binding at all.
    """
    return bool(name) and name[:1].isupper() and not name.isupper()


def _load_pyproject(path: Path) -> dict:
    """Parse ``pyproject.toml`` if present; any failure means "no config"."""
    if not path.is_file():
        return {}
    try:
        import tomllib  # Python >= 3.11
    except ModuleNotFoundError:
        try:
            import tomli as tomllib  # type: ignore[no-redef]
        except ModuleNotFoundError:
            return {}
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except Exception:  # malformed TOML, encoding errors -- treat as absent
        return {}


#: Builtin names that ARE types, so calling one produces a value of that type.
#: `open()` is not in here on purpose: it is a builtin callable whose result is
#: a file object, and naming the result "open" would be a lie.
_BUILTIN_TYPES = frozenset(
    {"bool", "bytes", "bytearray", "dict", "float", "frozenset", "int", "list",
     "set", "str", "tuple"}
)

#: Annotations that name no type at all.  `Any` is the explicit spelling of
#: "unknown", and treating it as a type cost three correct carnot edges before
#: it was caught: `session: Any` bound `session` to `typing.Any`, so every
#: method call on it was reported as a call out to `typing`.
_UNINFORMATIVE_ANNOTATIONS = frozenset({"Any", "object", "None", "NoReturn", "Never"})

#: Annotation wrappers whose single argument is the thing actually bound.
#: `async def f() -> AsyncIterator[Session]` used as `async with f() as s`
#: binds a Session.  A container is NOT in here: a `list[Session]` is a list.
_TRANSPARENT_ANNOTATIONS = ("Optional", "Awaitable", "Coroutine")


@dataclass(frozen=True)
class LocalType:
    """What kind of thing a local name holds (tic-97ce).

    Not a type in any real sense -- there is no inference here, no flow
    sensitivity and no unification.  It is the answer to one narrow question:
    when someone calls a method on this name, whose method is it?
    """

    kind: Literal["project", "external", "builtin"]
    #: Class symbol id for ``project``, a dotted path for ``external``, a
    #: builtin type name for ``builtin``.
    target: str


@dataclass(frozen=True)
class Binding:
    """A name bound into a module's namespace by an import statement."""

    alias: str
    kind: BindingKind
    target: str
    record: ImportRecord

    def to_dict(self) -> dict[str, object]:
        return {
            "alias": self.alias,
            "kind": self.kind,
            "target": self.target,
            "line": self.record.line,
            "statement_module": self.record.target_module,
            "is_relative": self.record.is_relative,
        }


@dataclass
class ResolutionIndex:
    """Everything the graph builder needs, keyed for fast lookup."""

    symbols: dict[str, SymbolDef] = field(default_factory=dict)
    modules: dict[str, ParsedFile] = field(default_factory=dict)
    bindings: dict[str, dict[str, Binding]] = field(default_factory=dict)
    resolutions: list[Resolution] = field(default_factory=list)
    #: Callables NAMED without being called (tic-89fa), resolved.  Kept apart
    #: from `resolutions` because a reference is not a call: it is evidence
    #: that something can reach a callable, never evidence that anything does,
    #: and anything reasoning about flow must be able to ignore them.
    references: list[ReferenceLink] = field(default_factory=list)
    #: Module variables and class attributes read or written (tic-13d7).
    #: Kept apart from `resolutions` and `references` alike: a call is flow, a
    #: reference is reachability, and this is data coupling.  It is the only
    #: one of the three that can join two methods of a class that never call
    #: each other.
    accesses: list[AccessLink] = field(default_factory=list)
    builtin_calls: int = 0

    @property
    def resolved(self) -> list[Resolution]:
        """Call resolutions that landed on a project symbol."""
        return [r for r in self.resolutions if r.callee_id]

    @property
    def unresolved(self) -> list[Resolution]:
        """Call resolutions that found nothing (builtins excluded as noise)."""
        return [r for r in self.resolutions if not r.callee_id and r.reason != "builtin"]

    def unresolved_for(self, symbol_id: str) -> list[Resolution]:
        """Unresolved calls made by one symbol."""
        return [r for r in self.unresolved if r.caller_id == symbol_id]


class SymbolResolver:
    """Turn parsed files into fully qualified symbol references.

    Args:
        parsed_files: Output of :class:`~adventure_call.parser.CodebaseParser`.
        resolve_module_level_calls: Attribute calls made outside any definition
            to their module symbol rather than discarding them.
    """

    def __init__(
        self,
        parsed_files: Sequence[ParsedFile],
        *,
        resolve_module_level_calls: bool = True,
        root: Path | str | None = None,
    ) -> None:
        self.files = list(parsed_files)
        self.resolve_module_level_calls = resolve_module_level_calls
        # Path prefixes separating the analysed root from the import root, e.g.
        # ``("src",)`` when packages live under ``src/``.  Empty when unknown.
        self.import_prefixes = (
            self._infer_import_prefixes(Path(root).resolve()) if root is not None else []
        )
        # import-visible module name -> path-derived module id, e.g.
        # ``"carnot.kernel" -> "src.carnot.kernel"``.
        self._import_aliases: dict[str, str] = {}

        self.symbols: dict[str, SymbolDef] = {}
        self.modules: dict[str, ParsedFile] = {}
        self.packages: set[str] = set()
        # module -> {top-level name: symbol_id}
        self.module_members: dict[str, dict[str, str]] = defaultdict(dict)
        # class symbol_id -> {member name: symbol_id}
        self.class_members: dict[str, dict[str, str]] = defaultdict(dict)
        #: The value-side twins of `module_members`/`class_members` (tic-13d7).
        #: Separate tables rather than extra entries in those, because the
        #: callable tables exclude non-callables precisely so a constant
        #: sharing a function's name cannot make that name ambiguous for CALL
        #: resolution -- and a read needs exactly the entries that excludes.
        self.module_values: dict[str, dict[str, str]] = defaultdict(dict)
        self.class_values: dict[str, dict[str, str]] = defaultdict(dict)
        # bare name -> every symbol id carrying it (unique-name fallback)
        self.by_name: dict[str, list[str]] = defaultdict(list)
        self.bindings: dict[str, dict[str, Binding]] = defaultdict(dict)
        self.wildcards: dict[str, list[str]] = defaultdict(list)
        # function symbol_id -> {local name: what it holds} (tic-97ce)
        self.local_types: dict[str, dict[str, LocalType]] = {}

        self._build_indexes()
        # After the indexes, never before: resolving a binding walks the very
        # tables _build_indexes fills.
        self._build_local_types()

    # -- indexing ----------------------------------------------------------

    def _build_indexes(self) -> None:
        for parsed in self.files:
            self.modules[parsed.module] = parsed
            if parsed.file_path.endswith("__init__.py"):
                self.packages.add(parsed.module)

            for symbol in parsed.symbols:
                if symbol.symbol_id in self.symbols:
                    # Same id twice (conditional definitions, re-defs): first wins,
                    # which matches "the definition a reader meets first".
                    continue
                self.symbols[symbol.symbol_id] = symbol
                if symbol.kind in _VALUE_KINDS:
                    if symbol.parent is None:
                        self.module_values[symbol.module][symbol.name] = symbol.symbol_id
                    else:
                        self.class_values[symbol.parent][symbol.name] = symbol.symbol_id
                if symbol.kind not in _CALLABLE_KINDS:
                    # Indexed above so the graph and registry carry it, but kept
                    # out of every lookup table below -- otherwise a constant
                    # sharing a function's name would make that name ambiguous.
                    continue
                self.by_name[symbol.name].append(symbol.symbol_id)
                if symbol.parent is None:
                    self.module_members[symbol.module][symbol.name] = symbol.symbol_id
                elif symbol.parent in self.symbols and self.symbols[symbol.parent].kind == "class":
                    self.class_members[symbol.parent][symbol.name] = symbol.symbol_id

        self._build_import_aliases()

        for parsed in self.files:
            for record in parsed.imports:
                self._bind_import(parsed.module, record)

    def _build_import_aliases(self) -> None:
        """Index each prefixed module under its import-visible name too.

        Path-derived ids (``src.carnot.kernel.types``) stay the only ids in
        :attr:`symbols`/:attr:`modules`, so nothing downstream changes; this
        map just lets import statements written against the import root
        (``carnot.kernel.types``) find them.
        """
        if not self.import_prefixes:
            return
        for module in self.modules:
            parts = module.split(".")
            for prefix in self.import_prefixes:
                n = len(prefix)
                if len(parts) > n and tuple(parts[:n]) == prefix:
                    self._import_aliases.setdefault(".".join(parts[n:]), module)
                    break

    def _canonical_module(self, name: str) -> str:
        """Map an import-visible module name to its path-derived module id."""
        if not name or name in self.modules:
            return name
        return self._import_aliases.get(name, name)

    def _infer_import_prefixes(self, root: Path) -> list[tuple[str, ...]]:
        """Guess which path prefixes separate the analysed root from imports.

        Two signals, in order of trust: the project's own package
        configuration (setuptools ``packages.find.where``, hatch ``packages``,
        poetry ``packages``), then the conventional src-layout -- a single
        directory child that holds packages but is not itself one.
        """
        prefixes: list[tuple[str, ...]] = []

        def add(segments: Iterable[str]) -> None:
            parts = tuple(p for p in segments if p and p != ".")
            if parts and parts not in prefixes:
                prefixes.append(parts)

        def segments_of(value: str) -> list[str]:
            return [p for p in value.replace("\\", "/").strip("/").split("/") if p and p != "."]

        data = _load_pyproject(root / "pyproject.toml")
        if data:
            tool = data.get("tool", {})

            find = tool.get("setuptools", {}).get("packages", {}).get("find", {})
            for where in find.get("where") or ():
                if isinstance(where, str):
                    add(where.split("/"))

            hatch_build = tool.get("hatch", {}).get("build", {})
            for entry in [*hatch_build.get("packages", []), *hatch_build.get("targets", {}).get("wheel", {}).get("packages", [])]:
                if not isinstance(entry, str):
                    continue
                parts = segments_of(entry)
                # ``src/carnot`` names the package ``carnot`` under ``src/``;
                # a bare non-package directory (``src``) is the root itself.
                last = root.joinpath(*parts)
                if parts and (last / "__init__.py").is_file():
                    add(parts[:-1])
                else:
                    add(parts)

            for entry in tool.get("poetry", {}).get("packages", []):
                if isinstance(entry, dict) and isinstance(entry.get("from"), str):
                    add(entry["from"].split("/"))

        if not prefixes:
            candidates = []
            for child in sorted(root.iterdir()):
                if not child.is_dir() or child.name.startswith(".") or child.name in _NON_SOURCE_DIRS:
                    continue
                if (child / "__init__.py").is_file():
                    continue  # itself a package -- a flat layout, not src-layout
                if any(
                    (sub / "__init__.py").is_file()
                    for sub in child.iterdir()
                    if sub.is_dir()
                ):
                    candidates.append(child)
            if len(candidates) == 1:
                add((candidates[0].name,))

        return prefixes

    def _bind_import(self, module: str, record: ImportRecord) -> None:
        absolute = self._absolute_module(record)

        if record.is_wildcard:
            if absolute:
                self.wildcards[module].append(absolute)
            return

        if record.target_symbol is None:
            # `import a.b` binds `a`; `import a.b as c` binds `c` to `a.b`.
            target = self._canonical_module(record.target_module)
            kind: BindingKind = "module" if target in self.modules else "external"
            self.bindings[module][record.alias] = Binding(record.alias, kind, target, record)
            return

        candidate = f"{absolute}.{record.target_symbol}" if absolute else record.target_symbol
        if candidate in self.symbols:
            kind = "symbol"
        elif candidate in self.modules:
            kind = "module"
        else:
            kind = "external"
        self.bindings[module][record.alias] = Binding(record.alias, kind, candidate, record)

    def _absolute_module(self, record: ImportRecord) -> str:
        """Resolve a possibly-relative import against the importing module."""
        if not record.is_relative:
            return self._canonical_module(record.target_module)

        parts = record.module.split(".") if record.module else []
        if record.module not in self.packages:
            parts = parts[:-1]  # a module's `.` is its containing package
        drop = record.level - 1
        parts = parts[: len(parts) - drop] if 0 < drop <= len(parts) else ([] if drop else parts)

        if record.target_module:
            parts = [*parts, *record.target_module.split(".")]
        return ".".join(p for p in parts if p)

    # -- resolution --------------------------------------------------------

    def resolve(self) -> ResolutionIndex:
        """Resolve every call site in every parsed file."""
        index = ResolutionIndex(
            symbols=dict(self.symbols),
            modules=dict(self.modules),
            bindings={mod: dict(aliases) for mod, aliases in self.bindings.items()},
        )

        for parsed in self.files:
            for call in parsed.calls:
                caller_id = call.caller_id
                if caller_id is None:
                    if not self.resolve_module_level_calls:
                        continue
                    caller_id = call.module

                resolution = self._resolve_call(call, caller_id)
                if resolution.reason == "builtin":
                    index.builtin_calls += 1
                index.resolutions.append(resolution)

            for reference in parsed.references:
                link = self._resolve_reference(reference)
                if link is not None:
                    index.references.append(link)

            for access in parsed.accesses:
                data_link = self._resolve_access(access)
                if data_link is not None:
                    index.accesses.append(data_link)

        return index

    def _resolve_reference(self, ref: Reference) -> ReferenceLink | None:
        """Resolve a named-but-not-called callable, or None to drop it.

        Deliberately all-or-nothing, with no `unresolved` counterpart.  An
        unresolved CALL is a finding -- the code does something we could not
        follow -- but an unresolved reference is almost always just a variable
        being read, and the query that produced it is loose on purpose:
        `f(x)` matches for every `x` there is.  Measured, that is 753
        candidate sites on ../carnot for 91 real references, and recording the
        other 662 as unresolved would swamp the coverage figures with noise
        that means nothing.

        The target must be an in-project CALLABLE.  A reference to a constant
        or a module is not the thing this edge type is about.
        """
        scope_id = ref.scope_id or ref.module
        if not ref.root:
            return None

        if ref.attr_path:
            base = self._root_target(ref.module, scope_id, ref.root)
            target = self._walk_dotted(base, ref.attr_path) if base else None
        else:
            # A nested definition wins over a module-level one of the same
            # name, exactly as it does for a call -- which is why the parser
            # does not need to treat a nested `def` as a shadowing binding.
            target = self._lookup_local(scope_id, ref.root)
            if target is None:
                target = self.module_members.get(ref.module, {}).get(ref.root)
            if target is None:
                binding = self.bindings.get(ref.module, {}).get(ref.root)
                if binding is not None and binding.kind == "symbol":
                    target = binding.target

        if target is None or not self._is_callable(target):
            return None
        if target == scope_id:
            return None  # a function naming itself is recursion, not a reference
        return ReferenceLink(
            referrer_id=scope_id,
            target_id=target,
            raw_name=ref.raw_name,
            line=ref.line,
            file_path=ref.file_path,
            position=ref.position,
        )

    def _resolve_access(self, access: VariableAccess) -> AccessLink | None:
        """Resolve a variable or attribute access, or None to drop it.

        All-or-nothing, with no `unresolved` counterpart, for the same reason
        :meth:`_resolve_reference` has none and more so: the query behind this
        matches every identifier in the file, which on ../carnot is 33974
        candidate sites for 1728 accesses.  Recording the other 32000 as
        unresolved would say nothing except that Python has variables.

        The target must be a VARIABLE or an ATTRIBUTE.  A name that resolves to
        a function or a class is :class:`Reference` territory (tic-89fa), which
        already exists and states it better; letting those through here would
        emit a second, noisier copy of that edge type.
        """
        scope_id = access.scope_id or access.module
        if not access.root:
            return None

        if access.attr_path:
            target = self._access_attribute(access, scope_id)
        else:
            target = self._access_name(access, scope_id)

        if target is None or not self._is_value(target):
            return None

        # A write from the symbol's own owner is its DECLARATION -- `X = 1` at
        # module level, `x = 1` in a class body -- and the graph already says
        # that with a CONTAINS edge.  Reads are never redundant this way, so
        # only writes are dropped.
        if access.kind == "write" and scope_id == self._owner_of(target):
            return None

        return AccessLink(
            accessor_id=scope_id,
            target_id=target,
            raw_name=access.raw_name,
            line=access.line,
            file_path=access.file_path,
            kind=access.kind,
        )

    def _access_name(self, access: VariableAccess, scope_id: str) -> str | None:
        """A bare name: a class-body sibling, a module constant, an import."""
        symbol = self.symbols.get(scope_id)
        if symbol is not None and symbol.kind == "class":
            sibling = self._lookup_value(scope_id, access.root)
            if sibling:
                return sibling

        member = self.module_values.get(access.module, {}).get(access.root)
        if member:
            return member

        binding = self.bindings.get(access.module, {}).get(access.root)
        if binding is not None and binding.kind == "symbol":
            return binding.target
        return None

    def _access_attribute(self, access: VariableAccess, scope_id: str) -> str | None:
        """A one-level attribute: `self.x`, `cls.x`, `module.CONST`, `Cls.x`."""
        attr = access.attr_path[0]

        if access.root in _SELF_NAMES:
            # `self.x` reaches the enclosing class and its in-project bases,
            # which is how an attribute declared on a base class is found from
            # a subclass method that never mentions it.
            klass = self._enclosing_class(scope_id)
            return self._lookup_value(klass, attr) if klass else None

        base = self._root_target(access.module, scope_id, access.root)
        if base is None:
            return None
        found = self.module_values.get(base, {}).get(attr)
        if found:
            return found
        return self._lookup_value(base, attr)

    def _lookup_value(self, class_id: str, name: str, depth: int = 0) -> str | None:
        """Find an attribute on a class or its in-project base classes.

        The value-side twin of :meth:`_lookup_member`, and separate from it on
        purpose: the callable tables deliberately exclude non-callables so that
        a constant sharing a function's name cannot make that name ambiguous
        for CALL resolution, which means a read needs tables of its own.
        """
        if depth > _MAX_MRO_DEPTH:
            return None
        member = self.class_values.get(class_id, {}).get(name)
        if member:
            return member

        klass = self.symbols.get(class_id)
        if klass is None:
            return None
        for base in klass.bases:
            base_id = self._resolve_class_ref(base, klass.module)
            if base_id and base_id != class_id:
                found = self._lookup_value(base_id, name, depth + 1)
                if found:
                    return found
        return None

    def _is_value(self, symbol_id: str) -> bool:
        """True when ``symbol_id`` names data rather than something callable."""
        symbol = self.symbols.get(symbol_id)
        return symbol is not None and symbol.kind in _VALUE_KINDS

    def _owner_of(self, symbol_id: str) -> str | None:
        """The class or module a symbol is declared in."""
        symbol = self.symbols.get(symbol_id)
        if symbol is None:
            return None
        return symbol.parent or symbol.module

    def _resolve_call(self, call: CallSite, caller_id: str) -> Resolution:
        def outcome(
            callee_id: str | None,
            confidence: str = "exact",
            call_type: str = "call",
            reason: str | None = None,
        ) -> Resolution:
            if callee_id:
                target = self.symbols[callee_id]
                if target.kind not in _CALLABLE_KINDS:
                    # A binding can point straight at a constant (`from cfg
                    # import LIMIT`); calling it is not something we can follow.
                    callee_id, confidence = None, "unresolved"
                    reason = f"{target.kind} {target.symbol_id!r} is not callable"
                elif call_type == "call":
                    kind = target.kind
                    call_type = (
                        "constructor" if kind == "class" else "method" if kind == "method" else "call"
                    )
            return Resolution(
                caller_id=caller_id,
                raw_name=call.raw_name,
                line=call.line,
                callee_id=callee_id,
                confidence=confidence,  # type: ignore[arg-type]
                call_type=call_type,  # type: ignore[arg-type]
                reason=reason,
                file_path=call.file_path,
                # Carried verbatim from the call site (tic-b47a) so the graph
                # edge and the unresolved-call export both keep it.
                control=list(call.control),
            )

        if not call.root:
            return outcome(None, "unresolved", reason="computed callee")

        segments = [call.root, *call.attr_path]

        # 1. self.x / cls.x -- look inside the enclosing class, then its bases.
        if segments[0] in _SELF_NAMES:
            if len(segments) != 2:
                return outcome(None, "unresolved", reason="nested attribute on self")
            owner = self._enclosing_class(caller_id)
            if owner is None:
                return outcome(None, "unresolved", reason="self outside a class")
            found = self._lookup_member(owner, segments[1])
            if found:
                return outcome(found)
            return outcome(None, "unresolved", reason=f"no member {segments[1]!r} on {owner}")

        # 2. Bare names: enclosing scope, module scope, imports, wildcards.
        if len(segments) == 1:
            name = segments[0]
            local = self._lookup_local(caller_id, name)
            if local:
                return outcome(local)

            member = self.module_members.get(call.module, {}).get(name)
            if member:
                return outcome(member)

            binding = self.bindings.get(call.module, {}).get(name)
            if binding is not None:
                if binding.kind == "symbol":
                    return outcome(binding.target)
                if binding.kind == "module":
                    return outcome(None, "unresolved", reason=f"{name!r} names a module")
                return outcome(None, "unresolved", reason=f"external: {binding.target}")

            for wildcard_module in self.wildcards.get(call.module, ()):
                found = self._module_member(wildcard_module, name)
                if found:
                    return outcome(found)

            if name in _BUILTIN_NAMES:
                return outcome(None, "unresolved", reason="builtin")
            return self._fallback_by_name(name, outcome)

        # 3. Dotted names: walk a bound root through modules and symbols.
        root, rest = segments[0], segments[1:]
        base = self._root_target(call.module, caller_id, root)
        if base is not None:
            found = self._walk_dotted(base, rest)
            if found:
                return outcome(found)
            return outcome(None, "unresolved", reason=f"{'.'.join(segments)!r} not found under {base}")

        external = self.bindings.get(call.module, {}).get(root)
        if external is not None and external.kind == "external":
            return outcome(None, "unresolved", reason=f"external: {external.target}")

        if root in _BUILTIN_NAMES:
            return outcome(None, "unresolved", reason="builtin")

        # The receiver may be a local whose type we bound (tic-97ce).  Ahead of
        # the unique-name fallback deliberately: knowing the receiver is a list
        # is worth more than the coincidence that exactly one project symbol is
        # called `append`, and that coincidence was producing wrong edges.
        classified = self._classify_receiver(caller_id, root, rest, outcome)
        if classified is not None:
            return classified

        return self._fallback_by_name(segments[-1], outcome, receiver=root)

    def _classify_receiver(self, caller_id: str, root: str, rest: list[str], outcome):
        """What a method call on a bound local actually goes to (tic-97ce).

        Resolution is the rare outcome and classification is the common one --
        measured across carnot and hypermenu, near enough every call here goes
        to a framework base class or a stdlib container.  Saying WHICH is the
        point: an `unknown receiver` count treats those as holes in the
        analysis, when they are calls out of the project that the export
        already knows how to draw.
        """
        local = self._local_type(caller_id, root)
        if local is None:
            return None

        if local.kind == "builtin":
            return outcome(None, "unresolved", reason=f"stdlib method on {local.target}")
        if local.kind == "external":
            return outcome(None, "unresolved", reason=f"external: {local.target}")

        # A project class, and only a DIRECT member access on it.  A longer
        # chain -- `app.session.transcript.index_of()` -- is a call on
        # whatever `app.session.transcript` is, and this knows nothing about
        # that: claiming it lands on the receiver's class (or is swallowed by
        # the receiver's foreign base) cost five correct carnot edges before
        # the restriction went in.  Walking the chain properly would need
        # attribute types, which is tic-13d7's territory, not this one's.
        if len(rest) != 1:
            return None
        found = self._lookup_member(local.target, rest[0])
        if found:
            # Never `exact`: a local can be rebound and nothing here tracks it.
            return outcome(found, "heuristic", reason="local binding")
        foreign = self._foreign_base(local.target)
        if foreign:
            return outcome(None, "unresolved", reason=f"foreign base: {foreign}")
        return outcome(None, "unresolved", reason=f"no member {rest[0]!r} on {local.target}")

    # -- local type bindings (tic-97ce) ------------------------------------

    def _build_local_types(self) -> None:
        """Resolve each function's local bindings to a kind of thing.

        A name bound more than once to different things is DROPPED, not
        guessed at -- including the case where one of the bindings resolves to
        nothing, because "sometimes a Session and sometimes whatever this
        expression returns" is not a fact worth acting on.  That rule is why
        the parser records a binding even when the expression names nothing
        useful: an unusable binding still has to be able to veto a usable one.
        """
        grouped: dict[tuple[str, str], list[LocalType | None]] = defaultdict(list)
        for parsed in self.files:
            for binding in parsed.locals:
                grouped[(binding.scope_id, binding.name)].append(
                    self._binding_type(binding, parsed.module)
                )

        for (scope_id, name), resolved in grouped.items():
            first = resolved[0]
            if any(other != first for other in resolved[1:]):
                continue  # rebound to something else; no honest single answer
            if first is not None:
                self.local_types.setdefault(scope_id, {})[name] = first

        # Annotated parameters are bindings too, and the parser already
        # recorded them on the symbol -- reading them here rather than having
        # the parser say the same thing twice.  Locals win on a clash: a
        # parameter rebound in the body is the body's value from then on, and
        # the drop-if-ambiguous rule above has already vetted the local.
        for symbol in self.symbols.values():
            if symbol.kind not in ("function", "method"):
                continue
            table = self.local_types.setdefault(symbol.symbol_id, {})
            for param in symbol.params:
                if param.name in table or param.name in _SELF_NAMES:
                    continue
                found = self._annotation_type(param.annotation, symbol.module)
                if found is not None:
                    table[param.name] = found

    def _binding_type(self, binding: LocalBinding, module: str) -> LocalType | None:
        """The kind of thing one binding puts in a name."""
        if binding.literal is not None:
            return LocalType("builtin", binding.literal)
        if not binding.root:
            return None
        if binding.source == "annotation":
            return self._annotation_type(
                ".".join([binding.root, *binding.attr_path]), module
            )
        return self._produced_type(binding, module)

    def _annotation_type(self, text: str | None, module: str) -> LocalType | None:
        """The kind of thing an annotation names.

        Shallow by design: a union of two classes is neither of them, and a
        container of T is not a T.  ``Optional[T]`` and the awaitable wrappers
        are unwrapped because they name T with extra ceremony, which is not the
        same as naming a different shape.
        """
        if not text:
            return None
        text = text.strip().strip('"').strip("'")
        for _ in range(_MAX_ANNOTATION_DEPTH):
            head, _, rest = text.partition("[")
            if not rest or head.split(".")[-1] not in _TRANSPARENT_ANNOTATIONS:
                break
            inner = rest.rsplit("]", 1)[0]
            # Coroutine[Any, Any, T] puts the result last; Optional[T] has one.
            text = inner.split(",")[-1].strip()
        if "|" in text:
            parts = [p.strip() for p in text.split("|") if p.strip() != "None"]
            if len(parts) != 1:
                return None
            text = parts[0]
        if "[" in text or "," in text or not text:
            return None

        segments = text.split(".")
        if segments[-1] in _UNINFORMATIVE_ANNOTATIONS:
            return None
        if len(segments) == 1 and segments[0] in _BUILTIN_TYPES:
            return LocalType("builtin", segments[0])
        return self._named_type(segments, module)

    def _produced_type(self, binding: LocalBinding, module: str) -> LocalType | None:
        """The kind of thing calling ``binding``'s expression produces."""
        segments = [binding.root, *binding.attr_path]
        if len(segments) == 1 and segments[0] in _BUILTIN_TYPES:
            return LocalType("builtin", segments[0])

        named = self._named_type(segments, module, want_callable=True)
        if named is None or named.kind != "project":
            return named
        symbol = self.symbols.get(named.target)
        if symbol is None:
            return None
        if symbol.kind == "class":
            return named  # a constructor call produces an instance of it
        # A function or method: its declared return type is the only honest
        # answer, and most code does not declare one.
        return self._annotation_type(symbol.returns, symbol.module)

    def _named_type(
        self, segments: Sequence[str], module: str, want_callable: bool = False
    ) -> LocalType | None:
        """Resolve a dotted name to a project symbol or an external path.

        Reuses the same binding and module-member machinery a CALL goes
        through, rather than a second name lookup that could disagree with it.

        ``want_callable`` means the caller is asking "what does CALLING this
        produce", which for an external name is a different question from
        "what is this" -- see the constructor test below.
        """
        root, rest = segments[0], list(segments[1:])
        binding = self.bindings.get(module, {}).get(root)
        if binding is not None and binding.kind == "external":
            path = ".".join([binding.target, *rest])
            # Calling an external CLASS produces an instance of it; calling an
            # external FUNCTION produces who-knows-what, and saying "external"
            # anyway is a lie that costs real edges.  Measured: it claimed
            # hypermenu's `location = get_object_or_404(Location, ...)` was a
            # django object and dropped three correct Location method calls,
            # and it claimed carnot's `app = build_app()` was external -- when
            # build_app is a project function the resolver merely failed to
            # link across test modules -- dropping five more.
            #
            # Naming convention is the only signal available: we hold no
            # definition of an external name, so nothing can say whether it is
            # a class except how it is spelled.  When it does not look like a
            # class we record NOTHING, which leaves the existing fallback
            # exactly as it was rather than replacing one guess with another.
            if not want_callable or _looks_like_class(rest[-1] if rest else root):
                return LocalType("external", path)
            return None

        base = self._root_target(module, module, root)
        if base is None:
            return None
        found = self._walk_dotted(base, rest) if rest else base
        if found is None:
            # A dotted path into a module we do parse, landing on nothing --
            # not something to invent an answer for.
            return None
        symbol = self.symbols.get(found)
        if symbol is None:
            return None
        if want_callable:
            return LocalType("project", found) if symbol.kind in _CALLABLE_KINDS else None
        return LocalType("project", found) if symbol.kind == "class" else None

    def _local_type(self, scope_id: str, name: str) -> LocalType | None:
        """A local's type, searching enclosing function scopes for a closure."""
        seen = 0
        current: str | None = scope_id
        while current and seen < _MAX_SCOPE_DEPTH:
            found = self.local_types.get(current, {}).get(name)
            if found is not None:
                return found
            symbol = self.symbols.get(current)
            parent = self.symbols.get(symbol.parent) if symbol and symbol.parent else None
            # A closure sees the enclosing FUNCTION's locals.  A class body in
            # between does not pass them through, which is a real Python rule
            # and not a simplification.
            current = parent.symbol_id if parent and parent.kind in ("function", "method") else None
            seen += 1
        return None

    def _foreign_base(self, class_id: str, depth: int = 0) -> str | None:
        """A base class of ``class_id`` we hold no definition for, if any.

        The reason an in-project receiver can still swallow a method call: you
        subclass a framework's class and call ITS methods on your instance.
        Measured across two codebases, this is where essentially every
        classifiable receiver call lands -- textual's App under carnot's
        CarnotApp, django's ModelForm under hypermenu's ItemForm.
        """
        if depth > _MAX_MRO_DEPTH:
            return None
        klass = self.symbols.get(class_id)
        if klass is None:
            return None
        for base in klass.bases:
            text = base.split("[", 1)[0].split("(", 1)[0].strip()
            if not text or "=" in text:
                continue
            base_id = self._resolve_class_ref(base, klass.module)
            if base_id is None:
                return self._external_base_path(text, klass.module)
            if base_id != class_id:
                found = self._foreign_base(base_id, depth + 1)
                if found:
                    return found
        return None

    def _external_base_path(self, text: str, module: str) -> str:
        """A foreign base's dotted path, using the import that brought it in."""
        segments = text.split(".")
        binding = self.bindings.get(module, {}).get(segments[0])
        if binding is not None and binding.kind in ("external", "module"):
            return ".".join([binding.target, *segments[1:]])
        return text

    # -- lookup helpers ----------------------------------------------------

    def _fallback_by_name(self, name: str, outcome, receiver: str | None = None) -> Resolution:
        """Last resort: a project-unique bare name is probably the right target."""
        candidates = self.by_name.get(name, [])
        if len(candidates) == 1:
            return outcome(candidates[0], "heuristic", reason="unique name in project")
        if candidates:
            return outcome(None, "unresolved", reason=f"ambiguous: {len(candidates)} symbols named {name!r}")
        if receiver:
            return outcome(None, "unresolved", reason=f"unknown receiver {receiver!r}")
        return outcome(None, "unresolved", reason="not defined in project")

    def _is_callable(self, symbol_id: str) -> bool:
        """True when ``symbol_id`` names something a call could land on."""
        symbol = self.symbols.get(symbol_id)
        return symbol is not None and symbol.kind in _CALLABLE_KINDS

    def _enclosing_class(self, symbol_id: str) -> str | None:
        """The class owning ``symbol_id``, walking out through nested defs."""
        current = self.symbols.get(symbol_id)
        while current is not None and current.parent:
            parent = self.symbols.get(current.parent)
            if parent is None:
                return None
            if parent.kind == "class":
                return parent.symbol_id
            current = parent
        return None

    def _lookup_member(self, class_id: str, name: str, depth: int = 0) -> str | None:
        """Find a method on a class or its in-project base classes."""
        if depth > _MAX_MRO_DEPTH:
            return None
        member = self.class_members.get(class_id, {}).get(name)
        if member:
            return member

        klass = self.symbols.get(class_id)
        if klass is None:
            return None
        for base in klass.bases:
            base_id = self._resolve_class_ref(base, klass.module)
            if base_id and base_id != class_id:
                found = self._lookup_member(base_id, name, depth + 1)
                if found:
                    return found
        return None

    def _resolve_class_ref(self, raw: str, module: str) -> str | None:
        """Resolve a superclass expression such as ``Base`` or ``mod.Base``."""
        text = raw.split("[", 1)[0].split("(", 1)[0].strip()
        if not text or "=" in text:  # metaclass=..., keyword bases
            return None
        segments = text.split(".")
        if len(segments) == 1:
            candidate = self.module_members.get(module, {}).get(segments[0])
            if candidate:
                return candidate
            binding = self.bindings.get(module, {}).get(segments[0])
            if binding is not None and binding.kind == "symbol":
                return binding.target
            return None
        base = self._root_target(module, module, segments[0])
        return self._walk_dotted(base, segments[1:]) if base else None

    def _lookup_local(self, caller_id: str, name: str) -> str | None:
        """A nested definition inside the calling symbol, or a sibling of it."""
        for scope in (caller_id, self.symbols[caller_id].parent if caller_id in self.symbols else None):
            if not scope:
                continue
            candidate = f"{scope}.{name}"
            if self._is_callable(candidate):
                return candidate
        return None

    def _root_target(self, module: str, caller_id: str, root: str) -> str | None:
        """Dotted path a call's leading identifier refers to, if anything."""
        binding = self.bindings.get(module, {}).get(root)
        if binding is not None and binding.kind in ("module", "symbol"):
            return binding.target

        member = self.module_members.get(module, {}).get(root)
        if member:
            return member

        local = self._lookup_local(caller_id, root)
        if local:
            return local

        if root in self.modules:
            return root
        return None

    def _walk_dotted(self, base: str, rest: Iterable[str]) -> str | None:
        """Walk ``rest`` from ``base`` through modules and symbols."""
        current = base
        for segment in rest:
            if current in self.modules:
                found = self._module_member(current, segment)
                if found:
                    current = found
                    continue
            candidate = f"{current}.{segment}"
            if self._is_callable(candidate) or candidate in self.modules:
                current = candidate
                continue
            return None
        return current if self._is_callable(current) else None

    def _module_member(
        self, module: str, name: str, seen: set[str] | None = None, depth: int = 0
    ) -> str | None:
        """Find ``name`` in a module's namespace, following re-exports.

        Packages routinely publish their API from ``__init__.py`` -- explicitly
        with ``from .core import thing``, or wholesale with ``from .core import
        *``.  Without following those, every ``nx.shortest_path()`` style call
        in the wild goes unresolved.
        """
        direct = self.module_members.get(module, {}).get(name)
        if direct:
            return direct

        binding = self.bindings.get(module, {}).get(name)
        if binding is not None and binding.kind == "symbol":
            return binding.target

        if depth >= _MAX_REEXPORT_DEPTH:
            return None
        seen = seen if seen is not None else {module}
        for source in self.wildcards.get(module, ()):
            if source in seen:
                continue
            seen.add(source)
            found = self._module_member(source, name, seen, depth + 1)
            if found:
                return found
        return None
