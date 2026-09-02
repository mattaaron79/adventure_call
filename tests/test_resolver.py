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


def test_a_bound_receiver_beats_an_ambiguous_method_name(index):
    """`admin = models.Admin(...)` then `admin.greet()` (tic-97ce).

    Both User and Admin define `greet`, so the unique-name fallback used to
    give up here and report the ambiguity.  The binding says which one it is,
    which is better than the coincidence of a name being unique -- and it is
    the rare case where classifying a receiver also RESOLVES the call.
    Heuristic, never exact: a local can be rebound and nothing tracks that.
    """
    resolution = _edge(index, "src.api.handle_login", "admin.greet")
    assert resolution.callee_id == "src.models.Admin.greet"
    assert (resolution.confidence, resolution.reason) == ("heuristic", "local binding")


def test_ambiguous_names_stay_unresolved_without_a_binding(analyse):
    _, _, idx = analyse(
        {
            "a.py": "class One:\n    def go(self): pass\n",
            "b.py": "class Two:\n    def go(self): pass\n",
            "c.py": "def run(thing):\n    return thing.go()\n",
        }
    )
    resolution = _edge(idx, "c.run", "thing.go")
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


# -- local type bindings (tic-97ce) ----------------------------------------
#
# This does not exist to RESOLVE receiver method calls -- measured across two
# real codebases it resolves almost none, because the methods people call on
# their own objects belong to a framework base class.  It exists to say what
# KIND of thing a call goes to, so an `unknown receiver` count stops treating
# calls out of the project as holes in the analysis.


def _reason(idx, caller: str, raw_name: str) -> str:
    return _edge(idx, caller, raw_name).reason


def test_a_constructor_binds_the_local_to_that_class(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def go():\n"
                "    engine = Engine()\n"
                "    engine.start()\n"
            )
        }
    )
    resolution = _edge(idx, "m.go", "engine.start")
    assert resolution.callee_id == "m.Engine.start"
    assert resolution.confidence == "heuristic"


def test_a_factory_binds_through_its_return_annotation(analyse):
    """`x = make()` where make declares `-> Engine` (tic-2255 earning its keep)."""
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def make() -> Engine:\n"
                "    return Engine()\n"
                "\n"
                "def go():\n"
                "    engine = make()\n"
                "    engine.start()\n"
            )
        }
    )
    assert _edge(idx, "m.go", "engine.start").callee_id == "m.Engine.start"


def test_an_unannotated_factory_binds_nothing(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def make():\n"
                "    return Engine()\n"
                "\n"
                "def go():\n"
                "    engine = make()\n"
                "    engine.start()\n"
            )
        }
    )
    # Falls back to the unique-name guess, unchanged from before this feature.
    assert _edge(idx, "m.go", "engine.start").reason == "unique name in project"


def test_a_variable_annotation_binds_and_beats_the_assigned_value(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def go(raw):\n"
                "    engine: Engine = raw\n"
                "    engine.start()\n"
            )
        }
    )
    assert _edge(idx, "m.go", "engine.start").callee_id == "m.Engine.start"


def test_a_quoted_forward_reference_binds(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def go(raw):\n"
                '    engine: "Engine" = raw\n'
                "    engine.start()\n"
            )
        }
    )
    assert _edge(idx, "m.go", "engine.start").callee_id == "m.Engine.start"


def test_a_with_as_target_binds(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def go():\n"
                "    with Engine() as engine:\n"
                "        engine.start()\n"
            )
        }
    )
    assert _edge(idx, "m.go", "engine.start").callee_id == "m.Engine.start"


def test_an_annotated_parameter_binds(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def go(engine: Engine):\n"
                "    engine.start()\n"
            )
        }
    )
    assert _edge(idx, "m.go", "engine.start").callee_id == "m.Engine.start"


