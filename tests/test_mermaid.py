"""--format mermaid on tree, imports and calls (tic-3998)."""

from __future__ import annotations

import json
import re
import shutil

import pytest

from adventure_call import cli, mermaid


@pytest.fixture
def initialised(tmp_path, sample_root, monkeypatch, capsys):
    root = tmp_path / "proj"
    shutil.copytree(sample_root, root)
    monkeypatch.chdir(root)
    assert cli.main(["init", str(root), "-q"]) == 0
    capsys.readouterr()
    return root


def run(capsys, *argv: str) -> tuple[int, str, str]:
    code = cli.main(list(argv))
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def declared(text: str) -> list[str]:
    return re.findall(r"^\s*(n\d+)[\[(]", text, re.M)


def assert_well_formed(text: str) -> None:
    """Every node declared once, and every edge between declared nodes."""
    ids = declared(text)
    assert len(ids) == len(set(ids))
    for source, target in re.findall(r"^\s*(n\d+) -(?:--|->)(?:\|\"[^\"]*\"\|)? (n\d+)$", text, re.M):
        assert source in ids and target in ids


def test_escape_turns_syntax_characters_into_entities():
    assert mermaid.escape('<module> "x" #1') == "#60;module#62; #34;x#34; #35;1"


def test_tree_joins_directories_to_their_contents():
    payload = {"root": ".", "metric": "symbols",
               "tree": {"_total": 18, "src/": {"_total": 16, "deep/": 3, "api.py": 1}, "broken.py": 2}}
    text = mermaid.tree(payload).render()
    assert text.startswith("%% adventure-call: tree . (symbols)\nflowchart LR\n")
    assert '  n0("/<br/>18 symbols")' in text
    assert '  n2("deep<br/>3 symbols")' in text
    assert '  n3["api.py<br/>1 symbol"]' in text
    assert "  n0 --- n1\n  n1 --- n2\n  n1 --- n3\n  n0 --- n4" in text
    assert_well_formed(text)


def test_imports_marks_the_centre_and_colours_cycle_edges():
    payload = {"centre": "src/a.py", "depth": 1, "imports": {"src/b.py": 1},
               "edges": ["src/a.py -> src/b.py [f,g]", "src/b.py -> src/a.py"],
               "cycles": [["src/a.py", "src/b.py"]], "truncated": 3}
    text = mermaid.imports(payload).render()
    assert "%% 3 more edges not drawn (raise --limit)" in text
    assert '  n0 -->|"f,g"| n1' in text
    assert "classDef s0 stroke:#89b4fa" in text and "class n0 s0" in text
    assert "linkStyle 0,1 stroke:#f38ba8" in text
    assert_well_formed(text)


def test_imports_cycles_only_draws_one_box_per_cycle():
    text = mermaid.imports({"cycles": [["a.py", "b.py"]]}).render()
    assert 'subgraph c1["cycle 1"]\n  n0["a.py"]\n  n1["b.py"]\n  end' in text


def test_cli_calls_mermaid(initialised, capsys):
    code, out, err = run(capsys, "calls", "src.api.handle_login", "--direction", "both",
                         "--externals", "--format", "mermaid")
    assert code == 0 and err == ""
    assert out.startswith("%% adventure-call: calls src.api.handle_login (both, depth 2)\n")
    assert '["handle_login<br/>src/api.py:10"]' in out
    assert '["Router.dispatch<br/>src/api.py:25 · -1"]' in out
    assert '[["json"]]' in out
    assert_well_formed(out)
    _, as_json, _ = run(capsys, "calls", "src.api.handle_login", "--direction", "both")
    assert len(declared(out)) == len(json.loads(as_json)["nodes"]) + 1  # + the external


def test_cli_imports_and_tree_mermaid(initialised, capsys):
    code, out, _ = run(capsys, "imports", "src/api.py", "--symbols", "--format", "mermaid")
    assert code == 0 and '-->|"login_user,logout_user"|' in out
    assert_well_formed(out)
    code, out, _ = run(capsys, "tree", "--format", "mermaid")
    assert code == 0 and out.startswith("%% adventure-call: tree . (symbols)")
    assert_well_formed(out)


def test_cli_mermaid_errors_stay_json(initialised, capsys):
    code, out, _ = run(capsys, "calls", "zzz_nothing", "--format", "mermaid")
    assert code == 2 and "error" in json.loads(out)


def test_cli_warns_past_mermaids_limits(initialised, capsys, monkeypatch):
    monkeypatch.setattr(mermaid, "MAX_EDGES", 1)
    code, out, err = run(capsys, "imports", "--format", "mermaid")
    assert code == 0 and out.startswith("%%")
    assert "over Mermaid's default limits" in err
