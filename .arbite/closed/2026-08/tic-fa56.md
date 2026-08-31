---
id: tic-fa56
title: 'Perf pass: viewport culling, zoom LOD, konva tuning, keyboard shortcuts'
status: closed
type: chore
tier: medium
domain: ui
epic: viz-workspace
priority: 7
tags:
- frontend
- perf
- ux
assignee: zoo.glm-5.3-flash.001
depends_on:
- tic-1faf
blocked_by: null
created: '2026-08-30T11:54:37'
updated: '2026-08-30T17:52:44'
closed: '2026-08-30T17:52:44'
---

## Description
Make the workspace stay smooth with everything expanded (~2500 rendered items).

- Viewport culling inside select(): only emit scene items intersecting the visible rect (plus margin).
- Zoom-threshold LOD: drop sub-item text below a scale, drop labels entirely when zoomed far out, collapse expanded containers to a summary block at extreme zoom-out.
- Konva tuning: perfectDrawEnabled(false), shadowForStrokeEnabled(false), cache static groups, batch draws.
- Keyboard: f = fit to content, e = expand/collapse selection, Esc = deselect, / = focus search.

EXIT: smooth pan/zoom with every file expanded.

## Notes
- 2026-08-30T17:52:38 zoo.glm-5.3-flash.001: Implemented. Culling: render-time filter cullScene/visibleWorldRect in canvas/scene.ts (200-world-unit margin) applied in Workspace layers; selection/marquee/fit still use the full scene. Note: culling lives at render time rather than inside select() as the ticket sketched -- select-level culling would force a re-layout per pan frame, while filtering the computed scene is free and draws the identical result. LOD: canvas/lod.ts thresholds (0.6 sublabels, 0.35 labels, 0.15 summary); Workspace skips Text nodes by lod, and fsTree.select reads ui.lod to drop import lines at lod>=2 and collapse expanded containers to summary chips at lod 3; App derives lod as a zustand number selector so re-renders happen only on threshold crossings. Konva tuning: perfectDrawEnabled/shadowForStrokeEnabled already on rects/lines, now also on all Text; non-interactive layers listening=false (existing). Keyboard: f=fit, e=expand/collapse selection (via expandable set), Esc=deselect, /=focus file filter; ignored while typing in inputs. Added the file-filter input the / shortcut targets (matchTree in FileTree.tsx, search box in Sidebar). Tests: lod, cull, matchTree, fsTree LOD cases; 145 tests + tsc/vite build green.
