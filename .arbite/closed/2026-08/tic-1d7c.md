---
id: tic-1d7c
title: 'Fix: edges and group boxes must follow dragged nodes'
status: closed
type: bug
tier: high
domain: ui
epic: viz-workspace
priority: 1
tags:
- canvas
- konva
- drag
- edges
- scene
assignee: orchestrator
depends_on: []
blocked_by: null
created: '2026-08-30T18:45:17'
updated: '2026-08-30T19:00:25'
closed: '2026-08-30T19:00:25'
---

## Description
Dragging a node moves the chip but nothing else: nesting/import lines keep their original polylines and directory group boxes keep their original bounds. Blocks meaningful feedback on edge routing, so this goes first.

ROOT CAUSE
Position overrides are applied at render time only to nodes -- Workspace.tsx reads overrides[node.id] and placedRect() (src/canvas/scene.ts). SceneEdge carries a baked 'points: number[]' and SceneGroup a baked rect, both computed once by the mode's layout phase. Nothing re-derives them when an override changes. Separately, multi-select drag moves the other chips imperatively via konvaNodes (onDragMove in Workspace.tsx) and the edge layer is never redrawn mid-drag.

WORK
1. src/canvas/scene.ts -- give the scene enough structure to re-route:
   - SceneEdge keeps its endpoint anchors (from/to element ids) alongside points. SpecEdge already has from/to (src/modes/types.ts); the assembly step currently drops them -- carry them through.
   - SceneGroup keeps the member ids it wraps so its bounds can be recomputed.
   - Add a pure reproject(scene, overrides) -> Scene that re-routes edge polylines and recomputes group rects from the current placed rects. Keep the elbow routing itself in src/layout (do not duplicate it in the canvas).
2. src/canvas/Workspace.tsx -- apply reproject before culling so a committed drag updates lines and boxes. During an active drag, redraw the edge and group layers from the live imperative positions each frame (batchDraw on those two layers from onDragMove; do NOT route per-frame positions through the zustand store -- that would re-render the whole scene on every pointer move, which the current design deliberately avoids).
3. Keep the edge and group layers listening={false}; only the node layer hit-tests.

NOT IN SCOPE: whether the anchor points are on the right side of a chip. The user has said the routing may well be wrong today and will give better feedback once things update live. Do not retune anchor placement here.

EXIT: dragging one node, and dragging a multi-selection, updates connected lines and the enclosing group boxes live during the drag and after it commits; pan/zoom framerate is unchanged with the full tree expanded.

## Notes
- 2026-08-30T19:00:18 orchestrator: Added pure reproject(scene, overrides) in web/src/canvas/scene.ts: re-routes edge polylines (elbow via layout/tidyTree.elbow, center-to-center for imports) and recomputes group boxes from placed member rects. SceneEdge now carries from/to/route and SceneGroup carries members; the mode pipeline (modes/types.ts assemble, fsTree.ts select) carries them through. Workspace.tsx applies reproject before culling for committed drags and imperatively re-routes edges/group boxes + batchDraws the two layers from onDragMove (multi-select included), keeping per-frame positions out of the store. 6 new unit tests; 151/151 pass, tsc -b clean.
