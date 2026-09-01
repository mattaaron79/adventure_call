---
id: tic-97ce
title: 'Resolver: bind local variables to types so receiver method calls resolve'
status: closed
type: feature
tier: high
domain: io
epic: call-flow
priority: 6
tags:
- resolver
- type-inference
- coverage
assignee: claude.opus.001
depends_on:
- tic-2255
- tic-9ff4
blocked_by: null
created: '2026-09-01T07:23:44'
updated: '2026-09-01T14:59:49'
closed: '2026-09-01T14:59:49'
---

## Description
The largest remaining recoverable slice of unresolved calls, after tic-9ff4.

Measured on the current ../carnot export: `unknown receiver 'pilot'` (389 sites), `'app'` (250), `'console'` (56) and friends. I checked whether these were annotated parameters -- they are NOT. They are LOCALS, bound by forms like `async with app.run_test() as pilot:` and `x = Foo()`. The resolver has no within-function symbol table, so any method call on a local dies.

Add a narrow, deliberately shallow one: within a single function body, bind a local name to a symbol id for the unambiguous forms only -- `x = SomeClass(...)` where SomeClass resolves to an in-project class, `x: SomeClass = ...` and bare `x: SomeClass`, `with expr() as x` / `async with expr() as x` where the callee's return type is known, and `for x in ...` only where the iterable's element type is obvious (probably: skip it in v1). Then use those bindings in SymbolResolver._resolve_call's receiver lookup, marked confidence `heuristic`, never `exact` -- a local can be rebound and this analysis does not track that.

Explicitly out of scope: reassignment/flow sensitivity, container element types, duck typing, and anything requiring a real type checker. If a name is bound twice to different types, drop it rather than guess.

Depends on tic-2255 (`returns` as its own field) for the `with ... as` case, which needs the context manager's return type without parsing signature text.

Honesty about the ceiling, so nobody chases this too far: a large share of the remaining unresolved calls are duck-typed stdlib methods on locals -- `lines.append` (110), `parts.append` (42), `"\n".join` (52), `s.strip` -- which will never resolve to an in-project symbol and should be classified as stdlib methods rather than counted as holes. Consider adding that classification here; it makes the coverage numbers in tic-171f honest instead of pessimistic.

Verification: fixture tests per binding form plus the rebinding case (must NOT resolve); re-run ../carnot and report the before/after calls_resolved / calls_heuristic / calls_unresolved numbers in the notes; confirm no previously-exact resolution downgrades. Run the Python test suite.

## Notes
- 2026-09-01T14:35:29 claude.opus.001: MEASURED BEFORE BUILDING, AND THE PREMISE DOES NOT HOLD. Local type binding
would resolve ZERO additional calls, on both available codebases.

## Method

Built an oracle (scratchpad/oracle.py) using Python's own `ast` over the
source plus the existing export for the symbol table -- so the answer is about
the DATA, independent of the tree-sitter implementation this ticket proposes.
It implements exactly what the ticket asks for, and a little more: `x = C()`,
`x = f()` following f's `returns` (tic-2255), `x: T`, `with expr() as x`, and
annotated parameters. Names are resolved MODULE-LOCALLY -- module members, then
import bindings -- matching what SymbolResolver already does.

Two earlier versions of the oracle were wrong and both reported a false zero
for the wrong reason; recording them because the second is a trap anyone
re-doing this will fall into:

  v1 only followed `x = ClassName()`. carnot's dominant form is
     `app = build_app()` -- a FUNCTION whose return annotation names the class.
  v2 followed returns, but resolved the function name globally and required it
     to be unique. carnot has SIX `build_app` functions, one per test module.
     Module-scoped resolution is not an optimisation here, it is the
     difference between an answer and a false negative.

