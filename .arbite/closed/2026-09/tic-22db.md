---
id: tic-22db
title: Entry points, including decorator-derived roots
status: closed
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 4
tags:
- call-graph
- entry-points
- decorators
assignee: claude.opus.001
depends_on:
- tic-a8a6
blocked_by: null
created: '2026-09-01T07:23:45'
updated: '2026-09-01T09:40:07'
closed: '2026-09-01T09:40:07'
---

## Description
An entry point is where execution enters the codebase, and it is the root the call-flow mode hangs off. In-degree zero over CALLS is the naive definition and it LIES: web routes, CLI commands, event handlers, fixtures and properties are all called by a framework, not by project code, so they look like orphans while actually being the real roots.

Fix that with the decorators already in the export. Sample from ../carnot: `@pytest.fixture` (43), `@property` (42), `@classmethod` (6), `@staticmethod` (2), `@on(Button.Pressed, "#allow")`, `@work(thread=True, exclusive=True)`, `@metric(...)`. Match on the decorator's dotted head, ignoring call arguments, so `@on(Input.Submitted, "#prompt")` and `@on(TabbedContent.TabActivated)` both classify as the same role.

Deliver, in the derive layer next to tic-a8a6's call graph: a per-symbol classification into a small role vocabulary -- something like `entry` (in-degree zero, no decorator explanation), `framework-entry` (decorator says a framework calls it, with the role named: route / command / fixture / handler / task / property), `internal` (has in-project callers), and `orphan` (no callers, no callees, no decorator role -- possibly dead, possibly only called dynamically). Say `possibly` in the UI copy; 902 computed callees mean dead-code claims are not safe.

Make the decorator -> role map DATA, not code, and put it somewhere a user can extend without a rebuild -- every codebase has its own decorators, and a hardcoded list is stale the moment it meets a second project.

Verification: unit tests over synthetic graphs for each role, decorator matching with and without arguments, dotted decorators, and an unknown decorator falling through to plain in-degree logic. Against the real export, report how many apparent orphans the decorator map rescues -- that number is the ticket's whole justification. npm run test, tsc -b.

## Notes
- 2026-09-01T09:40:07 claude.opus.001: Implemented and measured against the real ./out export (../carnot).

Two new modules, deliberately kept out of derive.ts (which is already 852 lines and would have gained a third responsibility): web/src/data/roles.ts holds the role vocabulary and the default rule list as pure data with a matcher, and web/src/data/entryPoints.ts holds the classification. entryPoints imports from derive, derive imports neither, so there is no cycle.

Role vocabulary as specified: `internal` (something in the project calls it), `framework-entry` (nothing does, but a rule explains why), `entry` (nothing does, no rule explains it, but it calls things -- the top of some flow), `orphan` (no callers, no callees, no explanation -- POSSIBLY unused, and the type docs say never to state it more strongly). One refinement on the ticket: `framework` and `reason` are set whenever a rule matches, INCLUDING on an internal symbol -- that a method is a @property stays true and worth showing even when the project also calls it directly. Making role and framework-role a single either/or field would have thrown that away. `reason` carries the evidence ("decorator @pytest.fixture", "name matches /^test_/") so the UI can explain itself rather than assert.

THE MAP IS NOT DECORATORS ALONE, and it cannot be. pytest collects tests by NAME, not by decorator, and that single rule turns out to cover the overwhelming majority of caller-less functions here (982 of 1107 rescues). The rule shape is therefore {role, decorator?, name?, file?} with AND semantics across whichever fields a rule declares -- so the test rule requires both a `^test_` name and a test-ish path, and a `test_connection` helper shipped in library code is correctly NOT called a test. Also added the dunder protocol (`__enter__`, `__repr__`, ...), which the language calls itself and which no decorator marks.

Two deliberate non-entries, both tested: @staticmethod and @classmethod are NOT framework roles. They change how a method binds, not who calls it, and a rule for them would quietly launder dead code into "framework entry".

MEASURED against the real export (2574 nodes), which is the number this ticket exists to justify:
- naive in-degree-zero answer:  1660 "entry points" (64% of all callables)
- after the role map:           internal 914, framework-entry 1107, entry 384, orphan 169
- RESCUED from looking orphaned: 1107
- by role: test 982, fixture 44, property 42, route 23, dunder 11, handler 5
- classification cost: ~11 ms

So "possibly unused" falls from 1660 to 169 -- a 90% reduction in false dead-code signal, and a root set (1491) that is still large but now honestly split between 1107 evidence-backed roots and 384 unexplained ones. The map earns its place several times over.

Used the measurement to close a gap while I was in there: the run showed @app.delete, @app.patch and @app.middleware sitting on still-unexplained caller-less symbols, so the standard HTTP verbs were added to the defaults (route 19 -> 23). What remains unexplained is exactly what the extensibility is for: @effect (5) and @metric (4) are carnot's own, and @ctypes.WINFUNCTYPE (1) is a Windows callback -- all correctly left out of the defaults.

FINDING FOR A FOLLOW-UP, not fixed here: a visible share of the remaining 169 orphans are METHOD OVERRIDES of a third-party base class -- _Handler.do_GET / do_POST / log_message (BaseHTTPRequestHandler), _NoRedirect.redirect_request (urllib). The stdlib calls them; nothing in the project does. Neither a decorator nor a name convention marks these, so this map structurally cannot catch them; it needs class-hierarchy reasoning (the export does carry `bases`). Worth its own ticket -- I did not file one, since the right shape depends on how tic-d8a8 ends up presenting orphans.

SCOPE NOTE, deliberately deferred: the ticket asked for the map to live "somewhere a user can extend without a rebuild". What landed is the map as pure data in its own file plus every consumer taking `rules` as a parameter (defaulted, never hardcoded), so a project's own map can be supplied without touching this module. What did NOT land is the transport -- serving a roles.json through the outData plugin and loading it. Adding 'roles.json' to that plugin's SERVED list is genuinely one line and the middleware already 404s cleanly on a missing file, but a loader with no reader is dead code, so it belongs with the first consumer (tic-d8a8) rather than here. Flagging it rather than quietly narrowing the ticket.

Tests: 30 new (500 -> 530, 27 files) across roles.test.ts and entryPoints.test.ts -- decorator head extraction including multi-line arguments, matching with and without call arguments, dotted decorators, bare-final-segment aliasing (`from pytest import fixture`), a bare rule NOT matching a dotted decorator, unknown decorator falling through to in-degree logic, @staticmethod/@classmethod not rescuing, test-by-name-and-path (and the library `test_` helper that must not match), dunder vs private name, rule order as priority, an invalid regex in user data not throwing, each of the four roles, framework role surviving on an internal symbol, constructors not being nominated as entries via the tic-a8a6 implicit edge, and memoisation per (callGraph, rules). tsc -b clean, production build fine, no new dependencies.
