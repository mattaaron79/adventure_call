---
id: tic-e8c5
title: 'Workspace canvas primitives: dotted grid, pan/zoom, selection, drag, persistence'
status: closed
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
assignee: claude.opus
depends_on:
- tic-ed52
blocked_by: null
created: '2026-08-30T11:53:59'
updated: '2026-08-30T13:22:14'
closed: '2026-08-30T13:22:14'
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
- 2026-08-30T13:22:03 claude.opus: Done. Layers grid -> groups -> edges -> nodes -> overlay; only the node layer listens (grid, groups and edges are listening=false so empty-space drag reaches the stage). Camera transform is applied to the three world layers rather than the Stage, which keeps the grid and the rubber band in screen space. Grid is ONE screen-space Rect with a baked dot-tile fill pattern: pan moves the pattern phase, zoom re-bakes the tile at the new spacing on a 1-2-5 ladder so dots stay a constant size on screen. Gestures: wheel = zoom about the cursor, drag on empty = pan, shift+drag = additive marquee (plain drag had to be pan per the spec), middle-drag = pan, click empty = deselect; press-to-select so a drag on an unselected node picks it up, and a multi-selection drags together (the non-anchor nodes move imperatively during dragmove, committed to the store on dragend). DEVIATIONS: (1) the maths is split into pure modules -- canvas/viewport.ts, canvas/gridMetrics.ts, canvas/scene.ts -- so it is unit-testable under the node environment; useViewport.ts is now just the React/Konva wiring. (2) gridMetrics.ts, not grid.ts: Grid.tsx and grid.ts differ only in case and Windows folds them together (tsc TS1261). (3) Added canvas/scene.ts, the flat positioned Scene spec (groups/edges/nodes, ids stable across re-layout) -- this is the seam tic-cdeb and tic-1faf produce and tic-83ec formalises -- plus canvas/placeholderScene.ts, a throwaway shelf-packer over the real export so the EXIT criterion is exercised at true scale. (4) Fit and Relayout live in a HUD toolbar on the canvas rather than the sidebar. (5) canvas/StageHost.tsx deleted, superseded. (6) No keyboard shortcuts -- tic-fa56 owns those. VERIFIED: 87 vitest tests green (8 files); tsc -b and vite build clean. Driven in headless chromium against a live dev server: 5 layers; first load frames the scene (37%) and a saved camera is restored instead; wheel zoom 37% -> 351% anchored at the cursor; drag-pan; click = 1 selected, shift-click = 2, shift-click again = 1, click empty = 0; shift-marquee selected a directory box; hover flips the cursor to pointer; dragging a 2-selection wrote both overrides with the same delta; viewport AND overrides identical across a reload; Relayout emptied the overrides and disabled itself; Fit returned to 37%; zoom-out clamps at 2% with the grid re-spaced, not gone; no console errors or failed requests. Frame times during a 90-step pan drag over 151 nodes / 196 edges: median 6.9ms, p95 7.2ms, max 14.0ms.
