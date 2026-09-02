"""Graph shape, edge folding and the level-of-detail room context."""

from __future__ import annotations

import networkx as nx
import pytest

from adventure_call.graph import CALLS, CONTAINS, IMPORTS, GraphBuilder, SymbolNotFoundError


# -- graph shape -----------------------------------------------------------


def test_graph_holds_symbols_and_modules(builder):
    graph = builder.graph
    assert isinstance(graph, nx.DiGraph)
    kinds = {node: data["kind"] for node, data in graph.nodes(data=True)}
    assert kinds["src.auth.login_user"] == "function"
    assert kinds["src.models.User"] == "class"
    assert kinds["src.models.User.greet"] == "method"
    assert kinds["src.auth"] == "module"


def test_nodes_carry_stubs(builder):
    stub = builder.graph.nodes["src.auth.login_user"]["stub"]
    assert stub.rstrip().endswith("...")
    assert "SESSIONS[name] = user" not in stub


def test_call_edges_point_from_caller_to_callee(builder):
    graph = builder.graph
    assert graph.has_edge("src.api.handle_login", "src.auth.login_user")
    data = graph.edges["src.api.handle_login", "src.auth.login_user"]
    assert data["type"] == CALLS
    assert data["confidence"] == "exact"
    assert data["lines"] == [13]


def test_import_edges_start_at_the_module(builder):
    data = builder.graph.edges["src.auth", "src.models.User"]
    assert data["type"] == IMPORTS
    assert data["aliases"] == ["User"]


def test_external_imports_are_omitted_by_default(builder):
    assert not any(n.startswith("external:") for n in builder.graph)


def test_external_imports_can_be_included(parsed_files, index):
    graph = GraphBuilder(parsed_files, index, external_imports=True).build()
    assert graph.has_edge("src.api", "external:json")


def test_repeated_calls_fold_into_one_edge(analyse):
    builder, _, _ = analyse(
        {
            "m.py": """
            def target(): ...


            def caller():
                target()
                target()
            """
        }
    )
    data = builder.graph.edges["m.caller", "m.target"]
    assert data["count"] == 2
    assert data["lines"] == [5, 6]


def test_module_level_calls_are_edgeless_by_default(analyse):
    builder, files, index = analyse({"m.py": "def go(): ...\n\ngo()\n"})
    assert not builder.graph.has_edge("m", "m.go")
    with_edges = GraphBuilder(files, index, module_call_edges=True).build()
    assert with_edges.has_edge("m", "m.go")


def test_heuristic_edges_can_be_dropped(analyse):
    files_map = {
        "a.py": "def only_one_of_these(): ...\n",
        "b.py": "def go(thing):\n    return thing.only_one_of_these()\n",
    }
    builder, files, index = analyse(files_map)
    assert builder.graph.has_edge("b.go", "a.only_one_of_these")
    strict = GraphBuilder(files, index, include_heuristic=False).build()
    assert not strict.has_edge("b.go", "a.only_one_of_these")


def test_contains_edges_are_opt_in(parsed_files, index):
    graph = GraphBuilder(parsed_files, index, contains_edges=True).build()
    data = graph.edges["src.models.User", "src.models.User.greet"]
    assert data["type"] == CONTAINS


def test_variables_and_attributes_are_nodes(builder):
    kinds = {node: data["kind"] for node, data in builder.graph.nodes(data=True)}
    assert kinds["src.auth.SESSIONS"] == "variable"
    assert kinds["src.models.User.role"] == "attribute"
    assert builder.graph.nodes["src.auth.SESSIONS"]["stub"] == "SESSIONS: dict[str, User] = {}"


def test_no_call_edge_ever_lands_on_a_variable(builder):
    graph = builder.graph
    assert not [
        (u, v)
        for u, v, data in graph.edges(data=True)
        if data["type"] == CALLS and graph.nodes[v]["kind"] in ("variable", "attribute")
    ]


def test_contains_edges_reach_variables_and_attributes(parsed_files, index):
    graph = GraphBuilder(parsed_files, index, contains_edges=True).build()
    assert graph.edges["src.auth", "src.auth.SESSIONS"]["type"] == CONTAINS
    assert graph.edges["src.models.User", "src.models.User.role"]["type"] == CONTAINS


# -- room context ----------------------------------------------------------


def test_room_gives_full_code_for_the_focus(builder):
    room = builder.get_room_context("src.auth.login_user")
    assert room.focus["code"].startswith("def login_user(")
    assert "SESSIONS[name] = user" in room.focus["code"], "the focus is not stubbed"


def test_upstream_is_signatures_only(builder):
    room = builder.get_room_context("src.auth.login_user")
    caller = next(item for item in room.upstream if item["symbol_id"] == "src.api.handle_login")
    assert caller["signature"] == "def handle_login(payload: str) -> str:"
    assert "code" not in caller and "docstring" not in caller
    assert caller["call_lines"] == [13]


