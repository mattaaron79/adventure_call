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
updated: '2026-09-01T07:27:15'
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
