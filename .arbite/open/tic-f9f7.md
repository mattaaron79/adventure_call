---
id: tic-f9f7
title: Role map misses Django and unittest conventions (tests.py, urls.py routing,
  TestCase methods)
status: open
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 7
tags:
- roles
- entry-points
- django
assignee: null
depends_on:
- tic-22db
blocked_by: null
created: '2026-09-01T12:28:01'
updated: '2026-09-01T12:28:01'
closed: null
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
