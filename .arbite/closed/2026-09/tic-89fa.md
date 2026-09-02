---
id: tic-89fa
title: 'REFERENCES: a callable named without being called is invisible (Django URLconf,
  callbacks, handlers)'
status: closed
type: feature
tier: high
domain: io
epic: call-flow
priority: 7
tags: []
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-01T17:33:26'
updated: '2026-09-01T18:45:03'
closed: '2026-09-01T18:45:03'
---

## Description
This is a **raw** ticket: it was captured from a brief request without proper classification. It must be filled out before it can be worked.

Original request: A callable NAMED without being called is invisible to the graph, and it is how a lot of real code is reached. Django's URLconf is the case that surfaced it (tic-f9f7): platform/menus/urls.py holds path('o/m/<slug>/', views.menu_items, name='menu_items') -- views.menu_items is an ARGUMENT REFERENCE, not a call, so the parser (which captures call sites only) never sees it. Measured on ../hypermenu the two urls modules produce exactly 3 edges, all IMPORTS to the view MODULES, and zero to any view function; 81 of the 150 remaining caller-less callables are literally named in a urls.py. But this is not a Django problem and must not be solved as one. The same shape is everywhere a callback is registered: Thread(target=worker), signal.connect(handler), atexit.register(cleanup), sorted(key=keyfunc), functools.partial(fn), click's add_command, flask's add_url_rule, pytest's parametrize. Measured more broadly on hypermenu, 62 of 231 caller-less callables are mentioned as a bare reference somewhere in the project. Proposal: a REFERENCES edge type -- a resolvable symbol named in an expression position where it is not being called. The parser already flattens dotted names for call sites (_attribute_path) and the resolver already resolves them, so the machinery is mostly present; what is new is capturing identifiers/attributes that are NOT a call's callee, and deciding how to avoid drowning the graph (probably: only when the target resolves to an in-project CALLABLE, and only in argument, assignment-value and collection-literal positions). Entry points would then treat 'referenced but never called' as evidence-backed reachability, which is what it is, instead of the absence-of-evidence 'entry' they get today. Note the deliberately-rejected alternative recorded in tic-f9f7: a filename rule matching views*.py would rescue 83 of hypermenu's unexplained callables and measured 100% accurate there, but it asserts a framework claim on the evidence of a filename, and the real evidence is sitting in urls.py unread.

