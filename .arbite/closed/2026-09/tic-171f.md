---
id: tic-171f
title: 'Wear the call graph''s uncertainty: per-node and global resolution coverage'
status: closed
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 6
tags:
- honesty
- coverage
- inspector
assignee: zai.glm-5.3-flash.001
depends_on:
- tic-1ecc
- tic-d8a8
blocked_by: null
created: '2026-09-01T07:24:43'
updated: '2026-09-01T13:41:27'
closed: '2026-09-01T13:41:27'
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
- 2026-09-01T13:40:25 zai.glm-5.3-flash.001: Implemented per-node coverage, heuristic edge styling, dynamic-hole counts, and the global HUD; verified against the live out/ (carnot) export. Details in close note.

- 2026-09-01T13:41:22 zai.glm-5.3-flash.001: Implemented against the CURRENT ./out export (carnot, 182 files): stats now read 4201 exact + 725 heuristic + 6248 unresolved + 1888 builtin = 13062 sites = 38% resolved, 842 computed callees. Live-read from the export, never hardcoded.
