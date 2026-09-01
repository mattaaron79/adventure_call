---
id: tic-556d
title: 'Import graph: dragging a node flattens every import line'
status: closed
type: bug
tier: high
domain: ui
epic: viz-modes-next
priority: 15
tags:
- imports
- drag
- edges
- elk
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-01T06:02:54'
updated: '2026-09-01T06:09:09'
closed: '2026-09-01T06:09:09'
---

## Description
User report while reviewing tic-d7d7: moving any node in Import graph mode makes ALL import lines go 'direct' -- they throw away elk's routing and become straight centre-to-centre lines, not just the lines attached to the node that moved.

Cause: canvas/scene.ts reproject() re-derives EVERY edge on every call, and for a non-elbow ('center') route that means centerLine(from, to). The existing scene.test.ts case even claims 're-routes the edges incident to a dragged node, and only those' -- it passes today only because its unmoved fixture edge was already a centre-to-centre two-point line, so re-deriving it reproduced the same numbers. For elk polylines (real bends, border anchors, merged trunks) re-deriving is destructive.

Not required by anything: reproject is called for the live drag (Workspace onDragMove) and for the committed overrides, and both want the same thing -- lines that follow the nodes that moved and leave the rest of the picture alone.

## Notes
- 2026-09-01T06:08:58 claude.opus.001: Fixed in canvas/scene.ts reproject(). Three rules now, in order: (1) an edge whose BOTH endpoints sit exactly where the layout put them is returned untouched -- same object, same points; (2) an 'elbow' edge is re-elbowed as before, so the fs-tree's nesting lines and their wrapped pipes (tic-1d7c) behave identically; (3) any other edge has its two END points moved by their own nodes' deltas and every bend between them kept, via a new translateEnds(). So a dragged chip stretches its lines rather than having them redrawn, and elk's routing -- bends, border anchors, merged trunks -- survives everywhere else in the scene. centerLine() is gone: a two-point line comes out of translateEnds identical to what centre-to-centre re-derivation produced, since its ends were the centres. Junction dots are no longer dropped unconditionally: they now survive a reproject that moved nothing (e.g. one triggered by an unrelated override) and are dropped once any edge has actually been re-routed, since a travelled endpoint can leave a dot on a trunk that no longer parts there. Same code path serves the live drag (Workspace onDragMove) and the committed overrides, so what you see mid-drag is what you get on drop.

- 2026-09-01T06:09:09 claude.opus.001: One fixture had to be corrected to land this, and it is worth knowing why. scene.test.ts's CONTAINER scene baked its edge at [262,190,450,20] -- which is r2's centre AFTER the drag the test then performs, not the laid-out geometry. Under the old 'redraw every edge from its placed endpoints' rule the input points were never read, so the discrepancy was invisible; under the new rule the ends are moved relative to the layout, so a post-drag fixture got translated twice. Corrected to the pre-drag line [62,90,450,20]; the test's expectation is unchanged and now actually exercises the delta. Note also that the pre-existing case named 're-routes the edges incident to a dragged node, and only those' was passing for the wrong reason -- its unmoved edge was a centre-to-centre two-pointer, so re-deriving it reproduced the same numbers. It now holds for the reason it claims. New coverage in scene.test.ts ('reproject keeps the routing a drag did not touch'): an untouched routed polyline comes back as the same object, a dragged end moves while its bends stay put, an edge whose both ends move carries both, and the junction-dot rule. Verified: cd web && npm run test 465 pass / 25 files; npm run build clean.
