---
id: tic-70f9
title: Sunburst / multi-level pie graphing mode for files & symbols
status: closed
type: feature
tier: high
domain: ui
epic: viz-workspace
priority: 5
tags:
- sunburst
- canvas
- modes
- fs-tree
- pie
assignee: deepseek-v4-flash.001
depends_on: []
blocked_by: null
created: '2026-09-02T15:15:55'
updated: '2026-09-02T15:29:10'
closed: '2026-09-02T15:29:10'
---

## Description
User request: write a graphing mode for Sunburst / Multi-level Pie and integrate it as an option for the 'File and Symbols' workspace (the default fs-tree mode, labeled 'Files & symbols').

## Notes
- 2026-09-02T15:29:06 deepseek-v4-flash.001: Implemented faithful sunburst mode for files & symbols. Added WedgeGeom to canvas/scene.ts (optional SceneNode.wedge; node rect stays the sector bounding box so culling/fit/marquee/goto still work) and plumbed it through modes/types.ts (Positioned.wedges -> assemble). Added a WedgeNode renderer in canvas/Workspace.tsx that draws an Arc for any node carrying wedge geometry (angles verified against Konva Arc source: rotation=start deg, angle=sweep deg, clockwise on screen), with centred labels when a slice is big enough and a 'go into' affordance on directory slices at their midpoint; pinned (not draggable). New mode in modes/sunburst.ts: directory->file hierarchy as concentric rings sized by a metric param ('symbols' default = symbol count per file floored at 1, or 'files' = one per file), dirs aggregate subtrees, rings bounded by maxDepth param, focused folder becomes the centre (focusPath scope), fs-tree id scheme (dir:<path>/path) so file sectors resolve in the inspector and the breadcrumb toolbar works. Registered as 'Sunburst' in registry.ts right after fs-tree, id in ids.ts. 16 new tests (sectorBounds geometry, arc tiling/partition arithmetic, metrics, aggregation, scoping, goto index, styling) in modes/sunburst.test.ts. Full suite 987 pass; tsc -b and vite build clean.
