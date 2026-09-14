"""The CLI: store lifecycle, query commands, help and exit codes (tic-49da, tic-34c1)."""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

import pytest

from adventure_call import cli
from adventure_call.store import STORE_DIRNAME, Store


def run(capsys, *argv: str) -> tuple[int, str, str]:
    code = cli.main(list(argv))
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def run_json(capsys, *argv: str) -> tuple[int, dict]:
    code, out, _ = run(capsys, *argv)
    return code, json.loads(out)


@pytest.fixture
def project(tmp_path, sample_root, monkeypatch) -> Path:
    root = tmp_path / "proj"
    shutil.copytree(sample_root, root)
    monkeypatch.chdir(root)
    return root


@pytest.fixture
def initialised(project, capsys) -> Path:
    code, summary = run_json(capsys, "init", str(project), "-q")
    assert code == 0, summary
    return project


def test_init_creates_store(initialised):
    store = initialised / STORE_DIRNAME
    for name in ("config.json", "manifest.json", "codebase_graph.json", "symbol_registry.json",
                 "AGENTS.md", ".gitignore"):
        assert (store / name).is_file(), name
    agents = (store / "AGENTS.md").read_text(encoding="utf-8")
    assert agents.startswith("<!-- Maintainers:")
    assert "as short as" in agents.splitlines()[0] + agents.splitlines()[1]


def test_init_refuses_existing_store_without_force(initialised, capsys):
    code, _, err = run(capsys, "init", str(initialised))
    assert code == 1 and "already exists" in err
    code, _, _ = run(capsys, "init", str(initialised), "--force", "-q")
    assert code == 0


def test_init_saves_options_and_update_reuses_them(initialised, capsys):
    run(capsys, "update", "--exclude", "broken.py", "-q")
    config = json.loads((initialised / STORE_DIRNAME / "config.json").read_text())
    assert config["options"]["exclude"] == ["broken.py"]
    code, out = run_json(capsys, "update", "-q")
    assert code == 0 and out["files"] == 4


def test_queries_find_store_from_subdirectory(initialised, capsys, monkeypatch):
    monkeypatch.chdir(initialised / "src")
    code, out = run_json(capsys, "symbol", "login_user")
    assert code == 0
    assert out["id"] == "src.auth.login_user"
    # A path relative to the cwd resolves too.
    code, out = run_json(capsys, "file", "api.py")
    assert out["file"] == "src/api.py"


def test_query_output_is_compact_json(initialised, capsys):
    _, out, _ = run(capsys, "overview")
    assert out.count("\n") == 1 and ", " not in out.split('"')[0]
    _, pretty, _ = run(capsys, "overview", "--pretty")
    assert json.loads(pretty) == json.loads(out)


def test_every_query_command_runs(initialised, capsys):
    for argv in (
        ["overview"], ["find", "user"], ["symbol", "src/api.py:12"], ["file", "src/auth.py"],
        ["refs", "name", "--kind", "attr"],
        ["tree", "--metric", "lines"], ["imports", "src/auth.py", "--depth", "2"],
        ["imports", "--cycles"], ["calls", "handle_login", "--direction", "both"],
        ["entries", "--include-tests"], ["impact", "SESSIONS"], ["state", "handle_login"],
        ["orphans"],
    ):
        code, out = run_json(capsys, *argv)
        assert code == 0, (argv, out)


def test_source_prints_plain_text(initialised, capsys):
    code, out, _ = run(capsys, "source", "login_user", "make_user")
    assert code == 0
    assert out.startswith("# src.auth.login_user src/auth.py:8-15\ndef login_user(")
    assert "# src.models.make_user" in out


def test_symbol_code_appends_plain_source_after_json(initialised, capsys):
    code, out, _ = run(capsys, "symbol", "login_user", "--code")
    metadata, source = out.split("\n\n", 1)
    payload = json.loads(metadata)
    assert code == 0 and "code" not in payload
    assert source.startswith("# src.auth.login_user src/auth.py:8-15\ndef login_user(")


def test_analyze_warns_when_a_store_already_exists(initialised, capsys):
    code, _, err = run(capsys, "analyze", str(initialised), "--no-write")
    assert code == 0
    assert "queries use .adventure-call/ and refresh automatically" in err


def test_exit_codes(initialised, capsys, tmp_path, monkeypatch):
    assert run_json(capsys, "find", "zzz_nothing")[0] == 2
    code, out = run_json(capsys, "symbol", "greet")
    assert code == 1 and len(out["candidates"]) == 2
    code, out = run_json(capsys, "symbol", "login_usr")
    assert code == 2 and "did_you_mean" in out
    elsewhere = tmp_path / "empty"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    code, out = run_json(capsys, "overview")
    assert code == 3 and "init" in out["error"]


def test_stale_store_refreshes_before_query(initialised, capsys):
    (initialised / "src" / "extra.py").write_text("def brand_new():\n    return 1\n", encoding="utf-8")
    code, out = run_json(capsys, "find", "brand_new", "--no-refresh")
    assert code == 2
    code, out, err = run(capsys, "find", "brand_new")
    assert code == 0 and "re-analysing" in err
    assert json.loads(out)["matches"][0].startswith("src.extra.brand_new")
    assert Store(initialised / STORE_DIRNAME).staleness() == {}


def test_staleness_reports_modified_and_deleted(initialised):
    store = Store(initialised / STORE_DIRNAME)
    assert store.staleness() == {}
    target = initialised / "src" / "auth.py"
    later = time.time() + 5
    os.utime(target, (later, later))
    (initialised / "broken.py").unlink()
    assert store.staleness() == {"modified": ["src/auth.py"], "deleted": ["broken.py"]}


def test_legacy_positional_form_still_analyses(project, capsys, tmp_path):
    out_dir = tmp_path / "legacy_out"
    code, _, _ = run(capsys, str(project), "-o", str(out_dir), "-q")
    assert code == 0
    assert (out_dir / "codebase_graph.json").is_file()


def test_legacy_room(project, capsys):
    code, out, _ = run(capsys, "analyze", str(project), "--no-write", "-q", "--room", "src.auth.login_user")
    assert code == 0 and "# src.auth.login_user" in out


def test_help_for_every_command(capsys):
    with pytest.raises(SystemExit):
        cli.main(["-h"])
    top = capsys.readouterr().out
    for command in sorted(cli._COMMANDS):
        assert command in top, command
        with pytest.raises(SystemExit) as exited:
            cli.main([command, "-h"])
        assert exited.value.code == 0
        text = capsys.readouterr().out
        assert f"usage: adventure-call {command}" in text


def test_guide_matches_generated_agents_md(initialised, capsys):
    _, out, _ = run(capsys, "guide")
    assert out == (initialised / STORE_DIRNAME / "AGENTS.md").read_text(encoding="utf-8")
    assert "Do NOT run `analyze`" in out
