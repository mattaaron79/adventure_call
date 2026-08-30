"""Extraction: definitions, signatures, docstrings, imports, calls, damage."""

from __future__ import annotations

from pathlib import Path

import pytest

from adventure_call.languages import module_name_for_path
from adventure_call.parser import CodebaseParser


# -- definitions -----------------------------------------------------------


def test_symbol_ids_are_fully_qualified(index):
    ids = set(index.symbols)
    assert {
        "src.auth.login_user",
        "src.auth.logout_user",
        "src.models.User",
        "src.models.User.greet",
        "src.models.Admin.greet",
        "src.api.Router.dispatch",
    } <= ids


def test_function_signature_docstring_and_range(symbol):
    login = symbol("src.auth.login_user")
    assert login.kind == "function"
    assert login.parent is None
    assert login.signature == "def login_user(name: str, password: str) -> User:"
    assert login.docstring.startswith("Authenticate a user and open a session.")
    assert login.start_line < login.end_line
    assert login.end_byte > login.start_byte
    assert [(p.name, p.annotation) for p in login.params] == [
        ("name", "str"),
        ("password", "str"),
    ]


def test_parameter_kinds_cover_positional_only_varargs_and_kwargs(symbol):
    params = {p.name: p for p in symbol("src.models.make_user").params}
    assert params["name"].kind == "posonly"
    assert params["role"].kind == "positional" and params["role"].default == '"guest"'
    assert params["tags"].kind == "vararg" and params["tags"].annotation == "str"
    assert params["extra"].kind == "kwarg" and params["extra"].annotation == "object"


def test_methods_know_their_class(symbol):
    greet = symbol("src.models.User.greet")
    assert greet.kind == "method"
    assert greet.parent == "src.models.User"


def test_classes_record_decorators_and_bases(symbol):
    user = symbol("src.models.User")
    assert user.kind == "class"
    assert user.decorators == ["@dataclass"]
    assert symbol("src.models.Admin").bases == ["User"]


def test_module_docstrings_are_captured(files_by_module):
    assert files_by_module["src.auth"].module_docstring == "Authentication helpers."


# -- assignments -----------------------------------------------------------


def test_module_level_assignments_become_variables(symbol):
    sessions = symbol("src.auth.SESSIONS")
    assert sessions.kind == "variable"
    assert sessions.parent is None
    assert sessions.signature == "SESSIONS: dict[str, User] = {}"
    assert sessions.params == [] and sessions.docstring is None


def test_class_body_assignments_become_attributes(symbol):
    role = symbol("src.models.User.role")
    assert role.kind == "attribute"
    assert role.parent == "src.models.User"
    assert role.signature == 'role: str = "guest"'
    assert symbol("src.models.User.name").signature == "name: str"  # bare annotation


def test_locals_and_instance_attributes_are_not_symbols(analyse):
    _, files, _ = analyse(
        {
            "m.py": """
            TOP = 1

            class C:
                shared = []

                def __init__(self):
                    local = 2
                    self.instance = 3
            """
        }
    )
    ids = {s.symbol_id for f in files for s in f.symbols}
    assert {"m.TOP", "m.C.shared"} <= ids
    assert not {"m.C.__init__.local", "m.C.instance", "m.C.__init__.instance"} & ids


def test_only_plain_name_targets_are_captured(analyse):
    _, files, _ = analyse({"m.py": "a, b = 1, 2\nc = d = 3\nlookup['e'] = 4\n"})
    names = {s.name for f in files for s in f.symbols}
    assert names == {"c", "d"}, "tuple and subscript targets are not names we can index"


def test_long_assignment_values_are_truncated(analyse):
    _, files, _ = analyse({"m.py": "BIG = [\n" + "    'x',\n" * 40 + "]\n"})
    variable = next(s for f in files for s in f.symbols)
    assert variable.signature.endswith("...")
    assert len(variable.signature) < 100
    assert "\n" not in variable.signature


