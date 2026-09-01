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


def test_locals_are_not_symbols_but_instance_attributes_are(analyse):
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
    symbols = {s.symbol_id: s for f in files for s in f.symbols}
    assert {"m.TOP", "m.C.shared", "m.C.instance"} <= set(symbols)
    assert not {"m.C.__init__.local", "m.C.__init__.instance"} & set(symbols)

    instance = symbols["m.C.instance"]
    assert instance.kind == "attribute"
    assert instance.name == "instance"
    assert instance.parent == "m.C", "the class owns it, not the method that assigns it"
    assert instance.signature == "self.instance = 3"


def test_instance_attributes_carry_annotations_and_nest_with_their_class(analyse):
    _, files, _ = analyse(
        {
            "m.py": """
            class Outer:
                class Inner:
                    def setup(self):
                        self.depth: int = 1

                    @classmethod
                    def build(cls):
                        cls.registry = {}
            """
        }
    )
    symbols = {s.symbol_id: s for f in files for s in f.symbols}
    assert symbols["m.Outer.Inner.depth"].signature == "self.depth: int = 1"
    assert symbols["m.Outer.Inner.registry"].signature == "cls.registry = {}"
    assert symbols["m.Outer.Inner.registry"].parent == "m.Outer.Inner"


def test_first_assignment_wins_for_a_repeated_attribute(analyse):
    _, files, _ = analyse(
        {
            "m.py": """
            class C:
                role = "guest"

                def __init__(self):
                    self.role = "admin"
                    self.count = 0

                def reset(self):
                    self.count = -1
            """
        }
    )
    symbols = [s for f in files for s in f.symbols if s.name in ("role", "count")]
    assert [s.signature for s in symbols] == ['role = "guest"', "self.count = 0"]


def test_only_self_receivers_in_methods_become_attributes(analyse):
    _, files, _ = analyse(
        {
            "m.py": """
            def helper(self):
                self.cache = 1

            class C:
                def run(self, other):
                    other.field = 1
                    self.state.nested = 1
                    self.kept = 1
            """
        }
    )
    ids = {s.symbol_id for f in files for s in f.symbols}
    assert "m.C.kept" in ids
    assert not {"m.cache", "m.helper.cache", "m.C.field", "m.C.nested"} & ids


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


# -- return annotations (tic-2255) -----------------------------------------


RETURNS_SOURCE = """
    from __future__ import annotations


    def annotated(x: int) -> list[str]:
        ...


    def bare(x):
        ...


    def returns_none() -> None:
        ...


    async def coroutine() -> "Session":
        ...


    def wrapped() -> tuple[
        int,
        str,
    ]:
        ...


    class Holder:
        def method(self) -> Holder:
            ...

        @property
        def prop(self) -> int:
            ...
"""


@pytest.fixture
def returns(analyse):
    _, _, idx = analyse({"src/rets.py": RETURNS_SOURCE})
    return lambda symbol_id: idx.symbols[symbol_id].returns


def test_return_annotation_is_captured_as_written(returns):
    assert returns("src.rets.annotated") == "list[str]"


def test_missing_return_annotation_is_none_not_empty(returns):
    # None means "the source said nothing", which a consumer has to be able to
    # tell apart from an annotation that happens to read `None`.
    assert returns("src.rets.bare") is None


def test_the_type_none_is_kept_as_its_text(returns):
    assert returns("src.rets.returns_none") == "None"


def test_async_function_return_annotation(returns):
    assert returns("src.rets.coroutine") == '"Session"'


def test_string_forward_reference_keeps_its_quotes(returns):
    # Not resolved, not unquoted: what the source says is the honest answer.
    assert returns("src.rets.coroutine").startswith('"')


def test_wrapped_annotation_is_flattened_to_one_line(returns):
    flattened = returns("src.rets.wrapped")
    assert "\n" not in flattened
    assert flattened.startswith("tuple[") and flattened.endswith("]")


