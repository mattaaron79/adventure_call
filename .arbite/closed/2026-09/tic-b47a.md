---
id: tic-b47a
title: 'Parser: record a control-flow breadcrumb for every call site'
status: closed
type: feature
tier: high
domain: io
epic: call-flow
priority: 7
tags:
- parser
- tree-sitter
- control-flow
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-01T07:23:01'
updated: '2026-09-01T11:32:29'
closed: '2026-09-01T11:32:29'
---

## Description
The extraction that turns a call GRAPH into a call FLOW: for each call site, what control-flow constructs it sits inside, relative to its enclosing definition.

_PythonExtractor._build_calls (adventure_call/parser.py) already walks up from a call node to find its enclosing definition via _enclosing_symbol. Extend that same walk to collect the chain of control-flow constructs it passes through on the way, and store it on CallSite (adventure_call/models.py) -- a compact ordered list such as ["if", "for", "try:except"], innermost last, stopping at the enclosing def so a nested function's breadcrumb is relative to ITS body and not the outer one.

Constructs worth distinguishing: if / elif / else, match-case, for / while (the call can fire N times), try-body vs except vs finally (error-path calls read completely differently from happy-path ones), with, boolean short-circuit (`and`/`or`/ternary/comprehension guard -- the call is conditional even though no statement guards it), and `if TYPE_CHECKING` (which is NOT runtime flow at all and must be separable). Derive `guard_depth` from the chain rather than storing it twice.

Naming discipline, decided with the user 2026-09-01 and load-bearing for the whole mode: guard_depth == 0 means UNGUARDED, not "unconditional" and not "always". An early return or raise above the call kills it, and the caller may itself be conditional, so "always" would be a lie the UI then repeats. Use the word `unguarded` in the field names, the docstrings and anything user-facing. tic-3a20 covers the honest "unavoidable" answer separately.

Costs and constraints: this is one extra upward walk per call site on nodes already visited, so it should not measurably change parse time -- measure and record it. The exported JSON grows by a short list per call site; check the size delta on ../carnot (currently 5.2MB graph / 9.5MB registry) and say whether it matters. Bump SCHEMA_VERSION and mirror the new fields in web/src/data/types.ts, which is hand-written from models.py and must stay in sync.

Verification: parser tests over fixtures covering each construct, nesting, a call in a nested def (breadcrumb relative to the inner def), a call in a comprehension guard, and a TYPE_CHECKING import block. Confirm a full ../carnot run still produces zero diagnostics. Run the Python test suite.

## Notes
- 2026-09-01T11:32:29 claude.opus.001: Implemented and verified end to end against ../carnot.

`CallSite.control: list[str]` -- the constructs between a call and its enclosing definition, outermost first, e.g. ["if", "for", "try:except"]. Built by `_PythonExtractor._control_path`, which walks up alongside the existing enclosing-definition search and stops at the first definition boundary, so a nested function's breadcrumb is relative to ITS body. A `lambda` is deliberately NOT a boundary -- it is not a symbol, so a call inside one keeps the enclosing function's context and gains a `lambda` token of its own.

SCOPE I HAD TO ADD, and the ticket would have delivered nothing without it: CallSite IS NEVER EXPORTED. Resolved calls become graph EDGES (which carried no per-site data) and the registry exports Resolutions, not CallSites. So a breadcrumb stored only on CallSite would have been invisible to tic-5069 and to every consumer. Threaded it through: CallSite -> Resolution.control -> the edge's `controls`. Verified on the real export that the edges carry 4181 breadcrumbs against a `count` sum of 4181 -- exactly parallel, one entry per call site.

`controls` is the one edge field that must NOT be folded into a set, and _merge_edge's docstring now says why: every other field answers "what is true of this pair", but a breadcrumb answers "how was this particular call reached", and two sites reaching the same callee differently is precisely the mixed case tic-5069 exists to detect. So it is parallel to `count`, not to the de-duplicated `lines`.

POSITION WITHIN A CONSTRUCT IS THE WHOLE GAME. A construct contributes a token only when the call sits in a part of it the construct actually governs. `if check():` does not guard `check` -- the test runs whenever the `if` is reached. `for x in source():` does not guard `source`, evaluated once before any iteration. A `while` test is a loop position but not a guarded one. A `try` body, a `finally` and a `with` body are not guards at all, because reaching them runs them. A naive walk-up would have marked all of these guarded and quietly devalued the entire signal: on carnot that would have been roughly 1500 extra false guards against 1029 real ones.

