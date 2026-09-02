---
id: tic-d6af
title: A 'trace call flow' affordance on function and method rows
status: open
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 6
tags:
- navigation
- filedetail
- affordance
assignee: null
depends_on:
- tic-e738
- tic-7a5e
blocked_by: null
created: '2026-09-01T07:24:42'
updated: '2026-09-01T17:47:35'
closed: null
---

## Description
How you arrive at the call-flow mode from the two views that already exist. Decided with the user 2026-09-01.

Rows in an expanded file container already carry a symbolId, are individually hit-testable, and already support framework-rendered affordances -- tic-d7d7 established that adding one is "an icon and a string rather than canvas code" (SpecNode.focusIcon / focusLabel). So this is: give function and method rows a target declared through tic-e738's cross-mode field, pointing at the call-flow mode rooted on that row's symbol.

The leverage is that fileDetail.ts is SHARED (tic-0680): both fs-tree and import-graph build their containers from it, so one change lands the affordance in both modes at once. Do not special-case either mode.

Only `function` and `method` rows get it. A class, a variable, an attribute or an import row has no call flow to trace, and an affordance that does nothing is worse than none.

Also add the same jump to the inspector, where it is cheapest of all: the inspector already holds the selected symbol and already renders goto and source-link buttons, so a "trace call flow" button there works from ANY selection in ANY mode, including selections whose element carries no affordance.

Verification: browser-verify the trip from both fs-tree and import-graph, and from the inspector; verify non-callable rows show no affordance; verify the return trip (tic-e738's reverse direction) lands back on the file. npm run test, tsc -b.

## Notes
- 2026-09-01T17:47:35 claude.opus.001: The return trip this ticket's verification asks for now exists (tic-53f7): openInMode records where a jump started, and the breadcrumb toolbar draws a '<- <origin mode>' button that restores the origin mode AND its focus in one transition. So a row's 'trace call flow' jump gets the way back for free -- do not build a second one, and do not special-case it.

Two things to know while building:
* Excursion provenance is recorded ONLY when openInMode actually switches mode. A row jumping to call flow while call flow is already active is a re-focus, not an excursion, and correctly offers no return.
* It is one level deep and replaces on each jump, so fs-tree -> call flow -> (a chip re-roots) keeps 'back to Files & symbols' the whole way, because re-rooting is setFocusPath rather than a jump.

Also note tic-7a5e already gives every call-flow chip a focusTo affordance ('Trace call flow'), so the inspector button this ticket wants is the remaining gap for selections whose element carries no affordance.