def test_a_rebound_name_is_dropped_rather_than_guessed(analyse):
    """The ticket's own rule: two bindings, no answer."""
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "class Other:\n"
                "    def start(self): pass\n"
                "\n"
                "def go(flag):\n"
                "    engine = Engine()\n"
                "    if flag:\n"
                "        engine = Other()\n"
                "    engine.start()\n"
            )
        }
    )
    resolution = _edge(idx, "m.go", "engine.start")
    assert resolution.callee_id is None
    assert "ambiguous" in resolution.reason


def test_a_name_rebound_to_something_unreadable_is_also_dropped(analyse):
    """An unusable binding still has to be able to veto a usable one."""
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def go(flag, raw):\n"
                "    engine = Engine()\n"
                "    if flag:\n"
                "        engine = raw.pick() + 1\n"
                "    engine.start()\n"
            )
        }
    )
    assert _edge(idx, "m.go", "engine.start").reason == "unique name in project"


def test_a_call_on_a_literal_is_named_as_a_stdlib_method(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "class Report:\n"
                "    def append(self, x): pass\n"
                "\n"
                "def go():\n"
                "    lines = []\n"
                "    lines.append('x')\n"
            )
        }
    )
    # Without the binding, `append` is a unique project name and this drew a
    # wrong edge to Report.append.
    resolution = _edge(idx, "m.go", "lines.append")
    assert resolution.callee_id is None
    assert resolution.reason == "stdlib method on list"


def test_a_builtin_annotation_is_named_as_a_stdlib_method(analyse):
    _, _, idx = analyse(
        {"m.py": "def go(name: str):\n    return name.strip()\n"}
    )
    assert _reason(idx, "m.go", "name.strip") == "stdlib method on str"


def test_a_container_annotation_does_not_become_its_element(analyse):
    """`list[Engine]` is a list.  Unwrapping it would make the answer a lie."""
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def go(engines: list[Engine]):\n"
                "    engines.start()\n"
            )
        }
    )
    assert _edge(idx, "m.go", "engines.start").reason != "local binding"


def test_an_external_class_binds_and_names_its_package(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "from rich.console import Console\n"
                "\n"
                "def go():\n"
                "    console = Console()\n"
                "    console.print('x')\n"
            )
        }
    )
    assert _reason(idx, "m.go", "console.print") == "external: rich.console.Console"


def test_an_external_FUNCTION_call_binds_nothing(analyse):
    """django's `get_object_or_404(Location, ...)` returns a Location.

    Treating any external call as producing an external object dropped three
    correct hypermenu edges and five carnot ones.  We hold no definition of an
    external name, so the only signal for "is this a class" is how it is
    spelled -- and when it is not spelled like one, we record nothing rather
    than replace one guess with another.
    """
    _, _, idx = analyse(
        {
            "m.py": (
                "from shortcuts import get_object_or_404\n"
                "\n"
                "class Location:\n"
                "    def set_manual(self): pass\n"
                "\n"
                "def go(pk):\n"
                "    location = get_object_or_404(Location, pk=pk)\n"
                "    location.set_manual()\n"
            )
        }
    )
    assert _edge(idx, "m.go", "location.set_manual").callee_id == "m.Location.set_manual"


def test_a_method_on_a_foreign_base_is_named_as_such(analyse):
    """The category the original ticket did not anticipate, and where nearly
    every classifiable receiver call actually lands."""
    _, _, idx = analyse(
        {
            "m.py": (
                "from textual.app import App\n"
                "\n"
                "class MyApp(App):\n"
                "    def action_go(self): pass\n"
                "\n"
                "def go():\n"
                "    app = MyApp()\n"
                "    app.query_one('#x')\n"
            )
        }
    )
    assert _reason(idx, "m.go", "app.query_one") == "foreign base: textual.app.App"


