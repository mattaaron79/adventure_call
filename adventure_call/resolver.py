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
from typing import Iterable, Literal, Sequence

from adventure_call.models import (
    CallSite,
    ImportRecord,
    ParsedFile,
    Resolution,
    SymbolDef,
)

BindingKind = Literal["module", "symbol", "external"]

# Variables and class attributes are symbols, but they are not call targets:
# they are indexed and reachable, and never the answer to "what does this call?"
_CALLABLE_KINDS = frozenset({"function", "method", "class"})
_BUILTIN_NAMES = frozenset(dir(builtins))
_SELF_NAMES = frozenset({"self", "cls"})
_MAX_MRO_DEPTH = 8
_MAX_REEXPORT_DEPTH = 6


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
    ) -> None:
        self.files = list(parsed_files)
        self.resolve_module_level_calls = resolve_module_level_calls

        self.symbols: dict[str, SymbolDef] = {}
        self.modules: dict[str, ParsedFile] = {}
        self.packages: set[str] = set()
        # module -> {top-level name: symbol_id}
        self.module_members: dict[str, dict[str, str]] = defaultdict(dict)
        # class symbol_id -> {member name: symbol_id}
        self.class_members: dict[str, dict[str, str]] = defaultdict(dict)
        # bare name -> every symbol id carrying it (unique-name fallback)
        self.by_name: dict[str, list[str]] = defaultdict(list)
        self.bindings: dict[str, dict[str, Binding]] = defaultdict(dict)
        self.wildcards: dict[str, list[str]] = defaultdict(list)

        self._build_indexes()

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

        for parsed in self.files:
            for record in parsed.imports:
                self._bind_import(parsed.module, record)

    def _bind_import(self, module: str, record: ImportRecord) -> None:
        absolute = self._absolute_module(record)

        if record.is_wildcard:
            if absolute:
                self.wildcards[module].append(absolute)
            return

        if record.target_symbol is None:
            # `import a.b` binds `a`; `import a.b as c` binds `c` to `a.b`.
            target = record.target_module
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
            return record.target_module

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

        return index

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
        return self._fallback_by_name(segments[-1], outcome, receiver=root)

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
