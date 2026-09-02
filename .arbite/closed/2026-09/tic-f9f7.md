---
id: tic-f9f7
title: Role map misses Django and unittest conventions (tests.py, urls.py routing,
  TestCase methods)
status: closed
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 7
tags:
- roles
- entry-points
- django
assignee: claude.opus.001
depends_on:
- tic-22db
blocked_by: null
created: '2026-09-01T12:28:01'
updated: '2026-09-01T17:34:10'
closed: '2026-09-01T17:34:10'
---

## Description
Found while building tic-d8a8 against a Django project (../hypermenu, 59 files) rather than the codebase tic-22db's default rules were tuned on.

The role map (web/src/data/roles.ts) rescued almost nothing there: of 290 caller-less callables, 251 came out `(unexplained)` and the `test` role -- which accounted for 982 of 1107 rescues on carnot -- matched ZERO. Three conventions it does not know:

1. `tests.py`, not `tests/` or `test_*.py`. Django's default layout puts tests in a single `tests.py` per app. TEST_FILE only matches a `tests?/` directory or a `test_*` / `*_test` filename, so `platform/menus/tests.py` and `tests_v1.py` are invisible.
2. Test METHODS on a `unittest.TestCase` subclass, collected by class rather than by module-level name. The name rule (`^test_`) would match them, but only once the file rule does.
3. Django views are entry points via `urls.py` routing, with NO decorator and no naming convention. 251 unexplained entries are overwhelmingly these. Nothing in a decorator- or name-based map can catch them -- it needs the URLconf, which is data the exporter does not currently extract.

(1) and (2) are a rules edit: add `tests?\.py$` and a `_v\d+` variant to the test file pattern, and check that a `test_`-named method inside a TestCase subclass classifies. Cheap, and worth doing regardless of the rest.

(3) is the interesting one and should be argued before it is built. Options, roughly in order of honesty: extract `urlpatterns` from `urls.py` (real, Django-specific, and the exporter has no notion of framework config today); infer from a `views.py`-style module-name convention (cheap, guessy); or accept the gap and let `entry` -- "nothing calls it, no rule explains it, but it calls things" -- carry them, which is what happens now and is arguably already correct. tic-22db deliberately separated `framework-entry` (evidence-backed) from `entry` (absence of evidence) so this case would degrade honestly rather than silently, so this may need no code at all -- but somebody should decide that on purpose.

Note also, from the same run: `no member 'assertEqual' on <TestCase subclass>` appears hundreds of times, and `'Menu.objects.create' not found under ...Menu` dozens. Both are the inherited-member gap already recorded in tic-22db's notes (a method overriding or inheriting from an out-of-project base), and they are the single largest resolution loss on a Django codebase. That belongs in its own ticket alongside tic-97ce rather than here.

Verification: re-run the role map over a Django export and report the before/after rescue counts, as tic-22db did; add rules tests for `tests.py`, a `_v1` suffixed test module, and a TestCase method. Do NOT let the default rule list become Django-specific beyond what is genuinely conventional -- the extensibility is there so a project can add its own.

## Notes
- 2026-09-01T17:34:10 claude.opus.001: Done for (1) and (2). (3) argued and deliberately NOT built; a general ticket
filed instead. Numbers are before/after over a fresh ../hypermenu export.

## (1) and (2): the rules edit

                        rescued   unexplained   orphans
  hypermenu BEFORE          39          351        104
  hypermenu AFTER          240          150         30
  carnot BEFORE/AFTER     1107          541        150   (unchanged)

Roles rescued on hypermenu went from {dunder 11, route 13, property 15} to
{test 181, fixture 20, dunder 11, route 13, property 15}. The `test` role went
from matching NOTHING on a Django project to being its largest single rescue,
which is what it already is on carnot.

carnot is byte-for-byte unchanged, which is the check that mattered: the risk
of a looser file rule is fixing Django by quietly relabelling things
elsewhere, and it does not.

(2) came free with (1), exactly as the ticket guessed. The name rule `^test_`
would always have matched a TestCase method; it never got the chance, because
the file rule ran first and failed.

## The detail that would have silently halved the fix