def test_a_members_own_method_still_resolves_through_the_binding(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "from textual.app import App\n"
                "\n"
                "class MyApp(App):\n"
                "    def action_go(self): pass\n"
                "\n"
                "def go():\n"
                "    app = MyApp()\n"
                "    app.action_go()\n"
            )
        }
    )
    assert _edge(idx, "m.go", "app.action_go").callee_id == "m.MyApp.action_go"


def test_a_missing_member_with_no_foreign_base_is_a_finding(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def go():\n"
                "    engine = Engine()\n"
                "    engine.stop()\n"
            )
        }
    )
    assert _reason(idx, "m.go", "engine.stop") == "no member 'stop' on m.Engine"


def test_an_Any_annotation_binds_nothing(analyse):
    """`Any` is the explicit spelling of "unknown"; binding it to typing.Any
    reported every method call on the name as a call out to typing."""
    _, _, idx = analyse(
        {
            "m.py": (
                "from typing import Any\n"
                "\n"
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def go(engine: Any):\n"
                "    engine.start()\n"
            )
        }
    )
    assert _edge(idx, "m.go", "engine.start").callee_id == "m.Engine.start"


def test_a_longer_attribute_chain_is_not_claimed_by_the_receiver(analyse):
    """`app.session.transcript.index_of()` is a call on the transcript, not on
    the app -- neither its member nor its foreign base gets to answer."""
    _, _, idx = analyse(
        {
            "m.py": (
                "from textual.app import App\n"
                "\n"
                "class MyApp(App):\n"
                "    pass\n"
                "\n"
                "class Inner:\n"
                "    def index_of(self): pass\n"
                "\n"
                "def go():\n"
                "    app = MyApp()\n"
                "    app.session.index_of()\n"
            )
        }
    )
    assert _edge(idx, "m.go", "app.session.index_of").callee_id == "m.Inner.index_of"


def test_a_closure_sees_the_enclosing_functions_locals(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def outer():\n"
                "    engine = Engine()\n"
                "    def inner():\n"
                "        engine.start()\n"
                "    return inner\n"
            )
        }
    )
    assert _edge(idx, "m.outer.inner", "engine.start").callee_id == "m.Engine.start"


def test_one_functions_locals_do_not_leak_into_a_sibling(analyse):
    _, _, idx = analyse(
        {
            "m.py": (
                "class Engine:\n"
                "    def start(self): pass\n"
                "\n"
                "def one():\n"
                "    engine = Engine()\n"
                "\n"
                "def two(engine):\n"
                "    engine.start()\n"
            )
        }
    )
    # `two` knows nothing about `one`'s local, so this is the old fallback.
    assert _edge(idx, "m.two", "engine.start").reason == "unique name in project"


# -- references (tic-89fa) -------------------------------------------------


def _refs(idx):
    return {(r.referrer_id, r.target_id) for r in idx.references}


def test_a_django_urlconf_reaches_its_views(analyse):
    """The case the ticket was filed for: `path(..., views.home)` NAMES the
    view, so a call graph never sees it and the view reads as dead code."""
    _, _, idx = analyse(
        {
            "app/__init__.py": "",
            "app/views.py": "def home(request):\n    return 1\n",
            "app/urls.py": (
                "from . import views\n"
                "urlpatterns = [path('', views.home, name='home')]\n"
            ),
        }
    )
    assert ("app.urls", "app.views.home") in _refs(idx)


def test_a_reference_is_never_recorded_as_a_call(analyse):
    """Different edge types because they say different things: a call is
    flow, a reference is only evidence that something could reach it."""
    _, _, idx = analyse(
        {"m.py": "def worker(): pass\ndef go():\n    Thread(target=worker)\n"}
    )
    assert ("m.go", "m.worker") in _refs(idx)
    assert all(r.callee_id != "m.worker" for r in idx.resolutions)