def test_method_return_annotation(returns):
    assert returns("src.rets.Holder.method") == "Holder"


def test_decorated_method_return_annotation(returns):
    assert returns("src.rets.Holder.prop") == "int"


def test_classes_have_no_return_annotation(returns):
    assert returns("src.rets.Holder") is None


def test_returns_is_exported_in_the_symbol_dict(analyse):
    _, _, idx = analyse({"src/rets.py": RETURNS_SOURCE})
    assert idx.symbols["src.rets.annotated"].to_dict()["returns"] == "list[str]"


def test_adding_returns_did_not_reshape_any_signature(symbol):
    # This ticket adds a field; it does not touch the signature text that
    # every existing consumer already reads.
    assert symbol("src.auth.login_user").signature == (
        "def login_user(name: str, password: str) -> User:"
    )
    assert symbol("src.models.User.greet").signature.startswith("def greet(")


# -- control-flow breadcrumbs (tic-b47a) -----------------------------------


CONTROL_SOURCE = '''
    from typing import TYPE_CHECKING

    if TYPE_CHECKING:
        type_only()


    def f(items, flag, p):
        plain()
        if check():
            in_if()
        elif other():
            in_elif()
        else:
            in_else()
        for x in source():
            in_for()
        while cond():
            in_while()
        try:
            in_try()
        except ValueError:
            in_except()
        else:
            in_try_else()
        finally:
            in_finally()
        with open(p) as fh:
            in_with()
        match subject():
            case 1:
                in_case()
        a = flag and short()
        b = left() or right()
        c = yes() if test() else no()
        d = [each(i) for i in items if keep(i)]
        e = [plainly(i) for i in items]
        g = lambda: deferred()
        assert asserted()


    def nested_host():
        def inner():
            if flag:
                deep()
        return inner


    def layered(flag):
        if flag:
            for x in flag:
                try:
                    pass
                except ValueError:
                    buried()
'''


@pytest.fixture
def control(analyse):
    _, files, _ = analyse({"src/ctrl.py": CONTROL_SOURCE})
    calls = {c.raw_name: c for f in files for c in f.calls}
    return lambda name: calls[name]


def test_a_call_in_the_definition_body_has_an_empty_breadcrumb(control):
    assert control("plain").control == []
    assert control("plain").unguarded is True


def test_an_if_guards_its_body_but_not_its_test(control):
    # `if check():` runs `check` whenever the `if` is reached; only the body
    # is conditional.  Getting this backwards would mark a large share of
    # ordinary calls as guarded and devalue the whole signal.
    assert control("check").control == []
    assert control("in_if").control == ["if"]
    assert control("in_if").guard_depth == 1


def test_elif_and_else_branches(control):
    # An elif's TEST is guarded too: reaching it means the earlier test failed.
    assert control("other").control == ["if:elif"]
    assert control("in_elif").control == ["if:elif"]
    assert control("in_else").control == ["if:else"]


def test_a_for_loop_guards_its_body_but_not_its_iterable(control):
    # The iterable is evaluated once, before anything iterates.
    assert control("source").control == []
    assert control("in_for").control == ["for"]
    assert control("in_for").in_loop is True
    # A loop body IS a guard: the iterable may be empty.
    assert control("in_for").guard_depth == 1


def test_a_while_test_is_a_loop_position_but_not_a_guard(control):
    assert control("cond").control == ["while:test"]
    assert control("cond").in_loop is True
    assert control("cond").guard_depth == 0
    assert control("in_while").control == ["while"]


def test_try_body_is_not_a_guard_but_except_is(control):
    # Reaching a try body runs it; an except clause is the error path.
    assert control("in_try").control == ["try"]
    assert control("in_try").guard_depth == 0
    assert control("in_except").control == ["try:except"]
    assert control("in_except").in_except is True
    assert control("in_except").guard_depth == 1


