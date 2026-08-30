"""Binding imports to targets and call sites to fully qualified symbol ids."""

from __future__ import annotations

from adventure_call.models import ImportRecord
from adventure_call.resolver import SymbolResolver


def _edge(index, caller: str, raw_name: str):
    return next(
        r for r in index.resolutions if r.caller_id == caller and r.raw_name == raw_name
    )


# -- import bindings -------------------------------------------------------


def test_aliased_import_binds_to_the_target_symbol(index):
    binding = index.bindings["src.api"]["login"]
    assert (binding.kind, binding.target) == ("symbol", "src.auth.login_user")


def test_module_import_binds_to_a_module(index):
    binding = index.bindings["src.api"]["models"]
    assert (binding.kind, binding.target) == ("module", "src.models")


def test_third_party_imports_are_marked_external(index):
    assert index.bindings["src.api"]["json"].kind == "external"


def test_relative_import_resolves_against_the_package(index):
    binding = index.bindings["src.auth"]["User"]
    assert (binding.kind, binding.target) == ("symbol", "src.models.User")


def test_relative_import_from_a_package_init(analyse):
    _, _, idx = analyse(
        {
            "pkg/__init__.py": "from .core import run\n",
            "pkg/core.py": "def run(): ...\n",
        }
    )
    assert idx.bindings["pkg"]["run"].target == "pkg.core.run"


def test_double_dot_relative_import_climbs_two_levels(analyse):
    _, _, idx = analyse(
        {
            "pkg/__init__.py": "",
            "pkg/util.py": "def helper(): ...\n",
            "pkg/deep/__init__.py": "",
            "pkg/deep/leaf.py": "from ..util import helper\n\n\ndef go():\n    return helper()\n",
        }
    )
    assert idx.bindings["pkg.deep.leaf"]["helper"].target == "pkg.util.helper"
    assert _edge(idx, "pkg.deep.leaf.go", "helper").callee_id == "pkg.util.helper"


def test_absolute_module_of_a_plain_import_is_unchanged():
    resolver = SymbolResolver([])
    record = ImportRecord(module="a.b", alias="c", target_module="x.y")
    assert resolver._absolute_module(record) == "x.y"


# -- call resolution -------------------------------------------------------


def test_import_alias_resolves_to_the_real_symbol(index):
    resolution = _edge(index, "src.api.handle_login", "login")
    assert resolution.callee_id == "src.auth.login_user"
    assert resolution.confidence == "exact"


def test_dotted_call_walks_module_then_symbol(index):
    resolution = _edge(index, "src.api.handle_login", "models.Admin")
    assert resolution.callee_id == "src.models.Admin"
    assert resolution.call_type == "constructor"


def test_self_call_resolves_within_the_class(index):
    assert _edge(index, "src.api.Router.dispatch", "self.fallback").callee_id == (
        "src.api.Router.fallback"
    )


def test_self_call_falls_back_to_the_base_class(index):
    resolution = _edge(index, "src.models.Admin.greet", "self._format")
    assert resolution.callee_id == "src.models.User._format"
    assert resolution.call_type == "method"


def test_calling_a_class_is_a_constructor(index):
    assert _edge(index, "src.models.make_user", "User").call_type == "constructor"


def test_wildcard_import_resolves_bare_names(analyse):
    _, _, idx = analyse(
        {
            "a.py": "def helper(): ...\n",
            "b.py": "from a import *\n\n\ndef go():\n    return helper()\n",
        }
    )
    assert _edge(idx, "b.go", "helper").callee_id == "a.helper"


def test_nested_function_calls_resolve_locally(analyse):
    _, _, idx = analyse(
        {
            "m.py": """
            def outer():
                def inner():
                    return 1

                return inner()
            """
        }
    )
    assert _edge(idx, "m.outer", "inner").callee_id == "m.outer.inner"


def test_calls_resolve_through_explicit_package_reexports(analyse):
    _, _, idx = analyse(
        {
            "pkg/__init__.py": "from pkg.core import work\n",
            "pkg/core.py": "def work(): ...\n",
            "app.py": "import pkg\n\n\ndef go():\n    return pkg.work()\n",
        }
    )
    assert _edge(idx, "app.go", "pkg.work").callee_id == "pkg.core.work"