def test_nested_class_attributes_nest_their_ids(analyse):
    _, files, _ = analyse({"m.py": "class Outer:\n    class Inner:\n        depth = 1\n"})
    ids = {s.symbol_id for f in files for s in f.symbols}
    assert "m.Outer.Inner.depth" in ids


# -- stubs and code --------------------------------------------------------


def test_stub_keeps_the_signature_and_drops_the_body(symbol):
    stub = symbol("src.auth.login_user").stub
    assert stub.startswith("def login_user(name: str, password: str) -> User:")
    assert stub.rstrip().endswith("...")
    assert "SESSIONS[name]" not in stub
    assert "Authenticate a user" in stub  # docstrings survive; bodies do not


def test_code_is_dedented_and_self_contained(symbol):
    code = symbol("src.models.User._format").code
    assert code.startswith("def _format(")
    assert "\n    return f" in code  # body re-indented relative to the def


def test_crlf_sources_dedent_and_normalise(tmp_path: Path):
    source = 'class C:\r\n    def m(self):\r\n\r\n        return 1\r\n'
    (tmp_path / "crlf.py").write_bytes(source.encode("utf-8"))
    parsed = CodebaseParser(tmp_path).parse_file(tmp_path / "crlf.py")
    method = next(s for s in parsed.symbols if s.name == "m")
    assert method.code == "def m(self):\n\n    return 1"


def test_decorated_code_includes_the_decorator(symbol):
    assert symbol("src.models.User").code.startswith("@dataclass\nclass User:")


# -- imports ---------------------------------------------------------------


def test_relative_imports_record_their_level(files_by_module):
    records = {rec.alias: rec for rec in files_by_module["src.auth"].imports}
    assert records["User"].is_relative is True
    assert records["User"].level == 1
    assert records["User"].target_module == "models"
    assert records["User"].target_symbol == "User"


def test_aliased_and_plain_imports(files_by_module):
    records = {rec.alias: rec for rec in files_by_module["src.api"].imports}
    assert records["login"].target == "src.auth.login_user"
    assert records["models"].target == "src.models"
    assert records["models"].target_symbol is None
    assert records["json"].target == "json"


def test_wildcard_import_is_flagged(analyse):
    _, files, _ = analyse({"a.py": "def helper(): ...", "b.py": "from a import *"})
    record = next(r for f in files for r in f.imports)
    assert record.is_wildcard and record.alias == "*"


# -- call sites ------------------------------------------------------------


def test_calls_are_attributed_to_the_enclosing_definition(files_by_module):
    calls = {c.raw_name: c for c in files_by_module["src.api"].calls}
    assert calls["login"].caller_id == "src.api.handle_login"
    assert calls["self.fallback"].caller_id == "src.api.Router.dispatch"
    assert calls["self.fallback"].root == "self"
    assert calls["self.fallback"].attr_path == ["fallback"]


def test_module_level_calls_have_no_caller(analyse):
    _, files, _ = analyse({"m.py": "def go(): ...\n\ngo()\n"})
    call = next(c for f in files for c in f.calls)
    assert call.caller_id is None


def test_calls_in_a_module_level_assignment_belong_to_the_module(analyse):
    # The variable is a symbol now, but it owns no body, so it cannot own a call.
    _, files, _ = analyse({"m.py": "def go(): ...\n\nRESULT = go()\n"})
    call = next(c for f in files for c in f.calls)
    assert call.caller_id is None


def test_computed_callees_are_marked_unresolvable(files_by_module):
    call = next(
        c for c in files_by_module["src.models"].calls if c.raw_name.endswith(".upper")
    )
    assert call.root == ""  # base of the chain is a call, not a name


def test_nested_functions_nest_their_ids(analyse):
    _, files, _ = analyse({"m.py": "def outer():\n    def inner(): ...\n    return inner\n"})
    ids = {s.symbol_id for f in files for s in f.symbols}
    assert ids == {"m.outer", "m.outer.inner"}


def test_async_functions_are_flagged(analyse):
    _, files, _ = analyse({"m.py": "async def fetch(url: str) -> str: ...\n"})
    symbol = next(s for f in files for s in f.symbols)
    assert symbol.is_async is True


