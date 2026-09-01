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


def test_instance_attributes_are_indexed_but_never_call_targets(analyse):
    _, _, idx = analyse(
        {
            "m.py": """
            class C:
                def __init__(self):
                    self.handler = None

                def run(self):
                    return self.handler()
            """
        }
    )
    assert idx.symbols["m.C.handler"].kind == "attribute"
    resolution = _edge(idx, "m.C.run", "self.handler")
    assert resolution.callee_id is None
    assert resolution.reason == "no member 'handler' on m.C"


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


# -- src-layout import roots (tic-9ff4) -------------------------------------


def test_src_layout_absolute_import_resolves(analyse):
    """Conventional src/ layout: `from kernel.types import X` finds src.kernel.types."""
    _, _, idx = analyse(
        {
            "src/kernel/__init__.py": "",
            "src/kernel/types.py": """
            class ToolResult:
                def ok(self) -> bool:
                    return True
            """,
            "src/agent/__init__.py": "",
            "src/agent/session.py": """
            from kernel.types import ToolResult


            def use() -> bool:
                return ToolResult().ok()
            """,
        }
    )
    # Path-derived ids stay prefixed and stable.
    assert "src.kernel.types.ToolResult" in idx.symbols
    binding = idx.bindings["src.agent.session"]["ToolResult"]
    assert (binding.kind, binding.target) == ("symbol", "src.kernel.types.ToolResult")
    edge = _edge(idx, "src.agent.session.use", "ToolResult")
    assert (edge.callee_id, edge.reason) == ("src.kernel.types.ToolResult", None)


def test_src_layout_module_import_resolves(analyse):
    """`import carnot.kernel` style bindings canonicalise to the path id."""
    _, _, idx = analyse(
        {
            "src/carnot/__init__.py": "",
            "src/carnot/kernel/__init__.py": "",
            "src/carnot/kernel/types.py": """
            def make() -> int:
                return 1
            """,
            "src/carnot/agent.py": """
            from carnot.kernel import types


            def go() -> int:
                return types.make()
            """,
        }
    )
    binding = idx.bindings["src.carnot.agent"]["types"]
    assert (binding.kind, binding.target) == ("module", "src.carnot.kernel.types")
    edge = _edge(idx, "src.carnot.agent.go", "types.make")
    assert edge.callee_id == "src.carnot.kernel.types.make"


def test_src_layout_root_inferred_from_setuptools_config(analyse):
    """`[tool.setuptools.packages.find] where` names the import root."""
    _, _, idx = analyse(
        {
            "pyproject.toml": '[tool.setuptools.packages.find]\nwhere = ["lib"]\n',
            "lib/mykit/__init__.py": "",
            "lib/mykit/core.py": """
            def ping() -> str:
                return "pong"
            """,
            "app.py": """
            from mykit.core import ping


            def main() -> str:
                return ping()
            """,
        }
    )
    assert idx.bindings["app"]["ping"].target == "lib.mykit.core.ping"
    assert _edge(idx, "app.main", "ping").callee_id == "lib.mykit.core.ping"


def test_src_layout_root_inferred_from_hatch_config(analyse):
    """`[tool.hatch.build.targets.wheel] packages = ["src/x"]` implies src root."""
    _, _, idx = analyse(
        {
            "pyproject.toml": "[tool.hatch.build.targets.wheel]\npackages = ['src/mykit']\n",
            "src/mykit/__init__.py": "",
            "src/mykit/core.py": """
            def ping() -> str:
                return "pong"
            """,
            "app.py": """
            from mykit.core import ping


            def main() -> str:
                return ping()
            """,
        }
    )
    assert _edge(idx, "app.main", "ping").callee_id == "src.mykit.core.ping"


def test_flat_layout_still_resolves_without_config(analyse):
    """A flat package layout must not be mistaken for src-layout."""
    _, _, idx = analyse(
        {
            "alpha/__init__.py": "",
            "alpha/core.py": """
            def run() -> int:
                return 1
            """,
            "alpha/tool.py": """
            from alpha.core import run


            def go() -> int:
                return run()
            """,
        }
    )
    assert idx.bindings["alpha.tool"]["run"].target == "alpha.core.run"
    edge = _edge(idx, "alpha.tool.go", "run")
    assert (edge.callee_id, edge.confidence) == ("alpha.core.run", "exact")


def test_multiple_package_dirs_without_config_stay_unaliased(analyse):
    """Two candidate roots and no config: inference stays off, nothing breaks."""
    _, _, idx = analyse(
        {
            "lib1/kit/__init__.py": "",
            "lib1/kit/core.py": """
            def a() -> int:
                return 1
            """,
            "lib2/kit/__init__.py": "",
            "lib2/kit/core.py": """
            def b() -> int:
                return 2
            """,
        }
    )
    assert idx.bindings == {}
    assert "lib1.kit.core.a" in idx.symbols
    assert "lib2.kit.core.b" in idx.symbols