def test_downstream_adds_docstrings_but_no_bodies(builder):
    room = builder.get_room_context("src.auth.login_user")
    callee = next(item for item in room.downstream if item["symbol_id"] == "src.models.make_user")
    assert callee["docstring"].startswith("Build a")
    assert "code" not in callee


def test_room_reports_dead_end_calls(builder):
    room = builder.get_room_context("src.auth.logout_user")
    assert [item["raw_name"] for item in room.unresolved] == ["SESSIONS.pop"]


def test_room_follows_only_the_requested_edge_types(builder):
    calls_room = builder.get_room_context("src.models.User")
    assert {item["symbol_id"] for item in calls_room.upstream} == {"src.models.make_user"}

    imports_room = builder.get_room_context("src.models.User", edge_types=[IMPORTS])
    assert {item["symbol_id"] for item in imports_room.upstream} == {"src.auth"}


def test_room_truncation_is_reported(builder):
    room = builder.get_room_context("src.models.User._format", max_neighbors=1)
    assert len(room.upstream) == 1
    assert room.truncated == {"upstream": 1}


def test_unknown_symbol_raises_with_suggestions(builder):
    with pytest.raises(SymbolNotFoundError) as excinfo:
        builder.get_room_context("src.auth.login")
    assert "src.auth.login_user" in excinfo.value.suggestions
    assert "src.auth.login_user" in str(excinfo.value)


def test_room_markdown_is_prompt_ready(builder):
    text = builder.get_room_context("src.auth.login_user").to_markdown()
    assert text.startswith("# src.auth.login_user")
    assert "## Definition" in text
    assert "## Called by (1)" in text
    assert "## Calls (1)" in text
    assert "```python" in text


def test_room_dict_round_trips_the_sections(builder):
    data = builder.get_room_context("src.auth.login_user").to_dict()
    assert set(data) == {
        "symbol_id",
        "focus",
        "upstream",
        "downstream",
        "unresolved",
        "truncated",
    }


def test_module_nodes_can_be_rooms(builder):
    room = builder.get_room_context("src.api", edge_types=[IMPORTS])
    assert {item["symbol_id"] for item in room.downstream} == {
        "src.auth.login_user",
        "src.auth.logout_user",
        "src.models",
    }


def test_leaf_symbol_reads_cleanly(builder):
    text = builder.get_room_context("src.api.Router.fallback").to_markdown()
    assert "_It calls nothing else in this codebase._" in text


# -- READS / WRITES edges (tic-13d7) ----------------------------------------

_COUPLED = {
    "m.py": (
        "LIMIT = 5\n"
        "class K:\n"
        "    def __init__(self):\n"
        "        self.cursor = 0\n"
        "    def show(self):\n"
        "        return self.cursor + LIMIT\n"
        "    def bump(self):\n"
        "        self.cursor += 1\n"
    )
}


def test_a_read_and_a_write_are_different_edge_types(analyse):
    """Two types rather than one with a flag, because the questions are
    different and a consumer usually wants exactly one: "what does this depend
    on" is READS, "what does changing this break" is WRITES."""
    builder, _, _ = analyse(_COUPLED)
    assert builder.graph.edges["m.K.__init__", "m.K.cursor"]["types"] == ["WRITES"]
    assert builder.graph.edges["m.K.show", "m.K.cursor"]["types"] == ["READS"]


def test_a_pair_that_is_both_carries_both_names(analyse):
    """`self.cursor += 1` is a read AND a write of one pair, and `_merge_edge`
    already knows how to hold two type names -- it does the same for a pair
    that is both a call and an import."""
    builder, _, _ = analyse(_COUPLED)
    types = builder.graph.edges["m.K.bump", "m.K.cursor"]["types"]
    assert sorted(types) == ["READS", "WRITES"]


def test_two_methods_that_never_call_each_other_are_joined_through_the_data(analyse):
    """The point of the edge type.  Nothing in CALLS connects `show` to
    `__init__`, and no amount of call-graph analysis would produce it."""
    builder, _, _ = analyse(_COUPLED)
    assert not builder.graph.has_edge("m.K.show", "m.K.__init__")
    assert not builder.graph.has_edge("m.K.__init__", "m.K.show")
    assert builder.graph.has_edge("m.K.__init__", "m.K.cursor")
    assert builder.graph.has_edge("m.K.show", "m.K.cursor")


def test_a_module_level_accessor_survives_the_module_call_edge_flag(analyse):
    """That flag is about calls executed at import time.  A module reading
    another module's constant is not a call at all, and dropping it would
    remove the plainest data dependency there is."""
    builder, _, _ = analyse(
        {
            "pkg/__init__.py": "",
            "pkg/config.py": "LIMIT = 5\n",
            "pkg/use.py": "from .config import LIMIT\nTOTAL = LIMIT * 2\n",
        },
        module_call_edges=False,
    )
    assert builder.graph.has_edge("pkg.use", "pkg.config.LIMIT")