What still needs to be done (human or agent triage, typically via `arbite fetch`):
- title -- replace "Requires Classification" with a short human-readable summary
- tier -- low | medium | high | frontier (agent capability tier required to work it; how capable the agent must be, not how urgent the work is)
- domain -- e.g. mesh, image_gen, audio_gen, ui, io (drives routing)
- epic -- this raw ticket is auto-grouped under the 'classification' epic (so triage can find it with `arbite list next --epic classification`); replace it with the real epic this work belongs to, e.g. mesh-pipeline
- priority -- numeric urgency index, lower = more urgent
- description -- expand this body into a proper task description based on the original request, including any acceptance criteria
- status -- set to `open` once classified so it becomes workable via `arbite list next` (skip this if you're claiming it yourself instead -- `arbite claim` sets status to `in_progress` directly)

## Notes
- 2026-09-01T18:31:10 claude.opus.001: DESIGN, measured before building. An ast oracle over both codebases, resolving
names module-locally the way SymbolResolver does.

## Which positions earn a REFERENCES edge

Distinct caller-less callables rescued, cumulative as positions are added:

                    hypermenu   carnot
  argument              56        15
  + assign-value        57        16
  + collection          62        45
  + decorator           62        45
  + default             62        45
  + return              62        45

BUILD: argument, assign-value, collection.
DROP: decorator, default, return -- each rescues exactly ZERO on both. Bare
decorators are 123 sites on carnot and 131 on hypermenu, and not one resolves
to an in-project callable: `@property`, `@staticmethod`, `@dataclass`,
`@pytest.fixture` are all external. Worth revisiting only for a project that
defines its own bare decorators.

`assign-value` rescues 1 and 1. Kept anyway: it is the canonical
`handler = my_func` shape and costs one query pattern, but nobody should
expect it to move a number.

## Scope awareness is REQUIRED, and it is most of the work

The first oracle had none and was badly wrong. On carnot it resolved 596
argument references; with the enclosing function's bound names excluded that
falls to 92, and distinct rescues fall from 50 to 15. About 85% of what it
found were LOCALS shadowing a module-level symbol -- `def test_x(session):
do(session)` reporting a reference to the pytest fixture named `session`.
Emitting those would have made the edge type mostly noise.

Two cheaper rules were measured and both fail:

                              hypermenu   carnot
  full scope awareness            62        45
  dotted names only in bodies     61        14
  module and class level only     61        14

Django's config is module-level, so hypermenu barely notices. carnot loses 69%
of the value, and what it loses is the good part: `plan_command.py` builds a
command dispatch table `[_cmd_state, _cmd_validate, _cmd_add_role, ...]`
INSIDE a function, and every one of those commands is caller-less in the call
graph today. Also `_refuse_network` and `_break_on_thread`, passed as
monkeypatch targets. carnot's in-function references are all BARE names, which
is why the dotted-only rule buys nothing over module-level-only.

So the parser has to know what names each function binds: parameters,
assignment targets (including pattern/tuple unpacking), augmented assignment,
walrus, for and comprehension targets, with-as and except-as, global/nonlocal,
function-local imports, and nested def/class names. A MISSED binding form is a
false positive, so the set has to be over-broad rather than under.

The check belongs in the parser, not the resolver: it is a purely syntactic
question, the tree is right there, and doing it at parse time means nothing
new has to cross the model boundary except the Reference itself.

## The Django case, and a vindication of tic-f9f7

hypermenu has 83 caller-less callables in a views file. References rescue
exactly 43: all 37 in views.py and all 6 in ai_views.py. The other 40 are all
in `views-v1.py` and `ai_views-v1.py`, and `urls-v1.py` imports the NON-v1
`views` -- so the v1 copies are genuinely referenced by nothing. They are dead
code, and the analysis says so.

That is the argument tic-f9f7 made, now with evidence: the rejected filename
rule would have labelled all 83 as routes, including the 40 that are dead. The
real evidence was in urls.py, and reading it distinguishes live from dead
where a convention cannot.

## Volume

Small. 128 module-to-callable pairs on hypermenu, 91 on carnot, from 375 and
753 candidate sites -- the "must resolve to an in-project callable" filter
does the work. No risk of drowning the graph.

- 2026-09-01T18:45:03 claude.opus.001: Done. Numbers from the shipped implementation, against fresh exports of both
codebases.

## Result

  REFERENCES edges                    carnot 300     hypermenu 160
  distinct callables referenced              236                67
  caller-less callables rescued              215                62

Entry-point roles, before and after:

  carnot     entry 396 -> 237 · orphan 154 -> 119 · referenced 194
  hypermenu  entry 120 ->  76 · orphan  30 ->  25 · referenced  49

159 of carnot's unexplained entries and 35 of its possible-orphans now have
evidence, and the evidence is legible: `_cmd_state — named by run`,
`ai_import — named by urls_v1 and urls`.

## The Django case, and tic-f9f7's argument settled

All 37 caller-less callables in hypermenu's views.py and all 6 in ai_views.py
are rescued. The other 40 in the same shape are in `views-v1.py` and
`ai_views-v1.py`, and `urls-v1.py` imports the NON-v1 `views` -- so those 40
are referenced by nothing and are genuinely a dead older copy.

That is the tic-f9f7 argument with evidence behind it. The filename rule I
rejected there would have labelled all 83 as routes, including the 40 that are
dead. Reading the actual URLconf distinguishes live from dead; a convention
cannot.

## The oracle was right about everything it could see

The oracle predicted 45 rescues on carnot against the implementation's 215.
Not a discrepancy: 171 of the 215 are NESTED definitions, and the oracle's
simplified resolver only did module members plus import bindings, so it could
not resolve a nested `def` at all. 215 - 171 = 44, against its 45. The real
resolver's `_lookup_local` is the whole difference, and those 171 are mostly
test helpers handed to monkeypatch -- genuine, and already filtered out of
mode 3's overview by `includeTests`.

hypermenu matched exactly: 62 predicted, 62 delivered, 43 in views files.

## Two things measurement caught that would have shipped broken

1. SCOPE AWARENESS IS THE FEATURE, not a refinement. The first oracle had
   none and resolved 596 argument references on carnot; with the enclosing
   function's bound names excluded that fell to 92, and distinct rescues from
   50 to 15. About 85% were LOCALS shadowing a module-level symbol --
   `def go(session): do(session)` reporting a reference to a fixture called
   `session`. Two cheaper rules were measured and both fail: module-level-only
   and dotted-names-only each score 61/62 on hypermenu (Django config is
   module-level) but 14/45 on carnot, whose references are bare names inside
   functions -- a command dispatch table `[_cmd_state, _cmd_validate, ...]`
   whose every entry is caller-less today.

   So the parser builds a bound-name set per scope from the query's
   assignment/tuple-unpack/augmented/walrus/for/comprehension/with-as/
   except-as/global captures plus parameters. Deliberately over-broad: a
   missed binding form is a false reference, while one caught unnecessarily
   only costs a reference we decline to draw.

2. SUPERCLASSES ARE AN `argument_list` IN THIS GRAMMAR, so `class Greet(Tool)`
   looked exactly like `f(Tool)`. That was 231 of 434 references on carnot --
   more than half the edge type restating what `SymbolDef.bases` already says.
   Excluded. If inheritance is worth drawing it deserves its own edge type,
   not a majority share of this one.

## Deliberate exclusions, each measured

* decorator, parameter default, return: rescue exactly ZERO on both
  codebases. 123 bare decorators on carnot and 131 on hypermenu, and not one
  resolves to an in-project callable -- `@property`, `@staticmethod`,
  `@dataclass`, `@pytest.fixture` are all external.
* import aliases are NOT bindings. The import is what makes `views.home` mean
  the view; treating the alias as a binding suppressed every URLconf
  reference. There is a mutation test for this.
* nested definition names are NOT bindings either. A nested `def` does shadow
  an outer name, but the resolver already scopes it (`_lookup_local` tries
  `<scope>.<name>` first), so the reference resolves to the nested one -- and
  referencing a nested helper is a real reference, not a false one.
* no `unresolved` counterpart. The query is loose on purpose (`f(x)` matches
  every `x`), so carnot has 753 candidate sites for 300 edges; recording the
  rest as unresolved would swamp tic-f21f's coverage figures with noise.

## Shape of the data

REFERENCES is its own edge type, never folded into CALLS, because the two say
different things: a call is flow, a reference is only evidence that something
CAN reach the target. Anything walking execution must ignore these; anything
asking "is this dead" must not. `ReferenceLink` is kept out of
`ResolutionIndex.resolutions` for the same reason.

Web side: `deriveReferences` indexes them by target, `Workspace.references`
carries it, and `EntryRole` gains `referenced` -- ranked above `entry` and
`orphan` (both the ABSENCE of evidence) and below `framework-entry` (a rule
names the mechanism; a reference only points at the wiring). It is explicitly
NOT proof the callable ever runs, only that it is wired up.

Schema 3 -> 4.

## Verification

203 python tests (up from 183) and 769 web tests (up from 754). tsc -b clean,
build clean.

Mutation-checked the three rules that carry it: treating import aliases as
bindings fails 2 tests (including the Django one), dropping the shadow check
fails 2, and including superclass lists fails 1.