# -- damaged input ---------------------------------------------------------


def test_syntax_errors_do_not_stop_extraction(files_by_module):
    broken = files_by_module["broken"]
    names = {s.name for s in broken.symbols}
    assert "still_parses" in names, "clean definitions before the damage must survive"
    assert "also_parses" in names
    assert "broken_here" not in names, "a definition with a broken header is not a symbol"
    assert any(d.kind == "syntax_error" for d in broken.diagnostics)
    assert all(d.line > 0 for d in broken.diagnostics if d.kind == "syntax_error")


def test_unparseable_file_still_returns_a_parsed_file(tmp_path: Path):
    (tmp_path / "junk.py").write_text("def (((", encoding="utf-8")
    parsed = CodebaseParser(tmp_path).parse_file(tmp_path / "junk.py")
    assert parsed.symbols == []
    assert parsed.diagnostics and not parsed.ok


def test_binary_and_oversized_files_are_skipped(tmp_path: Path):
    (tmp_path / "blob.py").write_bytes(b"def f():\n    pass\n\x00\x00binary")
    (tmp_path / "huge.py").write_text("x = 1\n" * 500, encoding="utf-8")

    parser = CodebaseParser(tmp_path, max_file_bytes=100)
    kinds = {p.file_path: [d.kind for d in p.diagnostics] for p in parser.parse_tree()}
    assert kinds["blob.py"] == ["skipped"]
    assert kinds["huge.py"] == ["skipped"]


def test_unreadable_path_is_reported_not_raised(tmp_path: Path):
    parsed = CodebaseParser(tmp_path).parse_file(tmp_path / "nope.py")
    assert [d.kind for d in parsed.diagnostics] == ["read_error"]


def test_unsupported_suffix_is_reported(tmp_path: Path):
    (tmp_path / "notes.txt").write_text("hello", encoding="utf-8")
    parsed = CodebaseParser(tmp_path).parse_file(tmp_path / "notes.txt")
    assert [d.kind for d in parsed.diagnostics] == ["unsupported"]


def test_undecodable_bytes_degrade_instead_of_raising(tmp_path: Path):
    # A latin-1 byte inside a string literal is not valid UTF-8, but the file
    # still parses; the byte must degrade to U+FFFD rather than cost us the
    # whole file.
    (tmp_path / "latin.py").write_bytes(b'def greet() -> str:\n    return "caf\xe9"\n')
    parsed = CodebaseParser(tmp_path).parse_file(tmp_path / "latin.py")
    assert [s.name for s in parsed.symbols] == ["greet"]
    assert "�" in parsed.symbols[0].code


def test_undecodable_bytes_in_an_identifier_are_reported(tmp_path: Path):
    # Same byte in an identifier is a genuine syntax error: no symbol, but a
    # diagnostic instead of an exception.
    (tmp_path / "latin.py").write_bytes(b"def caf\xe9_count() -> int:\n    return 1\n")
    parsed = CodebaseParser(tmp_path).parse_file(tmp_path / "latin.py")
    assert parsed.symbols == []
    assert {d.kind for d in parsed.diagnostics} == {"syntax_error"}


# -- traversal -------------------------------------------------------------


def test_walk_skips_noise_directories_and_globs(tmp_path: Path):
    for rel in ("keep.py", "skip_me.py", ".venv/lib.py", "pkg/__pycache__/c.py", "pkg/ok.py"):
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x = 1\n", encoding="utf-8")

    parser = CodebaseParser(tmp_path, exclude_globs=("skip_me.py",))
    found = {parser.relative_path(p) for p in parser.iter_source_files()}
    assert found == {"keep.py", "pkg/ok.py"}


@pytest.mark.parametrize(
    ("path", "prefix", "expected"),
    [
        ("src/auth.py", "", "src.auth"),
        ("src/__init__.py", "", "src"),
        ("src/auth.py", "src", "auth"),
        ("a-b/mod.py", "", "a_b.mod"),
    ],
)
def test_module_names_derive_from_paths(path, prefix, expected):
    assert module_name_for_path(path, prefix) == expected
