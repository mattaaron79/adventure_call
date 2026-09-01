"""JSON exports and the command line entry point."""

from __future__ import annotations

import json
from pathlib import Path

import networkx as nx

from adventure_call.cli import main
from adventure_call.writer import (
    GRAPH_FILENAME,
    REGISTRY_FILENAME,
    SCHEMA_VERSION,
    OutputWriter,
)


def _write(tmp_path: Path, builder, index, parsed_files, **kwargs) -> dict[str, Path]:
    writer = OutputWriter(tmp_path / "out", **kwargs)
    return writer.write_all(builder.graph, index, parsed_files, root="sample")


# -- graph export ----------------------------------------------------------


def test_write_all_produces_both_files(tmp_path, builder, index, parsed_files):
    written = _write(tmp_path, builder, index, parsed_files)
    assert written["graph"].name == GRAPH_FILENAME
    assert written["registry"].name == REGISTRY_FILENAME
    assert all(path.exists() for path in written.values())


def test_graph_json_round_trips_through_networkx(tmp_path, builder, index, parsed_files):
    path = _write(tmp_path, builder, index, parsed_files)["graph"]
    data = json.loads(path.read_text(encoding="utf-8"))
    restored = nx.node_link_graph(data, edges="edges")

    assert restored.number_of_nodes() == builder.graph.number_of_nodes()
    assert restored.number_of_edges() == builder.graph.number_of_edges()
    assert restored.is_directed()
    assert restored.has_edge("src.api.handle_login", "src.auth.login_user")


def test_graph_json_carries_stubs_not_bodies(tmp_path, builder, index, parsed_files):
    data = json.loads(_write(tmp_path, builder, index, parsed_files)["graph"].read_text("utf-8"))
    assert all("code" not in node for node in data["nodes"])
    login = next(n for n in data["nodes"] if n["id"] == "src.auth.login_user")
    assert login["stub"].rstrip().endswith("...")


def test_graph_json_records_run_metadata(tmp_path, builder, index, parsed_files):
    data = json.loads(_write(tmp_path, builder, index, parsed_files)["graph"].read_text("utf-8"))
    meta = data["graph"]
    assert meta["schema_version"] == SCHEMA_VERSION
    assert meta["root"] == "sample"
    assert meta["root_abs"] == Path("sample").resolve().as_posix()
    assert meta["stats"]["edge_types"]["CALLS"] > 0
    assert meta["generated_at"].endswith("+00:00")


def test_root_abs_resolves_a_relative_root(tmp_path, builder, index, parsed_files):
    # The ticket's repro: root is relative to the generation cwd ('../carnot'),
    # which the browser cannot resolve; root_abs must pin the same directory in
    # an absolute, POSIX-style form (tic-7f0b).
    writer = OutputWriter(tmp_path / "out")
    written = writer.write_all(builder.graph, index, parsed_files, root=Path("..") / "carnot")
    data = json.loads(written["graph"].read_text("utf-8"))
    expected = (Path("..") / "carnot").resolve().as_posix()

    assert data["graph"]["root"] == "../carnot"
    assert data["graph"]["root_abs"] == expected
    assert ":" in expected.split("/", 1)[0] or expected.startswith("/"), expected


def test_root_abs_empty_when_no_root_given(tmp_path, builder, index, parsed_files):
    writer = OutputWriter(tmp_path / "out")
    written = writer.write_all(builder.graph, index, parsed_files, root="")
    data = json.loads(written["graph"].read_text("utf-8"))
    assert data["graph"]["root"] == ""
    assert data["graph"]["root_abs"] == ""


# -- registry export -------------------------------------------------------


def test_registry_records_absolute_root(tmp_path, builder, index, parsed_files):
    data = json.loads(_write(tmp_path, builder, index, parsed_files)["registry"].read_text("utf-8"))
    assert data["root"] == "sample"
    assert data["root_abs"] == Path("sample").resolve().as_posix()


def test_registry_holds_full_metadata(tmp_path, builder, index, parsed_files):
    data = json.loads(_write(tmp_path, builder, index, parsed_files)["registry"].read_text("utf-8"))
    login = data["symbols"]["src.auth.login_user"]

    assert "SESSIONS[name] = user" in login["code"]
    assert login["params"][0] == {
        "name": "name",
        "annotation": "str",
        "default": None,
        "kind": "positional",
    }
    assert data["modules"]["src.auth"]["file_path"] == "src/auth.py"
    assert data["bindings"]["src.auth"]["User"]["target"] == "src.models.User"


