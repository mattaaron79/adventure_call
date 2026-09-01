---
id: tic-d8a8
title: 'Mode 3: call flow -- the unfocused entry-point overview'
status: closed
type: feature
tier: high
domain: ui
epic: call-flow
priority: 5
tags:
- mode
- call-flow
- elk
assignee: claude.opus.001
depends_on:
- tic-a8a6
- tic-22db
- tic-1ecc
blocked_by: null
created: '2026-09-01T07:24:08'
updated: '2026-09-01T12:34:03'
closed: '2026-09-01T12:28:47'
---

## Description
The third VizMode, registered alongside fsTreeMode and importGraphMode. This ticket delivers its UNFOCUSED state; tic-7a5e adds the rooted local view.

Decided with the user 2026-09-01: the mode is rooted on a function by default, but a purely rooted mode has a discovery problem -- you can only use it if you already know which function to ask about. So `focusPath === ''` is the mode's index: the entry points from tic-22db laid out as the top layer of tic-a8a6's condensed DAG, one or two levels deep. That doubles as an architecture overview -- "here are the N ways execution enters this codebase, and what each one immediately reaches".

Nodes are callables (kind function|method), identified by the symbol_id the export already provides -- which is already the qualified `module.class.function` path, so identity and lexical distance come for free with no new data. Classes stay containers, not nodes. A cyclic component from tic-a8a6 draws as ONE node badged with its size; a self-recursive function draws as itself with a recursion badge. That is what makes the picture 2D at all.

Two synthetic node kinds beyond the callables, both deliberate: external sinks (aggregate one node per external module -- "this reaches out to json / subprocess" is flow worth seeing, and today it is thrown away into unresolved_calls), and dynamic holes (a computed callee is NOT a node; it is a badge on the caller saying flow leaves the map here -- 902 of them in ../carnot, and drawing an honest hole beats drawing nothing).

Follow importGraph's async layout path: the graph is not a tree, so layout goes through elk layered in a worker via layoutGraph, reconciled with the synchronous VizMode.layout signature by modes/asyncLayout.ts. Reuse fileDetail.ts for expanded containers rather than reimplementing rows.

Do NOT attempt the whole 2500-node call graph at once -- it is a hairball and elk will not save it. If the entry-point overview at depth 2 is still too big on ../carnot, cap it and say so in the UI; record the actual node counts in the notes.

Verification: browser-verify against ../carnot -- entry points visible and labelled by role, a real recursive cluster rendering as a single badged node, external sinks distinguishable. npm run test, tsc -b, production build.

## Notes
- 2026-09-01T12:28:47 claude.opus.001: Implemented against the CURRENT ./out export, which is now ../hypermenu (a Django project, 59 files) rather than the ../carnot every earlier ticket in this epic was measured on. Numbers below are hypermenu unless said otherwise.

New web/src/modes/callFlow.ts, registered in the registry as the third mode. Stands entirely on tic-a8a6's condensed DAG, tic-22db's entry points and tic-1ecc's metrics -- it derives no graph facts of its own, only selects, sizes, lays out and styles them. Async elk layout via the same cache-and-notify pattern importGraph uses (asyncLayout.ts), single-slot cache, no new infrastructure.

SIZE, which the ticket flagged as the real risk, is handled by ranking rather than by capping arbitrarily. Entries are ordered by `reachDown` -- what sets the most in motion is the useful ordering for an overview -- and the top `entryLimit` seed a breadth-first frontier `depth` levels deep. Measured: default params (depth 1, limit 40) give 94 nodes / 234 edges on hypermenu; depth 2 limit 40 gives 125/281; depth 2 limit 20 gives 98/205. All comfortably drawable. The ticket's worry was justified though: the unranked answer would have been 290 entries expanding to 420 nodes at depth 1 here, and on carnot 1491 entries expanding to 2286 at depth 2 -- very nearly the whole graph. The scene carries a `{shown, total}` summary so the count left out can be stated rather than implied.

The frontier walks in COMPONENT space, not symbol space, so a mutual-recursion knot costs one hop rather than one per member -- otherwise a knot would eat the whole depth budget going nowhere. A cyclic component draws as one node labelled "N functions (cycle)" with a null symbolId (it is not one symbol); a self-recursive function draws as itself with a `recursive` sublabel.

