"""Shared fixtures: the sample project, and an on-the-fly project builder."""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent
from typing import Any, Callable, Mapping

import pytest

from adventure_call.graph import GraphBuilder, build_codebase_graph
from adventure_call.models import ParsedFile
from adventure_call.parser import CodebaseParser
from adventure_call.resolver import ResolutionIndex, SymbolResolver

SAMPLE_ROOT = Path(__file__).parent / "fixtures" / "sample_project"


@pytest.fixture(scope="session")
def sample_root() -> Path:
    return SAMPLE_ROOT


@pytest.fixture(scope="session")
def parsed_files(sample_root: Path) -> list[ParsedFile]:
    return CodebaseParser(sample_root).parse_tree()


@pytest.fixture(scope="session")
def files_by_module(parsed_files: list[ParsedFile]) -> dict[str, ParsedFile]:
    return {parsed.module: parsed for parsed in parsed_files}


@pytest.fixture(scope="session")
def index(parsed_files: list[ParsedFile], sample_root: Path) -> ResolutionIndex:
    return SymbolResolver(parsed_files, root=sample_root).resolve()


@pytest.fixture(scope="session")
def builder(parsed_files: list[ParsedFile], index: ResolutionIndex) -> GraphBuilder:
    graph_builder = GraphBuilder(parsed_files, index)
    graph_builder.build()
    return graph_builder


@pytest.fixture
def analyse(tmp_path: Path) -> Callable[..., tuple[GraphBuilder, list[ParsedFile], ResolutionIndex]]:
    """Write a throwaway project and run the whole pipeline over it."""

    def _analyse(files: Mapping[str, str], **kwargs: Any):
        for rel, text in files.items():
            path = tmp_path / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(dedent(text).lstrip("\n"), encoding="utf-8")
        return build_codebase_graph(tmp_path, **kwargs)

    return _analyse


@pytest.fixture
def parse_source() -> Callable[[str], ParsedFile]:
    """Parse a snippet as module ``m``, without touching the filesystem.

    For assertions about what the PARSER extracts, where writing a project and
    running the whole pipeline (see ``analyse``) would answer a different and
    larger question.
    """

    def _parse(source: str) -> ParsedFile:
        return CodebaseParser(root=".").parse_source(
            dedent(source).lstrip("\n").encode("utf-8"), file_path="m.py", module="m"
        )

    return _parse


@pytest.fixture
def symbol(index: ResolutionIndex):
    """Look a symbol up by id, failing the test with a readable message."""

    def _symbol(symbol_id: str):
        assert symbol_id in index.symbols, f"{symbol_id} missing from {sorted(index.symbols)}"
        return index.symbols[symbol_id]

    return _symbol