## Result

                                                carnot    hypermenu
  `unknown receiver` sites                        1965          600
  RESOLVABLE by local binding                        0            0

  bound, but the expression names no type       1321 (67%)   382 (64%)
  no binding at all                              293 (15%)   179 (30%)
  bound to a project class, member on a
      FOREIGN BASE                               148 ( 8%)    34 ( 6%)
  binds to a type we have no definition for      114 ( 6%)     2
  bound to a project class, no such member        64 ( 3%)     1
  rebound to two things (dropped by design)       25 ( 1%)     2

## Why zero, and why it is structural rather than bad luck

The binding analysis WORKS. It correctly identifies `app` as
src.carnot.cli.tui.CarnotApp and `form` as hypermenu's ItemForm. The methods
being called on them are inherited from a framework base class we hold no
definition for:

  carnot     CarnotApp.run_test (69), .query_one (62), .query (8), .exit (2)
             -- textual.app.App
  hypermenu  ItemForm.is_valid (12), BusinessForm.is_valid (8),
             QRConfigForm.is_valid (6), LocationForm (2), HoursForm (2)
             -- django.forms.ModelForm

That is the shape of method calls in framework-heavy Python: you subclass their
class and call their methods on your instance. Knowing the receiver's type is
necessary and not remotely sufficient.

The rest of the volume is stdlib duck typing on locals, exactly as the ticket's
own closing paragraph predicted -- carnot `lines.append` / `s.pop` /
`session.setdefault` / `parts.append`, hypermenu `[]` (30 sites), `Path(...)`,
`argparse.ArgumentParser(...)`, `re.compile(...)` -- plus third-party receivers
whose types we could name but whose members we could never look up:
`app.run_test()` -> textual Pilot (272 sites), `Console(...)`, `Table(...)`,
`db.get_pool(...)`, `pool.acquire(...)`, `ctx.new_page(...)` (asyncpg,
playwright).

## What this means for the ticket

The ticket's stated goal -- "the largest remaining recoverable slice of
unresolved calls" -- is not recoverable. Implementing it as written is roughly
400 lines of parser and resolver machinery for zero new edges on both
codebases I can measure, and I do not believe a third codebase would differ:
the failure is structural, not a property of these two projects.

The value is in the ticket's LAST paragraph, not its first. Local binding turns
out to be the right machinery pointed at the wrong outcome: it cannot RESOLVE
these calls, but it can CLASSIFY them, which is what tic-171f's coverage
numbers need. Concretely, `unknown receiver 'app'` could become:

  * `foreign base: textual.app.App` -- receiver is a project class, the member
    is inherited from a base we have no definition for. 148 + 34 sites, and
    this is the category the ticket did not anticipate at all.
  * `external: rich.console.Console` -- receiver binds to a non-project type.
  * `stdlib method on list` -- receiver binds to a builtin container.
  * `unknown receiver` -- genuinely unknown, which is a much smaller number and
    an honest one.

That reclassification is worth doing. It is a different ticket from the one
written here, and it needs a decision rather than a deviation, so I stopped and
asked rather than quietly rebuilding the scope.

Oracle and both exports left in the session scratchpad; hypermenu was exported
fresh (918 resolved / 3527 unresolved = 20.7%, matching the recorded figure).
../carnot's out/ was not touched.

- 2026-09-01T14:45:44 claude.opus.001: SCOPE CHANGE, agreed with the user 2026-09-01 after the measurement above.

This ticket is no longer 'resolve receiver method calls'. It is 'CLASSIFY them'. Same machinery -- shallow, within-function local type binding -- pointed at the outcome the evidence supports.