def test_try_else_is_guarded_and_finally_is_not(control):
    assert control("in_try_else").control == ["try:else"]
    assert control("in_try_else").guard_depth == 1
    assert control("in_finally").control == ["try:finally"]
    assert control("in_finally").guard_depth == 0
    assert control("in_finally").in_finally is True


def test_a_with_body_runs_when_reached(control):
    assert control("open").control == []
    assert control("in_with").control == ["with"]
    assert control("in_with").guard_depth == 0


def test_match_guards_a_case_body_but_not_the_subject(control):
    assert control("subject").control == []
    assert control("in_case").control == ["match:case"]


def test_short_circuit_operands(control):
    # `flag and short()` may never evaluate `short`; the left operand of an
    # `or` always evaluates.
    assert control("short").control == ["bool"]
    assert control("short").short_circuit is True
    assert control("left").control == []
    assert control("right").control == ["bool"]


def test_ternary_branches_are_guarded_but_its_test_is_not(control):
    assert control("yes").control == ["ternary"]
    assert control("no").control == ["ternary"]
    assert control("test").control == []


def test_comprehension_body_filter_and_element(control):
    # A filtered comprehension's element is guarded by the filter as well as
    # by there being any items at all; the filter test itself is not.
    assert control("each").control == ["comprehension:if"]
    assert control("keep").control == ["comprehension:test"]
    assert control("keep").guard_depth == 0
    assert control("keep").in_loop is True
    # ...and an unfiltered comprehension says so.
    assert control("plainly").control == ["comprehension"]


def test_a_lambda_body_is_deferred(control):
    assert control("deferred").control == ["lambda"]


def test_an_assert_is_recorded_without_counting_as_a_guard(control):
    # Skipped under -O, so it is worth recording -- but marking every test
    # assertion as guarded would drown the signal it is meant to carry.
    assert control("asserted").control == ["assert"]
    assert control("asserted").guard_depth == 0


def test_type_checking_blocks_are_separable(control):
    call = control("type_only")
    assert call.control == ["type-checking"]
    assert call.in_type_checking is True


def test_a_nested_def_breadcrumb_is_relative_to_its_own_body(control):
    # Not ["if"] from the outer function plus its own: the walk stops at the
    # definition that owns the call.
    assert control("deep").control == ["if"]


def test_nesting_reads_outermost_first(control):
    call = control("buried")
    assert call.control == ["if", "for", "try:except"]
    assert call.guard_depth == 3
    assert call.in_loop is True
    assert call.in_except is True
    assert call.unguarded is False


def test_breadcrumb_reaches_the_graph_edge_one_entry_per_call_site(analyse):
    # The breadcrumb is useless if it stops at the parser: resolved calls
    # become edges, and only `controls` carries it there.
    builder, _, _ = analyse(
        {
            "src/m.py": """
                def target():
                    pass

                def caller(flag):
                    target()
                    if flag:
                        target()
                """
        }
    )
    data = builder.graph.edges["src.m.caller", "src.m.target"]
    assert data["count"] == 2
    # Parallel to `count`, so the mixed case is visible: one site unguarded,
    # one guarded.
    assert data["controls"] == [[], ["if"]]


def test_unresolved_calls_carry_the_breadcrumb_too(analyse):
    _, _, index = analyse(
        {
            "src/m.py": """
                def caller(flag):
                    if flag:
                        mystery.thing()
                """
        }
    )
    unresolved = [r for r in index.unresolved if r.raw_name == "mystery.thing"]
    assert unresolved and unresolved[0].control == ["if"]


# -- local bindings (tic-97ce) ---------------------------------------------
#
# What the parser records is deliberately not a type: it is "this name was
# bound to this expression, in this function body".  What it MEANS is the
# resolver's business, because only the resolver knows the imports.


def _locals(parse_source, source: str):
    parsed = parse_source(source)
    return {(b.scope_id, b.name): b for b in parsed.locals}