def test_a_reference_to_a_nested_definition_resolves_to_the_nested_one(analyse):
    """Which is why the parser does not need to treat a nested `def` as a
    shadowing binding -- the resolver already scopes it."""
    _, _, idx = analyse(
        {
            "m.py": (
                "def helper(): pass\n"
                "def go():\n"
                "    def helper(): pass\n"
                "    register(helper)\n"
            )
        }
    )
    assert ("m.go", "m.go.helper") in _refs(idx)


def test_a_name_that_resolves_to_nothing_is_dropped_silently(analyse):
    """Deliberately no `unresolved` counterpart.  The query is loose on
    purpose -- `f(x)` matches for every `x` -- so on ../carnot that is 753
    candidate sites for 91 real references, and recording the rest as
    unresolved would swamp the coverage figures with noise."""
    _, _, idx = analyse({"m.py": "def go(a):\n    use(undefined_thing)\n"})
    assert _refs(idx) == set()


def test_a_reference_to_a_non_callable_is_dropped(analyse):
    """Naming a constant is not what this edge type is about."""
    _, _, idx = analyse({"m.py": "LIMIT = 5\ndef go():\n    use(LIMIT)\n"})
    assert _refs(idx) == set()


def test_a_function_naming_itself_is_recursion_not_a_reference(analyse):
    _, _, idx = analyse({"m.py": "def go():\n    retry(go)\n"})
    assert _refs(idx) == set()


def test_a_reference_to_a_class_counts(analyse):
    """`HTTPServer(("", 0), _Handler)` hands over a class to be constructed
    later; ../carnot does exactly this in four test servers."""
    _, _, idx = analyse(
        {"m.py": "class Handler: pass\ndef serve():\n    HTTPServer(addr, Handler)\n"}
    )
    assert ("m.serve", "m.Handler") in _refs(idx)


def test_the_graph_carries_references_as_their_own_edge_type(analyse):
    builder, _, _ = analyse(
        {
            "app/__init__.py": "",
            "app/views.py": "def home(request):\n    return 1\n",
            "app/urls.py": "from . import views\nurlpatterns = [path('', views.home)]\n",
        }
    )
    data = builder.graph.edges["app.urls", "app.views.home"]
    assert data["types"] == ["REFERENCES"]
    assert "CALLS" not in data["types"]


def test_a_module_level_referrer_survives_the_module_call_edge_flag(analyse):
    """Framework configuration -- a URLconf, an admin registration, a router
    table -- is module-level BY NATURE, and that flag is about calls executed
    at import time.  Dropping references with it would discard the case this
    edge type exists for."""
    builder, _, _ = analyse(
        {
            "app/__init__.py": "",
            "app/views.py": "def home(request):\n    return 1\n",
            "app/urls.py": "from . import views\nurlpatterns = [path('', views.home)]\n",
        },
        module_call_edges=False,
    )
    assert builder.graph.has_edge("app.urls", "app.views.home")


# -- variable and attribute accesses (tic-13d7) -----------------------------


def _links(idx):
    return {(a.kind, a.accessor_id, a.target_id) for a in idx.accesses}


def test_a_function_reading_a_module_constant(analyse):
    _, _, idx = analyse({"m.py": "LIMIT = 5\ndef go():\n    return LIMIT\n"})
    assert ("read", "m.go", "m.LIMIT") in _links(idx)


def test_a_method_writing_and_a_sibling_reading_the_same_attribute(analyse):
    """The coupling a call graph is structurally blind to.

    ``__init__`` and ``show`` never call each other, so nothing in CALLS joins
    them; on ../carnot 591 method pairs are in this position even after
    constructors are excluded.
    """
    _, _, idx = analyse(
        {
            "m.py": (
                "class K:\n"
                "    def __init__(self):\n"
                "        self.cursor = 0\n"
                "    def show(self):\n"
                "        return self.cursor\n"
            )
        }
    )
    links = _links(idx)
    assert ("write", "m.K.__init__", "m.K.cursor") in links
    assert ("read", "m.K.show", "m.K.cursor") in links