The ticket proposed a `_v\\d+` variant. The files on disk are HYPHENATED --
`tests-v1.py`, `views-v1.py`, `urls-v1.py`. My earlier probes showed module
ids like `platform.menus.tests_v1`, because the exporter normalises `-` to `_`
in a module id -- but a rule's `file` is matched against the FILE PATH, which
does not. Assuming either separator alone costs the rule half its matches. The
pattern accepts `[-_]`.

Also added: unittest's camelCase fixtures (`setUp`, `tearDown`, `setUpClass`,
`tearDownClass`, `setUpModule`), which Django's TestCase inherits and pytest
also collects. Conventional rather than framework-specific, so they belong in
the defaults beside the pytest names. Worth 20 rescues on hypermenu.

## (3) Django views: argued, and the answer is "not here"

The gap is real and large: 81 of hypermenu's 150 remaining caller-less
callables are literally named in a urls.py. The two urls modules produce
exactly 3 edges in the export, all IMPORTS to the view MODULES, and zero to
any view function -- because `path("o/m/<slug>/", views.menu_items,
name="menu_items")` NAMES the view, it does not call it, and the parser
captures call sites only.

I tested option (b), the cheap filename rule, properly rather than dismissing
it. It is better than the ticket assumed and better than I assumed: of 83
caller-less callables in a `*views*.py`, 79 are named in one of the two
urls.py files I first read, and the remaining 4 (`location_edit`,
`location_hours`, `item_toggle`, `item_move`) turned out to be routed by a
THIRD file I had not read, `urls-v1.py`. So a `views*.py` rule would be 100%
accurate on this codebase and would rescue 83 of the 150.

Rejected anyway, for two reasons:

1. It asserts `route` -- a specific framework claim -- on the evidence of a
   filename. tic-22db deliberately separated `framework-entry` (evidence-
   backed) from `entry` (absence of evidence) so this exact case would degrade
   honestly. A filename is a convention someone followed, not evidence that
   Django routes anything, and a helper in views.py that nothing calls would
   be laundered into "framework entry" -- the same failure the docstring
   already warns about for `@staticmethod`. It happens not to occur in
   hypermenu; the rule cannot tell the difference.

2. The real evidence exists and is extractable. Guessing from a filename while
   `urlpatterns` sits unread in the next file is the wrong trade.

So: option (c), accept the gap. It needs no code, and `entry` already carries
these honestly -- they ARE entry points, just unexplained ones, and 150
unexplained is a far more truthful number than the 351 we started with.

The extensibility is the other half of the answer. DEFAULT_ROLE_RULES is only
the default and every consumer takes the rule list as an argument, so a
hypermenu-specific `{ role: 'route', file: 'views.*\\.py$' }` is exactly what
that design is for. It should be a PROJECT's rule, not a default.

## Filed tic-89fa instead

The honest generalisation is not "parse urls.py", it is that a callable NAMED
without being called is invisible. That shape is everywhere a callback is
registered: `Thread(target=worker)`, `signal.connect(handler)`,
`atexit.register(cleanup)`, `sorted(key=keyfunc)`, `partial(fn)`, click's
`add_command`, flask's `add_url_rule`. Measured on hypermenu, 62 of 231
caller-less callables are mentioned as a bare reference somewhere.

A REFERENCES edge would cover the Django case as a side effect, without the
exporter learning a single Django-specific thing, and would let entry points
treat "referenced but never called" as evidence-backed reachability -- which
is what it is.

## Also seen, and not this ticket's business

`extraction.app.jobs.JobStore` contributes 14 of the remaining unexplained.
Those are methods whose callers exist but did not RESOLVE, so no role rule can
help them -- that is the inherited-member and receiver gap tic-97ce measured,
not a role-map gap.

## Verification

716 web tests (up from 707), 9 new. tsc -b clean, build clean.
Mutation-checked four rules: dropping the tests.py alternative fails 5 tests,
accepting only the underscore separator fails 2, dropping the path anchor so
`latest.py` matches fails 2, and dropping the unittest fixture rule fails 1.
The rule-vs-isTestPath agreement is its own test, so the role map and
tic-1ecc's "are all this function's callers tests?" cannot drift apart.

NOT browser-verified: the dev server reads out/, which currently holds carnot.
Everything above is measured against a fresh hypermenu export.