def test_calls_resolve_through_chained_wildcard_reexports(analyse):
    # `import networkx as nx; nx.shortest_path()` in miniature: the name is
    # published two wildcard hops away from the module the caller can see.
    _, _, idx = analyse(
        {
            "pkg/__init__.py": "from pkg.algos import *\n",
            "pkg/algos/__init__.py": "from pkg.algos.paths import *\n",
            "pkg/algos/paths.py": "def shortest_path(): ...\n",
            "app.py": "import pkg as p\n\n\ndef go():\n    return p.shortest_path()\n",
        }
    )
    resolution = _edge(idx, "app.go", "p.shortest_path")
    assert resolution.callee_id == "pkg.algos.paths.shortest_path"
    assert resolution.confidence == "exact"


def test_circular_reexports_do_not_hang(analyse):
    _, _, idx = analyse(
        {
            "a.py": "from b import *\n",
            "b.py": "from a import *\n",
            "app.py": "import a\n\n\ndef go():\n    return a.nothing()\n",
        }
    )
    assert _edge(idx, "app.go", "a.nothing").callee_id is None


def test_unique_name_fallback_is_flagged_heuristic(analyse):
    _, _, idx = analyse(
        {
            "a.py": "def only_one_of_these(): ...\n",
            "b.py": "def go(thing):\n    return thing.only_one_of_these()\n",
        }
    )
    resolution = _edge(idx, "b.go", "thing.only_one_of_these")
    assert resolution.callee_id == "a.only_one_of_these"
    assert resolution.confidence == "heuristic"


def test_module_level_calls_are_attributed_to_the_module(analyse):
    _, _, idx = analyse({"m.py": "def go(): ...\n\ngo()\n"})
    assert _edge(idx, "m", "go").callee_id == "m.go"


def test_variables_are_indexed_but_never_call_targets(index):
    # The constant is a symbol...
    assert index.symbols["src.auth.SESSIONS"].kind == "variable"
    # ...and no call anywhere resolved to it, or to any other non-callable.
    kinds = {index.symbols[r.callee_id].kind for r in index.resolved}
    assert kinds <= {"function", "method", "class"}


def test_calling_an_imported_constant_is_unresolved(analyse):
    _, _, idx = analyse(
        {
            "cfg.py": "LIMIT = 10\n",
            "app.py": "from cfg import LIMIT\n\n\ndef go():\n    return LIMIT()\n",
        }
    )
    resolution = _edge(idx, "app.go", "LIMIT")
    assert resolution.callee_id is None
    assert resolution.reason == "variable 'cfg.LIMIT' is not callable"


def test_unique_name_fallback_ignores_variables(analyse):
    # `handler` is the only thing in the project with that name, but it is a
    # constant, so the heuristic must not hand it to the caller as a callee.
    _, _, idx = analyse(
        {
            "a.py": "handler = None\n",
            "b.py": "def go(thing):\n    return thing.handler()\n",
        }
    )
    resolution = _edge(idx, "b.go", "thing.handler")
    assert resolution.callee_id is None
    assert resolution.reason == "unknown receiver 'thing'"


def test_a_variable_never_shadows_a_function_of_the_same_name(analyse):
    _, _, idx = analyse(
        {
            "a.py": "def run(): ...\n",
            "b.py": "run = 1\n",
            "c.py": "def go(thing):\n    return thing.run()\n",
        }
    )
    resolution = _edge(idx, "c.go", "thing.run")
    assert resolution.callee_id == "a.run", "the constant must not make 'run' ambiguous"


# -- unresolved reasons ----------------------------------------------------


def test_builtins_are_recognised_and_not_reported_as_unresolved(analyse):
    _, _, idx = analyse({"m.py": "def go(items):\n    return len(items)\n"})
    assert idx.builtin_calls == 1
    assert idx.unresolved == []


def test_external_calls_name_the_package(index):
    resolution = _edge(index, "src.api.handle_login", "json.loads")
    assert resolution.callee_id is None
    assert resolution.reason == "external: json"


def test_ambiguous_names_stay_unresolved(index):
    resolution = _edge(index, "src.api.handle_login", "admin.greet")
    assert resolution.callee_id is None
    assert "ambiguous" in resolution.reason


def test_computed_callees_stay_unresolved(index):
    resolution = _edge(index, "src.models.Admin.greet", "self._format(greeting).upper")
    assert (resolution.callee_id, resolution.reason) == (None, "computed callee")


def test_unresolved_calls_are_queryable_per_symbol(index):
    reasons = [r.reason for r in index.unresolved_for("src.auth.logout_user")]
    assert reasons == ["unknown receiver 'SESSIONS'"]


def test_inheritance_loops_do_not_hang(analyse):
    _, _, idx = analyse(
        {
            "m.py": """
            class A(B):
                def go(self):
                    return self.missing()


            class B(A):
                pass
            """
        }
    )
    assert _edge(idx, "m.A.go", "self.missing").callee_id is None
