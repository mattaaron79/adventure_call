---
id: tic-171f
title: 'Wear the call graph''s uncertainty: per-node and global resolution coverage'
status: open
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 6
tags:
- honesty
- coverage
- inspector
assignee: null
depends_on:
- tic-1ecc
- tic-d8a8
blocked_by: null
created: '2026-09-01T07:24:43'
updated: '2026-09-01T07:24:43'
closed: null
---

## Description
The most important ticket in the epic, and the easiest to skip.

Measured on the current ../carnot export: 3547 calls resolved, 732 heuristic, 7499 unresolved (2058 of them builtins). The call graph therefore sees roughly 39% of non-builtin call sites. A flow view that silently drops the majority of the edges is WORSE than no view, because it looks authoritative and a human will believe it.

So the mode wears its own uncertainty:
- Per node: "resolved 4 of 11 call sites" from tic-1ecc's `coverage` metric, visible on the node or its container, not buried in a tooltip.
- Per edge: heuristic-confidence edges render distinguishably from exact ones. The confidence is already on every edge in the export and is currently ignored by every mode.
- Per view: a dynamic-hole badge where computed callees mean flow leaves the map (902 sites in ../carnot).
- Globally: a coverage figure somewhere always visible while the mode is active.

Copy discipline: the mode must never say "this function calls X and nothing else". It can say "3 resolved calls, 8 unresolved". Nothing here should read as an apology or an error state either -- partial resolution is the normal condition of static analysis on a dynamic language, and the UI should present it as information, not as a fault.

Note that tic-9ff4 and tic-97ce both raise these numbers; this ticket must read them live from the export, never hardcode a figure from any point in time.

Verification: browser-verify against ../carnot that the numbers shown match the registry's unresolved_calls for the same symbols -- spot-check three functions by hand. npm run test, tsc -b.

## Notes