A LABELLING PROBLEM WORTH RECORDING, caught by looking at real output rather than by a test. First run drew two adjacent nodes both labelled `menu_items` -- different functions, from `views` and `views_v1`. A picture whose nodes cannot be told apart is worse than no picture. Fixed by using what the symbol id already holds (tic-a8a6's point that identity comes for free): a method carries its class (`K.run`), and the sublabel leads with the owning module's last segment, so the two now read `views · reaches 61` and `views_v1 · reaches 54`.

EXTERNAL SINKS, per the ticket. Needed a new derivation, since calls out of the codebase exist only as `unresolved_calls` reasons: `deriveExternalCalls(registry, index)` in derive.ts, hung off `Workspace.externalCalls` and empty until the registry lands, exactly like `externalImports`. Aggregated to the ROOT module (django, json, pathlib) rather than the dotted target -- measured, that is 38 sink nodes instead of several hundred, and at root granularity it reads as "what this codebase depends on" rather than as a wall. Only modules something in the CURRENT frontier calls are drawn, so the sinks describe this picture rather than the whole project. On the default view: 8 sinks, django with 132 calls out.

A REAL BUG THE MODE FOUND IN tic-22db. A self-recursive function is its own caller in the graph, so `callers.has(id)` was true for it and the entry-point classifier called it `internal` -- meaning "something in the project calls this", which is false, and which hid it from the entry set entirely. I only noticed because the mode would not draw one. Fixed in entryPoints.ts: a self-edge is not a caller, and symmetrically calling only yourself is not "calls things", so a function that only ever calls itself is now an `orphan` rather than an `entry`. Three new tests there. Affects real data -- 1 such function in hypermenu, 11 in carnot.

DELIBERATELY DEFERRED, and flagged rather than quietly dropped: the ticket's dynamic-hole badge (a computed callee means flow leaves the map). It needs per-caller unresolved counts, which is exactly tic-1ecc's `coverage`, which needs the registry -- and rendering "how much of this is missing" is precisely what tic-171f exists for. Putting a half version here would mean two places deciding how to say the same thing. The data is ready for it: `deriveCallMetrics` already takes the registry and returns coverage per callable.

Also deferred by design: a focus path is currently ignored (the overview is drawn whatever it says), which honours the tic-e738 contract -- an unresolvable focus draws everything rather than nothing -- and is what tic-7a5e replaces.

FINDING WORTH ITS OWN TICKET, filed as tic-f9f7. The role map does badly on Django: of 290 caller-less callables here, 251 are `(unexplained)` and the `test` role matched ZERO, because Django puts tests in `tests.py` rather than `tests/` or `test_*.py`, and because Django views are entry points via urls.py routing with no decorator and no naming convention at all. tic-22db's separation of `framework-entry` (evidence-backed) from `entry` (absence of evidence) means this degrades honestly rather than silently, which is the design working -- but the rules edit for (1) and (2) is cheap and worth doing.

Tests: 39 new (584 -> 623, 29 files) across callFlow.test.ts and entryPoints.test.ts -- registration through the registry, component labelling including the method-class and cycle cases, the frontier's component-space stepping and cycle termination, entry ranking (order, uniqueness, determinism), the cycle-as-one-node and self-recursion cases, orphans left out, depth honoured, the summary counts, external sink aggregation and scoping and the toggle, elk input well-formedness, styling coverage, and -- the shape that crashed elk in tic-56b2 -- that no edge ever names a node outside the scene, checked across four param combinations. tsc -b clean, production build fine, no new dependencies.

NOT BROWSER-VERIFIED: no Playwright in this environment. What wants a human eye is listed in my handover message rather than repeated here.

- 2026-09-01T12:34:03 claude.opus.001: Follow-up after the user restored the ../carnot export: verified the mode against it (it had only ever been run against the smaller Django project), and fixed a design problem the bigger codebase exposed.

VERIFIED ON CARNOT: 2574 call nodes, 830 external call pairs, deriveWorkspace 26ms, select ~2ms after the first call. No dangling edges, no two nodes sharing a label+sublabel. The cycle machinery finally has something to draw here -- one "2 functions (cycle)" node, which is the src.carnot.audit._Scan._block/._statement mutual recursion hand-verified back in tic-a8a6.

THE PROBLEM THE BIG CODEBASE EXPOSED: ranking entries by blast radius made this a TEST overview, not an architecture overview. 9 of the top 12 entries by reachDown were tests, because a test drives a deeper path through the system than almost anything else, and 982 of carnot's 1491 entry points are tests at all. The mode answered a different question than the one the ticket set it. Not visible on hypermenu, where the role map matches no tests at all (tic-f9f7).

Fixed with an `includeTests` param, default OFF, and the default matters more than the param. Then a second correction on top: filtering by the `test` ROLE was not enough, because that rule is name-based (`^test_`) and misses the helpers a test module defines around its tests -- carnot's top ranks were a dozen different nested functions all called `go`, none matched by the role, all plainly test surface. The filter is now by FILE (roles.isTestPath), which is the question actually being asked.

The difference is the whole value of the mode. Before: `go · test_tui`, `go · test_tool_running`, `main · playground`, four more `go`s. After: main (playground), ws_endpoint (app, route), create_session (app, route), CarnotApp.action_modal_nav / on_key / on_click (tui), Promote.run, new_agent (loop), CarnotApp.handle_submit (tui, handler), session (testing, fixture). That reads as "how does execution enter this codebase", which is what the ticket asked for.

`CallFlowSummary` gained `hiddenTests` alongside `shown`/`total`, so a filter that removes two thirds of the roots cannot do it silently -- same principle as reporting shown-of-total in the first place.

Sizes with the filter on (real entries reach further than test helpers, so the picture grew): depth 1 limit 25 -> 168 nodes / 283 edges; limit 40 -> 239/428; depth 2 limit 40 -> 415/775; depth 3 -> 507/968. Default entryLimit lowered 40 -> 25 on the strength of those numbers.

4 more tests (623 -> 627): tests excluded by default, the filter working by file rather than by name, hiddenTests reported, and includeTests restoring them. tsc -b clean, build fine.
