"""The agent query layer over a written analysis (tic-5671)."""

from __future__ import annotations

from pathlib import Path

import pytest

from adventure_call.query import (
    NotFound,
    QueryError,
    Workspace,
    is_test_path,
    match_role,
    strongly_connected,
)
from adventure_call.writer import OutputWriter


@pytest.fixture(scope="module")
def ws(tmp_path_factory, sample_root, builder, index, parsed_files) -> Workspace:
    out = tmp_path_factory.mktemp("store")
    OutputWriter(out).write_all(builder.graph, index, parsed_files, root=sample_root)
    return Workspace.load(out)


# -- resolution ---------------------------------------------------------------


def test_resolve_accepts_exact_suffix_file_and_line(ws):
    assert ws.resolve("src.auth.login_user") == "src.auth.login_user"
    assert ws.resolve("auth.login_user") == "src.auth.login_user"
    assert ws.resolve("login_user") == "src.auth.login_user"
    assert ws.resolve("src/auth.py") == "src.auth"
    # Line 13 sits inside login_user's body.
    assert ws.resolve("src/auth.py:13") == "src.auth.login_user"


def test_resolve_prefers_innermost_symbol_on_a_line(ws):
    # models.py line 15 is inside User.greet, which is inside User.
    assert ws.resolve("src/models.py:15") == "src.models.User.greet"


def test_resolve_ambiguous_lists_candidates(ws):
    with pytest.raises(QueryError) as caught:
        ws.resolve("greet")
    assert "ambiguous" in caught.value.payload["error"]
    assert len(caught.value.payload["candidates"]) == 2


def test_resolve_unknown_suggests(ws):
    with pytest.raises(NotFound) as caught:
        ws.resolve("src.auth.login_usr")
    assert "src.auth.login_user" in caught.value.payload["did_you_mean"]
    assert caught.value.exit_code == 2


# -- queries ------------------------------------------------------------------


def test_find_ranks_exact_name_first(ws):
    matches = ws.find("greet")["matches"]
    assert matches[0].startswith("src.models.")
    assert all("greet" in m for m in matches)


def test_symbol_reports_callers_callees_and_state(ws):
    out = ws.symbol("login_user")
    assert out["at"] == "src/auth.py:8-15"
    assert out["doc"] == "Authenticate a user and open a session."
    assert any(c.startswith("src.api.handle_login src/api.py:") for c in out["callers"])
    assert any(c.startswith("src.models.make_user ") for c in out["callees"])
    # `SESSIONS[name] = user` mutates through a subscript: a READ of the name.
    assert "src.auth.SESSIONS" in out["reads"]
    assert out["metrics"]["fan_in"] == 1
    assert "code" not in out
    assert "def login_user" in ws.symbol("login_user", code=True)["code"]


def test_symbol_omits_empty_fields(ws):
    out = ws.symbol("src.api.Router.fallback")
    assert all(value not in (None, [], {}) for value in out.values())


def test_file_outline_and_imports(ws):
    out = ws.file("src/api.py")
    assert set(out["imports"]) == {"src/auth.py", "src/models.py"}
    assert "login_user" in out["imports"]["src/auth.py"]
    assert "json" in out["external"]
    assert any("def handle_login(payload: str) -> str" in row for row in out["outline"])
    assert any(row.startswith("  L") and "dispatch" in row for row in out["outline"])
    assert ws.file("src/auth.py")["imported_by"] == ["src/api.py"]


def test_tree_sizes_by_metric_and_depth(ws):
    out = ws.tree(depth=2, metric="files")
    assert out["tree"]["_total"] == 5
    assert out["tree"]["src/"]["api.py"] == 1
    collapsed = ws.tree(depth=1, metric="files")["tree"]
    assert collapsed["src/"] == 4
    assert ws.tree("src", metric="files")["tree"]["_total"] == 4
    with pytest.raises(NotFound):
        ws.tree("nope")


def test_imports_local_view_by_direction(ws):
    both = ws.imports("src/auth.py")
    assert both["imports"] == {"src/models.py": 1}
    assert both["imported_by"] == {"src/api.py": 1}
    assert "src/api.py -> src/auth.py" in both["edges"]
    down = ws.imports("src/api.py", direction="out", depth=2)
    assert "imported_by" not in down
    assert set(down["imports"]) == {"src/auth.py", "src/models.py"}


def test_imports_whole_graph(ws):
    out = ws.imports()
    assert out["files"] == 5
    assert "src/api.py -> src/models.py" in out["edges"]


def test_calls_cones(ws):
    down = ws.calls("src.api.handle_login", depth=3)
    assert down["nodes"]["src.api.handle_login"].startswith("0 ")
    assert down["nodes"]["src.auth.login_user"].startswith("+1 ")
    assert "src.api.handle_login -> src.auth.login_user" in down["edges"]
    up = ws.calls("src.models.make_user", direction="up")
    assert up["nodes"]["src.auth.login_user"].startswith("-1 ")
    assert up["nodes"]["src.api.handle_login"].startswith("-2 ")


def test_calls_budget_truncates_whole_levels(ws):
    out = ws.calls("src.api.handle_login", depth=5, budget=1)
    assert out["truncated"] is True
    assert list(out["nodes"]) == ["src.api.handle_login"]
    assert out["beyond"] > 0


def test_entries_and_orphans(ws):
    out = ws.entries()
    ids = [row.split()[0] for row in out["entries"]]
    assert "src.api.Router.dispatch" in ids
    assert "src.auth.login_user" not in ids  # it has a caller


def test_impact_of_variable_walks_callers(ws):
    out = ws.impact("src.auth.SESSIONS")
    assert any(r.startswith("src.auth.login_user") for r in out["readers"])
    assert "src.api.handle_login" in out["reached_via_calls"]
    assert "src/api.py" in out["files"]


def test_impact_of_file_walks_importers(ws):
    out = ws.impact("src/models.py")
    assert out["importers"] == {"src/api.py": 1, "src/auth.py": 1}


def test_state_through_calls(ws):
    out = ws.state("src.api.handle_login")
    assert "src.auth" in out["through_calls"]
    assert "SESSIONS:r" in out["through_calls"]["src.auth"]


def test_overview_has_the_map(ws):
    out = ws.overview()
    assert out["counts"]["files"] == 5
    assert out["entries"]
    assert out["most_imported"][0].startswith("src/")


# -- building blocks ----------------------------------------------------------


def test_strongly_connected_ids_are_reverse_topological():
    component_of, members = strongly_connected({"a": ["b"], "b": ["c", "a"], "c": []})
    assert component_of["a"] == component_of["b"]
    assert component_of["c"] < component_of["a"]
    assert sorted(len(m) for m in members) == [1, 2]


def test_roles_and_test_paths():
    assert is_test_path("tests/test_x.py") and is_test_path("app/tests.py")
    assert not is_test_path("src/latest.py")
    assert match_role({"name": "x", "file_path": "a.py", "decorators": ["@pytest.fixture"]})[0] == "fixture"
    assert match_role({"name": "x", "file_path": "a.py", "decorators": ["@fixture(scope='s')"]})[0] == "fixture"
    assert match_role({"name": "__repr__", "file_path": "a.py", "decorators": []})[0] == "dunder"
    assert match_role({"name": "x", "file_path": "a.py", "decorators": ["@staticmethod"]}) is None