def test_stats_count_the_new_symbol_kinds(tmp_path, builder, index, parsed_files):
    data = json.loads(_write(tmp_path, builder, index, parsed_files)["graph"].read_text("utf-8"))
    kinds = data["graph"]["stats"]["node_kinds"]
    assert kinds["variable"] == 1 and kinds["attribute"] == 2


def test_registry_lists_variables_among_a_module_symbols(tmp_path, builder, index, parsed_files):
    data = json.loads(_write(tmp_path, builder, index, parsed_files)["registry"].read_text("utf-8"))
    assert "src.auth.SESSIONS" in data["modules"]["src.auth"]["symbol_ids"]
    assert data["symbols"]["src.auth.SESSIONS"]["kind"] == "variable"
    # tic-82b0 asserted here that new symbol KINDS are additive and need no
    # bump, which is still true; the version has since moved for an unrelated
    # reason (tic-2255 added a field), so this pins the constant rather than a
    # literal that would go stale again on the next real schema change.
    assert data["schema_version"] == SCHEMA_VERSION


def test_registry_reports_unresolved_calls_and_diagnostics(
    tmp_path, builder, index, parsed_files
):
    data = json.loads(_write(tmp_path, builder, index, parsed_files)["registry"].read_text("utf-8"))
    assert any(item["raw_name"] == "json.loads" for item in data["unresolved_calls"])
    assert any(item["kind"] == "syntax_error" for item in data["diagnostics"])


def test_source_can_be_omitted(tmp_path, builder, index, parsed_files):
    written = _write(tmp_path, builder, index, parsed_files, include_source=False)
    data = json.loads(written["registry"].read_text("utf-8"))
    assert data["includes_source"] is False
    assert "code" not in data["symbols"]["src.auth.login_user"]
    assert data["symbols"]["src.auth.login_user"]["stub"]


def test_rewriting_leaves_no_temp_files_and_no_partial_json(
    tmp_path, builder, index, parsed_files
):
    out = _write(tmp_path, builder, index, parsed_files)["graph"].parent
    before = json.loads((out / GRAPH_FILENAME).read_text("utf-8"))

    _write(tmp_path, builder, index, parsed_files)
    after = json.loads((out / GRAPH_FILENAME).read_text("utf-8"))

    assert not list(out.glob(".*.tmp")), "temp files must be cleaned up"
    assert not list(out.glob("*.tmp"))
    assert after["nodes"] == before["nodes"]  # only the timestamp may differ
    assert after["edges"] == before["edges"]


def test_unicode_survives_the_round_trip(tmp_path, analyse):
    builder, files, index = analyse({"m.py": 'def go():\n    """Grüße, 世界."""\n'})
    OutputWriter(tmp_path / "out").write_all(builder.graph, index, files)
    data = json.loads((tmp_path / "out" / REGISTRY_FILENAME).read_text("utf-8"))
    assert data["symbols"]["m.go"]["docstring"] == "Grüße, 世界."


# -- CLI -------------------------------------------------------------------


def test_cli_writes_both_files(tmp_path, sample_root, capsys):
    code = main([str(sample_root), "--out-dir", str(tmp_path)])
    assert code == 0
    assert (tmp_path / GRAPH_FILENAME).exists()
    assert (tmp_path / REGISTRY_FILENAME).exists()


def test_cli_prints_a_room(tmp_path, sample_root, capsys):
    code = main([str(sample_root), "--out-dir", str(tmp_path), "--room", "src.auth.login_user"])
    assert code == 0
    assert "# src.auth.login_user" in capsys.readouterr().out


def test_cli_room_as_json(tmp_path, sample_root, capsys):
    main(
        [
            str(sample_root),
            "--out-dir",
            str(tmp_path),
            "--no-write",
            "--room",
            "src.auth.login_user",
            "--format",
            "json",
        ]
    )
    payload = json.loads(capsys.readouterr().out)
    assert payload["symbol_id"] == "src.auth.login_user"
    assert not (tmp_path / GRAPH_FILENAME).exists(), "--no-write must not write"


def test_cli_reports_an_unknown_room(tmp_path, sample_root):
    assert main([str(sample_root), "--out-dir", str(tmp_path), "--room", "nope.nope"]) == 1


def test_cli_rejects_a_missing_root(tmp_path):
    assert main([str(tmp_path / "does-not-exist"), "--out-dir", str(tmp_path)]) == 2


def test_cli_strip_prefix_shortens_module_ids(tmp_path, sample_root):
    main([str(sample_root), "--out-dir", str(tmp_path), "--strip-prefix", "src"])
    data = json.loads((tmp_path / GRAPH_FILENAME).read_text("utf-8"))
    ids = {node["id"] for node in data["nodes"]}
    assert "auth.login_user" in ids
    assert "src.auth.login_user" not in ids