The deliverable: split the 'unknown receiver' bucket (1965 carnot / 600 hypermenu) into reasons that say what kind of thing the call actually goes to.

  A. foreign base: <Base>      receiver binds to an in-project class; the member
                               is not on it or any in-project ancestor; some
                               ancestor has a base we hold no definition for.
                               carnot 148, hypermenu 34. The category the
                               original ticket did not anticipate.
  B. external: <dotted>        receiver binds to an imported external name.
                               Emitted DOTTED so deriveExternalCalls's existing
                               root-module split keeps working and these fold
                               into the external sinks the mode already draws
                               (Console -> rich, Path -> pathlib, ArgumentParser
                               -> argparse, re.compile -> re).
  C. stdlib method on <type>   receiver binds to a literal ([], {}, '', an
                               f-string) or to an annotation naming a builtin
                               (list[str], str, dict). carnot's lines.append /
                               s.strip / parts.append, hypermenu's 30 [] sites.
  D. no member 'X' on <class>  receiver binds to a project class and the member
                               is genuinely absent with no foreign base to
                               explain it. Reuses the reason self.x already
                               emits. A real finding: a bug or a dynamic
                               attribute.

Anything else stays 'unknown receiver', which becomes a much smaller and much
more honest number.

Explicitly still out of scope, unchanged from the original: flow sensitivity,
container element types, duck typing, reassignment. A name bound twice to
different types is dropped, not guessed.

NOT doing: inferring pilot's type from 'async with app.run_test() as pilot'
because run_test sits on a foreign base. That is 389 carnot sites and the
single biggest group, but 'the value returned by a textual method is a textual
object' is an inference the data does not support -- it is usually true and
sometimes a str. Those stay unknown.

- 2026-09-01T14:59:48 claude.opus.001: Done, re-scoped as agreed. Numbers are clean before/after on the same source:
../carnot's out/ was NOT usable as a baseline (the user's export predates a
carnot edit -- 182 files against 183), so the baseline was regenerated by
stashing this branch and re-running the old code.

## Result

                              carnot                 hypermenu
  calls_resolved       4221 -> 4279  (+58)      918 ->  921  (+3)
  calls_unresolved     6284 -> 6226  (-58)     3527 -> 3524  (-3)
  CALLS edges          3467 -> 3505  (+38)      607 ->  613  (+6)

  unknown receiver     1973 -> 1346  (-627, -32%)   600 -> 458  (-142, -24%)
  ambiguous name        856 ->  733  (-123)         320 -> 276  (-44)
  external: <mod>      1264 -> 1513  (+249)        1133 -> 1185 (+52)
  stdlib method on        0 ->  301  NEW              0 ->   86  NEW
  foreign base            0 ->  142  NEW              0 ->   45  NEW

Two thirds of a `unknown receiver` bucket on carnot, a quarter on hypermenu,
turned into a statement about where the call actually goes. The `ambiguous`
drop is the same effect from the other side: knowing the receiver is a list
beats the coincidence that exactly one project symbol is named `append`.

Every new `external:` attribution lands on a real package root -- rich,
pathlib, fastapi, threading, textual, django, asyncpg, argparse -- and the
number of DISTINCT roots is unchanged (70 and 38). So this adds volume to
sinks mode 3 already draws rather than inventing new ones, and needed no web
change: deriveExternalCalls's root split handles the dotted paths as-is.

Schema is untouched (version 3, identical key sets); `locals` is parser-to-
resolver only and is never exported.

## Resolution happens too, just rarely -- as predicted

+58 carnot / +3 hypermenu new edges, all `heuristic` with reason `local
binding`, never `exact`: a local can be rebound and nothing here tracks that.
The measurement said this would be near zero and it nearly is; the value is in
the classification, exactly as re-scoped.

## Every lost edge was verified wrong

11 edges disappeared (7 carnot, 4 hypermenu). Each was a unique-name guess the
binding now contradicts, and each was checked against the source:

  parser.parse_args      was carnot's own commands.parse_args; it is argparse's
  @app.delete (x2)       was Transcript.delete; it is FastAPI's route decorator
  parser.feed            was openrouter._Accumulator.feed; it is textual's
                         XTermParser
  _browser_cm.__enter__  was kernel.scope._ScopeContext.__enter__; it is
                         camoufox's
  tokens/payload.update  was JobStore.update; they are dicts

