"""Language registry: grammar loading, query compilation and module naming.

Only Python ships enabled today.  Adding JavaScript/TypeScript is a matter of
registering another :class:`LanguageSpec` plus a ``queries/<name>.scm`` file --
the parser dispatches purely on capture names, so no parser changes are needed
for a language whose queries use the same capture vocabulary.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Callable

import tree_sitter
from tree_sitter import Language, Parser, Query

QUERY_DIR = Path(__file__).parent / "queries"


class GrammarUnavailable(RuntimeError):
    """Raised when a language's tree-sitter binding cannot be used."""


@dataclass(frozen=True)
class LanguageSpec:
    """Static description of a supported language."""

    name: str
    extensions: tuple[str, ...]
    binding_module: str
    query_file: str
    language_attr: str = "language"
    enabled: bool = True


@dataclass
class LoadedLanguage:
    """A grammar that has been imported, plus its parser and compiled query."""

    spec: LanguageSpec
    language: Language
    parser: Parser
    query: Query


SPECS: tuple[LanguageSpec, ...] = (
    LanguageSpec(
        name="python",
        extensions=(".py", ".pyi"),
        binding_module="tree_sitter_python",
        query_file="python.scm",
    ),
    # Declared but disabled: install the `js` extra and flip `enabled` once
    # queries/javascript.scm and queries/typescript.scm exist.
    LanguageSpec(
        name="javascript",
        extensions=(".js", ".jsx", ".mjs", ".cjs"),
        binding_module="tree_sitter_javascript",
        query_file="javascript.scm",
        enabled=False,
    ),
    LanguageSpec(
        name="typescript",
        extensions=(".ts", ".tsx"),
        binding_module="tree_sitter_typescript",
        query_file="typescript.scm",
        language_attr="language_typescript",
        enabled=False,
    ),
)

_BY_EXTENSION: dict[str, LanguageSpec] = {
    ext: spec for spec in SPECS if spec.enabled for ext in spec.extensions
}


def spec_for_path(path: Path | str) -> LanguageSpec | None:
    """Return the language spec handling ``path``, or None if unsupported."""
    return _BY_EXTENSION.get(Path(path).suffix.lower())


def supported_extensions() -> tuple[str, ...]:
    """Every file extension the enabled languages claim."""
    return tuple(sorted(_BY_EXTENSION))


@lru_cache(maxsize=None)
def load_language(spec: LanguageSpec) -> LoadedLanguage:
    """Import a grammar, build its parser and compile its query set.

    Cached, so grammars and queries are compiled once per process.

    Raises:
        GrammarUnavailable: the binding is missing, the query file is absent,
            or the query does not compile against this grammar version.
    """
    try:
        binding = importlib.import_module(spec.binding_module)
    except ImportError as exc:  # pragma: no cover - depends on optional extras
        raise GrammarUnavailable(
            f"tree-sitter binding {spec.binding_module!r} is not installed "
            f"(pip install {spec.binding_module.replace('_', '-')})"
        ) from exc

    factory: Callable[[], object] | None = getattr(binding, spec.language_attr, None)
    if factory is None:  # pragma: no cover - binding API drift
        raise GrammarUnavailable(
            f"{spec.binding_module!r} has no {spec.language_attr}() entry point"
        )

    query_path = QUERY_DIR / spec.query_file
    try:
        query_source = query_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise GrammarUnavailable(f"cannot read query file {query_path}: {exc}") from exc

    try:
        language = Language(factory())
        parser = Parser(language)
        query = Query(language, query_source)
    except (ValueError, TypeError, tree_sitter.QueryError) as exc:
        raise GrammarUnavailable(
            f"grammar {spec.name!r} is unusable with this tree-sitter build: {exc}"
        ) from exc

    return LoadedLanguage(spec=spec, language=language, parser=parser, query=query)


def module_name_for_path(rel_path: str | PurePosixPath, strip_prefix: str = "") -> str:
    """Map a repo-relative source path to a dotted module name.

    ``src/auth.py`` becomes ``src.auth`` and ``src/__init__.py`` becomes
    ``src``.  With ``strip_prefix="src"`` those become ``auth`` and ``""``.
    """
    parts = list(PurePosixPath(str(rel_path).replace("\\", "/")).parts)
    if not parts:
        return ""

    parts[-1] = PurePosixPath(parts[-1]).stem
    if parts[-1] == "__init__":
        parts.pop()

    if strip_prefix:
        prefix = [p for p in strip_prefix.replace("\\", "/").strip("/").split("/") if p]
        if parts[: len(prefix)] == prefix:
            parts = parts[len(prefix) :]

    # Segments that cannot appear in a dotted name (e.g. "my-dir") are
    # normalised rather than dropped, so ids stay unique and traceable.
    cleaned = [
        "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in part) for part in parts
    ]
    return ".".join(p for p in cleaned if p)
