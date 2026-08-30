---
id: tic-e8c5
title: 'Workspace canvas primitives: dotted grid, pan/zoom, selection, drag, persistence'
status: open
type: feature
tier: medium
domain: ui
epic: viz-workspace
priority: 3
tags:
- frontend
- canvas
- konva
- viewport
assignee: null
depends_on:
- tic-ed52
blocked_by: null
created: '2026-08-30T11:53:59'
updated: '2026-08-30T11:53:59'
closed: null
---

## Description
The reusable workspace surface every mode renders into.

- src/canvas/Workspace.tsx: full-bleed Konva Stage, layers ordered grid -> groups -> edges -> nodes -> overlay. Edge layer listening={false}.
- src/canvas/Grid.tsx: dotted grid that re-tiles on pan and re-spaces on zoom. Draw one dot tile to an offscreen canvas and use it as a fill pattern -- never one Konva shape per dot.
- src/canvas/useViewport.ts: wheel zoom about the cursor, drag-to-pan on empty space, fit-to-content, clamped scale.
- Selection: click, shift-click, marquee. Hover highlight. Node drag with position override.
- src/state/store.ts (zustand) + src/state/persist.ts: viewport, per-mode position overrides, expand state -> localStorage keyed by mode id. 'Relayout' button clears overrides.

EXIT: pan/zoom/select/drag a placeholder scene at 60fps; viewport and overrides survive a reload.

## Notes
