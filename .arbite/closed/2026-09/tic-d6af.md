---
id: tic-d6af
title: A 'trace call flow' affordance on function and method rows
status: closed
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 6
tags:
- navigation
- filedetail
- affordance
assignee: z-ai.glm-5.3-flash.001
depends_on:
- tic-e738
- tic-7a5e
blocked_by: null
created: '2026-09-01T07:24:42'
updated: '2026-09-01T18:15:16'
closed: '2026-09-01T18:15:16'
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

- 2026-09-01T18:13:45 z-ai.glm-5.3-flash.001: Implemented. The affordance is declared once on the shared Row in fileDetail.ts: function and method member rows carry openIn -> { modeId: CALL_FLOW_MODE_ID, target: <symbol id>, icon: 'local-view', label: 'Trace call flow' } -- the same glyph and wording tic-7a5e's chips use, so one gesture looks like itself everywhere. Both fsTree and importGraph pass row.openIn through their row->spec mapping, so one change landed in both modes; no special-casing. The inspector got the jump too: traceCallFlowTarget(node) returns the symbol id for function/method selections and null otherwise, and a 'Trace call flow' button calls useWorkspace.getState().openInMode(CALL_FLOW_MODE_ID, target) -- the same call the canvas's open-in button makes, so excursion provenance and the tic-53f7 return trip come for free; no second return mechanism was built. Non-callable rows (class, attribute, variable, import) and non-callable selections get nothing. Tests: fsTree.test.ts +4, importGraph.test.ts +2, Inspector.test.ts +3. npm run test (754 pass) and tsc -b clean. Remaining from verification: browser-verify the trip from both container modes and the inspector, and the return trip landing back on the file.
