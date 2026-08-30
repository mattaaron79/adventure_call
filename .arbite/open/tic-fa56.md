---
id: tic-fa56
title: 'Perf pass: viewport culling, zoom LOD, konva tuning, keyboard shortcuts'
status: open
type: chore
tier: medium
domain: ui
epic: viz-workspace
priority: 7
tags:
- frontend
- perf
- ux
assignee: null
depends_on:
- tic-1faf
blocked_by: null
created: '2026-08-30T11:54:37'
updated: '2026-08-30T11:54:37'
closed: null
---

## Description
Make the workspace stay smooth with everything expanded (~2500 rendered items).

- Viewport culling inside select(): only emit scene items intersecting the visible rect (plus margin).
- Zoom-threshold LOD: drop sub-item text below a scale, drop labels entirely when zoomed far out, collapse expanded containers to a summary block at extreme zoom-out.
- Konva tuning: perfectDrawEnabled(false), shadowForStrokeEnabled(false), cache static groups, batch draws.
- Keyboard: f = fit to content, e = expand/collapse selection, Esc = deselect, / = focus search.

EXIT: smooth pan/zoom with every file expanded.

## Notes
