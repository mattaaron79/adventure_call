---
id: tic-f1d7
title: 'Hover an import line: near-pointer connection summary popup'
status: open
type: feature
tier: high
domain: ui
epic: viz-modes-next
priority: 17
tags:
- canvas
- hover
- edges
- tooltip
assignee: null
depends_on:
- tic-ece1
blocked_by: null
created: '2026-08-31T20:29:37'
updated: '2026-08-31T20:29:37'
closed: null
---

## Description
User request (filed as "see if this is possible"): when highlighting a connecting line -- but NOT when a node is also under the pointer -- show a small popup summary of the connections beneath the cursor. The pick radius is in screen pixels; start at 32px and tune from there. Confirmed with the user 2026-08-31: this works in both modes, since the implementation is mode-agnostic scene geometry.

It is possible. The edge layer is listening={false} on purpose (hit-testing thousands of edges per pointer move is the most expensive thing on the canvas, see the module docstring in web/src/canvas/Workspace.tsx), so this must NOT be done by making edges hit targets. Do it as a pointer-position proximity query against the already-culled visible edge polylines.

WORK
1. web/src/canvas/scene.ts, pure and unit-tested: distanceToPolyline(points, p) (point-to-segment distance over a flat [x0,y0,x1,y1,...] array) and edgesNearPoint(scene, worldPoint, worldRadius, limit) returning the nearest edges sorted by distance, capped at limit.
2. web/src/settings.ts: EDGE_HOVER_RADIUS_PX = 32, documented like the other tunables in that file (it is the users starting figure and is meant to be a one-line adjustment). The world radius is EDGE_HOVER_RADIUS_PX / viewport.scale, so the pick area stays a constant size on screen at any zoom.
3. web/src/canvas/Workspace.tsx: a stage pointer-move handler, throttled to one requestAnimationFrame, that runs ONLY when there is no node under the pointer (store hovered === null -- the users explicit condition), no drag session in flight, no marquee, and not panning. Query against the culled visible scene the render already computes, never the full scene. Clear the popup as soon as any of those conditions stops holding or the pointer leaves the workspace.
4. The popup itself: an HTML overlay near the cursor, built the same way the existing icon tooltip is (iconTooltip state + client-to-host coordinate conversion in the same component; .canvas-tooltip in web/src/styles.css is the model). Add a sibling .edge-popup class -- multi-line, left-aligned, pointer-events: none, same surface/border/shadow language. One line per connection reading importer -> imported, capped at about 8 with a "+N more" tail so a dense trunk cannot paper over the canvas.
5. Endpoint labels come from the scene nodes: look up the edges from/to ids, and when an endpoint is a row inside an expanded container walk SceneNode.parent up to the file container so the line names files, not row text.

Watch the interaction with tic-ece1 (connected-node highlighting) and tic-531b (merged lines): over a merged trunk the query will legitimately return many edges at nearly the same distance -- that is exactly the case where this popup earns its keep, so make sure the cap and the ordering read sensibly there.

Verification: cd web && npm run test -- distanceToPolyline (on-segment, past-the-end, multi-segment, degenerate zero-length) and edgesNearPoint (radius respected, sorted by distance, limit honoured, empty scene). npm run build. npm run dev: in Import graph, hover empty canvas over a bundle of lines and confirm the summary appears and updates as the pointer moves, that it disappears the instant the pointer is over a node, and that panning/dragging/marquee never leave a stale popup behind. Repeat in Files and symbols over its import lines. Check the frame rate stays smooth on the full ~190-file graph while sweeping the pointer around.

## Notes