def test_a_local_binding_records_its_scope_form_and_expression(parse_source):
    bound = _locals(
        parse_source,
        "def go():\n"
        "    engine = Engine()\n"
        "    other: Thing = raw\n"
        "    with Session() as s:\n"
        "        pass\n",
    )
    assert (bound[("m.go", "engine")].source, bound[("m.go", "engine")].root) == (
        "assign",
        "Engine",
    )
    assert (bound[("m.go", "other")].source, bound[("m.go", "other")].root) == (
        "annotation",
        "Thing",
    )
    assert (bound[("m.go", "s")].source, bound[("m.go", "s")].root) == ("with", "Session")


def test_module_and_class_level_names_are_not_locals(parse_source):
    """They are already symbols; recording them again would give one name two
    sources of truth."""
    bound = _locals(
        parse_source,
        "TOP = Engine()\n"
        "\n"
        "class Holder:\n"
        "    attr = Engine()\n"
        "    def method(self):\n"
        "        self.stored = Engine()\n"
        "        inner = Engine()\n",
    )
    assert set(bound) == {("m.Holder.method", "inner")}


def test_a_literal_binds_its_builtin_type_rather_than_a_name(parse_source):
    bound = _locals(
        parse_source,
        "def go():\n"
        "    lines = []\n"
        "    seen = {}\n"
        "    label = 'x'\n",
    )
    assert bound[("m.go", "lines")].literal == "list"
    assert bound[("m.go", "seen")].literal == "dict"
    assert bound[("m.go", "label")].literal == "str"


def test_an_annotation_beats_the_assigned_value(parse_source):
    """`x: Session = _make()` says what the author means; the factory may be
    vaguer than the annotation."""
    bound = _locals(parse_source, "def go():\n    x: Session = make_something()\n")
    assert (bound[("m.go", "x")].source, bound[("m.go", "x")].root) == (
        "annotation",
        "Session",
    )


def test_a_subscripted_annotation_names_no_type(parse_source):
    """A container of T is not a T, and stripping the wrapper here would make
    every classification downstream a lie."""
    bound = _locals(parse_source, "def go():\n    xs: list[Session] = []\n")
    assert bound[("m.go", "xs")].root == ""


def test_a_quoted_annotation_is_unwrapped(parse_source):
    bound = _locals(parse_source, 'def go():\n    x: "pkg.Session" = raw\n')
    binding = bound[("m.go", "x")]
    assert (binding.root, binding.attr_path) == ("pkg", ["Session"])


def test_an_awaited_call_binds_what_the_call_binds(parse_source):
    bound = _locals(parse_source, "async def go():\n    x = await build()\n")
    assert bound[("m.go", "x")].root == "build"


def test_a_dotted_factory_keeps_its_whole_path(parse_source):
    bound = _locals(parse_source, "def go():\n    x = pkg.sub.Factory()\n")
    binding = bound[("m.go", "x")]
    assert (binding.root, binding.attr_path) == ("pkg", ["sub", "Factory"])


def test_an_unreadable_expression_still_records_a_binding(parse_source):
    """It has to: an unusable binding is what lets the resolver refuse to
    trust a second, usable one for the same name."""
    bound = _locals(parse_source, "def go(a, b):\n    x = a + b\n")
    binding = bound[("m.go", "x")]
    assert (binding.root, binding.literal) == ("", None)


def test_a_nested_function_gets_its_own_scope(parse_source):
    bound = _locals(
        parse_source,
        "def outer():\n"
        "    a = Engine()\n"
        "    def inner():\n"
        "        b = Engine()\n",
    )
    assert set(bound) == {("m.outer", "a"), ("m.outer.inner", "b")}


def test_a_tuple_with_target_is_not_bound(parse_source):
    """A destructured element's type is not the expression's type."""
    bound = _locals(parse_source, "def go():\n    with pair() as (a, b):\n        pass\n")
    assert bound == {}