Naming discipline held throughout: the word is `unguarded`, in the field names, the docstrings, the GUARD_TOKENS docstring on both sides of the wire, and the TypeScript mirror. Each says explicitly that unguarded is not "unconditional" and not "always runs", that an early return or raise above the call kills it, and that tic-3a20 is where a real "unavoidable" comes from.

Token vocabulary (23), each classified guard / loop: if, if:elif, if:else, for, for:else, while, while:test, while:else, try, try:except, try:else, try:finally, with, match:case, comprehension, comprehension:if, comprehension:test, bool, ternary, lambda, assert, decorator, type-checking. Loop bodies ARE guards (an empty iterable runs the body zero times). `assert` is recorded but NOT a guard: it is genuinely skipped under -O, but marking every test assertion guarded would drown the signal -- so the information is there without inflating the depth. `guard_depth`, `unguarded`, `in_loop`, `in_except`, `in_finally`, `in_type_checking` and `short_circuit` are computed PROPERTIES off the chain, never stored twice, as the ticket asked.

A BUG WORTH RECORDING because it failed silently. My first cut compared node positions with `child is parent.child_by_field_name("body")`. tree-sitter builds a fresh Node wrapper on every access, so identity is never true -- every field test returned False and every call came out unguarded, with no error anywhere. Caught only because I ran the fixture and read the output rather than trusting the tests I had not written yet. Now a `_is_field` helper comparing node ids, with a docstring saying exactly this.

MEASURED on ../carnot (182 files, 3979 nodes), all as the ticket asked:
- Parse cost: 0.807s -> 0.894s best-of-3, i.e. +87ms, about +11% of parse time and +6% of the 1.40s full pipeline. Real but small; not worth a flag to disable.
- Export size: graph 5.51 -> 5.75 MB (+4.3%), registry 8.92 -> 9.14 MB (+2.5%). Modest.
- Diagnostics: still 0.
- 4181 resolved call sites: 75.4% unguarded, guard depths 0/1/2/3/4/5 = 3152/825/147/47/7/3.
- Token frequency: if 626, with 414, assert 414, for 269, try 120, try:except 87, if:elif 51, comprehension 50, bool 42, if:else 42, while 41, match:case 40, lambda 26, ternary 25, try:finally 17, comprehension:test 12, decorator 11, comprehension:if 3, try:else 1.

THE NUMBER tic-5069 ASKED FOR IN ADVANCE. That ticket says to report the tag distribution because "if 95% of edges come out unguarded, the tag is not earning its ink". Answering it now, since the data is here: per EDGE, unguarded 2689 (78%), guarded 683 (20%), mixed 77 (2%). It earns its ink -- 20% guarded is a real discriminator and the 77 mixed edges are the genuinely interesting ones. Also: 283 edges have at least one call site inside a loop, and 28 edges are reached ONLY from an except block, which is the "error-path" node tag that ticket wants.

One honest null result: 0 edges are TYPE_CHECKING-only, because TYPE_CHECKING blocks hold imports, not calls. The token is defensive rather than load-bearing on this codebase, and tic-5069 should not spend a visual channel on it without checking another project first.

Schema 2 -> 3, mirrored in web/src/data/types.ts, where `controls` and `control` are OPTIONAL for the same reason `returns` is: the app reads whatever `out/` holds, and an older export predates them. Also exported GUARD_TOKENS and a `guardDepth()` helper there, so the web side derives depth from the same list rather than growing a second copy that can drift from models.py.

Tests: 19 new (131 -> 150). Every construct in the ticket's list, both positions of the ones where position matters (if test vs body, for iterable vs body, while test vs body, ternary test vs branches, boolean left vs right, comprehension filter vs element, with manager vs body, match subject vs case), a nested def's breadcrumb being relative to its own body, three-deep nesting reading outermost first, TYPE_CHECKING, and -- covering the scope I added -- that the breadcrumb reaches the graph edge with one entry per call site including the mixed case, and that unresolved calls carry it too. Python 150 passed, web 584 passed, tsc -b clean, production build fine.

Verification note: as with tic-2255, ./out could not be written (PermissionError on os.replace, most likely a running dev server holding it open), so the end-to-end runs went to a scratch directory and the user's export was left untouched. It is now two schema versions behind; regenerating it is a one-command refresh whenever the file is free.