def test_an_augmented_assignment_resolves_to_both_edges(analyse):
    _, _, idx = analyse(
        {"m.py": "class K:\n    def bump(self):\n        self.n += 1\n    n = 0\n"}
    )
    links = _links(idx)
    assert ("read", "m.K.bump", "m.K.n") in links
    assert ("write", "m.K.bump", "m.K.n") in links


def test_self_x_finds_an_attribute_declared_on_a_base_class(analyse):
    """Which is why the value lookup walks bases, exactly as the method lookup
    does -- an attribute declared once on a base and read from a subclass
    method that never mentions it is ordinary Python."""
    _, _, idx = analyse(
        {
            "m.py": (
                "class Base:\n"
                "    shared = 0\n"
                "class K(Base):\n"
                "    def show(self):\n"
                "        return self.shared\n"
            )
        }
    )
    assert ("read", "m.K.show", "m.Base.shared") in _links(idx)


def test_an_imported_constant_resolves_to_its_definition(analyse):
    _, _, idx = analyse(
        {
            "pkg/__init__.py": "",
            "pkg/config.py": "LIMIT = 5\n",
            "pkg/use.py": "from .config import LIMIT\ndef go():\n    return LIMIT\n",
        }
    )
    assert ("read", "pkg.use.go", "pkg.config.LIMIT") in _links(idx)


def test_another_modules_constant_through_a_dotted_name(analyse):
    _, _, idx = analyse(
        {
            "pkg/__init__.py": "",
            "pkg/config.py": "LIMIT = 5\n",
            "pkg/use.py": "from . import config\ndef go():\n    return config.LIMIT\n",
        }
    )
    assert ("read", "pkg.use.go", "pkg.config.LIMIT") in _links(idx)


def test_a_local_shadowing_a_module_variable_produces_no_edge(analyse):
    _, _, idx = analyse({"m.py": "count = 5\ndef go():\n    count = 3\n    return count\n"})
    assert _links(idx) == set()


def test_naming_a_callable_is_a_reference_and_never_an_access(analyse):
    """A name resolving to a function or class belongs to tic-89fa, which
    already exists and says it better.  Letting those through here would emit a
    second, noisier copy of that edge type."""
    # Both ways a callable can arrive: defined here, and imported.  The
    # imported one is the case that matters -- an import binding points
    # straight at the function, so only the kind check refuses it.
    _, _, idx = analyse(
        {
            "pkg/__init__.py": "",
            "pkg/w.py": "def worker(): pass\n",
            "pkg/m.py": (
                "from .w import worker\n"
                "def local(): pass\n"
                "def go():\n"
                "    Thread(target=worker)\n"
                "    Thread(target=local)\n"
            ),
        }
    )
    assert _links(idx) == set()
    named = {r.target_id for r in idx.references}
    assert named == {"pkg.w.worker", "pkg.m.local"}


def test_a_declaration_is_not_recorded_as_a_write(analyse):
    """`LIMIT = 5` at module level is where the symbol comes from, and the
    graph already says so with a CONTAINS edge.  Reads are never redundant
    this way, so only writes are dropped."""
    _, _, idx = analyse({"m.py": "LIMIT = 5\n"})
    assert _links(idx) == set()


def test_a_write_from_anywhere_but_the_owner_is_kept(analyse):
    _, _, idx = analyse({"m.py": "TOTAL = 0\ndef go():\n    global TOTAL\n    TOTAL = 2\n"})
    assert ("write", "m.go", "m.TOTAL") in _links(idx)


def test_a_name_that_resolves_to_nothing_is_dropped_silently(analyse):
    """Deliberately no `unresolved` counterpart, and more so than for
    references: the query behind this matches every identifier in the file --
    33974 candidate sites on ../carnot for 1448 accesses -- so recording the
    remainder would say nothing except that Python has variables."""
    _, _, idx = analyse({"m.py": "def go():\n    return whatever + other.thing\n"})
    assert _links(idx) == set()