No `exact` resolution changed. The net is +44 edges and 11 wrong ones removed.

## Four bugs found by measuring, not by testing

Each cost real edges and none would have shown up in a fixture test, because
each needed a real codebase's shape to appear:

1. CALLING AN EXTERNAL NAME DOES NOT PRODUCE AN EXTERNAL OBJECT.
   `location = get_object_or_404(Location, pk=...)` returns a Location, not a
   django object -- claiming external dropped 3 correct hypermenu edges. Worse,
   `app = build_app()` in carnot's tests resolved "external" only because the
   resolver cannot link imports between test modules, dropping 5 more. Fixed
   with a PEP 8 CapWords test on the external name: we hold no definition of
   an external symbol, so spelling is the only signal for "is this a class",
   and when it does not look like one we record NOTHING rather than swap one
   guess for another.

2. `typing.Any` BOUND AS IF IT WERE A TYPE. `session: Any` made every method
   call on `session` a call out to `typing`, costing 3 correct carnot edges.
   Any/object/None/NoReturn/Never now bind nothing -- `Any` is the explicit
   spelling of "unknown".

3. A RECEIVER CLAIMED A CHAIN IT DOES NOT OWN.
   `app.session.transcript.index_of()` is a call on the transcript; the
   receiver's class and its foreign base were both answering for it, costing 5
   carnot edges. Classification is now restricted to a single direct member
   access. Walking the chain needs attribute types, which is tic-13d7.

4. The oracle itself was wrong twice before it was right, both times reporting
   a false zero -- see the previous note. The second trap (resolving a factory
   name globally rather than module-locally, when carnot has six `build_app`s)
   is one anyone re-doing this measurement will hit.

## Tests

183 python tests, up from 151: 21 resolver, 11 parser. Fixture tests per
binding form (constructor, annotated factory via tic-2255's `returns`,
variable annotation, quoted forward reference, with-as, annotated parameter),
per classification (stdlib literal, builtin annotation, external class,
external function, foreign base, missing member), and per refusal (rebinding,
rebinding to something unreadable, container annotation, Any, longer chain,
closure scope, sibling scope isolation). Parser tests cover the scoping rules
that keep a local from becoming a symbol: module level, class body and
`self.x` are all excluded, nested functions get their own scope, tuple
with-targets are not bound.

Mutation-checked the four rules that carry the design -- disabling the
rebinding drop, the CapWords guard, the Any guard and the single-member
restriction each fails its own test and nothing else.

One pre-existing test changed expectation rather than being deleted:
`test_ambiguous_names_stay_unresolved` asserted that `admin.greet()` stays
unresolved because both User and Admin define `greet`. The fixture binds
`admin = models.Admin(...)` two lines above, so Admin.greet is simply the
right answer; it is now
`test_a_bound_receiver_beats_an_ambiguous_method_name`, and a new
`test_ambiguous_names_stay_unresolved_without_a_binding` keeps the unbound
path covered.

## Known simplifications, all deliberate

* `global x` assigned inside a function is recorded as that function's local.
  Benign, because the binding is only ever consulted within the scope that
  performed it, where the assignment did just happen.
* A snake_case external factory is not classified, so `asyncpg.connect(...)`
  and `re.compile(...)` stay unknown (~50 carnot sites). Honest beats complete.
* `pilot`, carnot's single biggest receiver at 389 sites, stays unknown:
  `async with app.run_test() as pilot` needs the return type of a method on a
  foreign base. Recorded in the scope note as explicitly not attempted.

## Follow-up

Filed tic-f21f: tic-171f's coverage still counts all 619 newly-classified
carnot sites (and 183 hypermenu ones) as unresolved, which reads as "the
analysis has a hole here" when the truth is "this call leaves the project and
we know where to". Left as its own ticket rather than editing 171f's
just-landed code unasked.
