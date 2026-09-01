---
id: tic-f1d7
title: 'Hover an import line: near-pointer connection summary popup'
status: closed
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
assignee: claude.opus.001
depends_on:
- tic-ece1
blocked_by: null
created: '2026-08-31T20:29:37'
updated: '2026-09-01T06:37:49'
closed: '2026-09-01T06:37:49'
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
- 2026-09-01T06:35:38 claude.opus.001: Implemented as specified. Pure layer in canvas/scene.ts: distanceToPolyline(points, p) over the flat array (point-to-segment, clamped so a point past an end measures to that end, zero-length segment degenerates to the point), and edgesNearPoint(scene, at, radius, limit) with a cheap bounding-box reject in front of the per-segment maths. settings.ts gained EDGE_HOVER_RADIUS_PX = 32 (the world radius is that over viewport.scale, so the pick area is a constant size on screen at any zoom) and EDGE_POPUP_MAX_LINES = 8. Workspace.tsx: a Stage onPointerMove that records the pointer and runs at most one probe per requestAnimationFrame, gated on hovered === null, no drag session, no marquee, not panning -- re-checked INSIDE the frame, since a gesture can start between the move and the paint. Cleared on all of those, on pointerleave of the host (leaving the workspace) and of the Stage (leaving the canvas for the HUD floating over it), and on any viewport change, since a wheel zoom moves the world under a stationary pointer. Endpoint names come from describeConnections(), which lifts a row or section endpoint to the container it sits in but no further -- in the fs-tree a file chip's own parent IS its directory chip, so walking to the outermost ancestor would name every connection after the root folder -- and falls back to the endpoint id (a file path) when the node is culled out of the scene. The popup is an HTML overlay built like the icon tooltip, .edge-popup in styles.css beside .canvas-tooltip, one line per connection plus a '+N more' tail, flipping to the other side of the cursor near the right or bottom edge so it stays on screen without being measured first.

- 2026-09-01T06:35:51 claude.opus.001: Three deliberate departures from the WORK list, all small. (1) edgesNearPoint returns { edges, total } rather than a bare array: item 4 wants a '+N more' tail, and a list capped at the limit cannot say how many it is not showing. total is the count within the radius, edges is the capped, sorted prefix. (2) The query runs over IMPORT edges only, not every edge: 'a connection' already means kind === 'import' everywhere else on this canvas (tic-5393 selection highlighting, tic-ece1's endpoint lighting, the marching ants), and in the fs-tree a popup reading 'app -> errors.py' over a nesting elbow says nothing the picture is not already saying, while a folder's fan of them would crowd out the import lines the summary exists for. Filtered once per scene in a memo, not per probe. (3) Identical description lines are collapsed -- in the fs-tree several symbol rows of one file can import the same file, and repeating 'a.py -> b.py' four times adds nothing. '+N more' still counts CONNECTIONS not listed (total - edges.length), so it stays accurate even when dedup shortens the visible list. One performance addition the ticket did not ask for but its frame-rate requirement did: edge bounding boxes are memoised in a WeakMap keyed on the edge object. Computing a box walks every point of a polyline, and doing that for every edge on every probe was the whole cost -- measured 0.36 ms/probe at 235 edges and 4.13 ms at 5000 before, 0.19 ms and 0.54 ms after. Scene edges are immutable and stable across frames (culling filters, highlight ordering re-sorts, and after tic-556d reproject returns the same object for any edge a drag did not move), so a pointer sweep pays for the boxes once; weak, so a re-layout's dropped edges take their entries with them.

- 2026-09-01T06:36:04 claude.opus.001: Verified: cd web && npm run test 481 pass / 25 files (was 465); npm run build clean; the running dev server transforms every changed module. New coverage in scene.test.ts for distanceToPolyline (on-segment and on a corner, perpendicular beside a segment, past either end measuring to the end not the infinite line, the closest of several segments, a zero-length segment, a single point, an empty polyline) and edgesNearPoint (radius respected, sorted nearest first with the distances checked, limit honoured while total still reports the truth, empty scene, radius or limit of zero, and a point inside an L's bounding box but far from both runs -- proving the bbox is only the reject and not the answer), plus describeConnections (both ends by label, a row lifted to its file, a file NOT lifted to its directory, the culled-endpoint fallback). Also worth knowing: Konva fires the Stage's own pointermove only when no listening shape was hit (Stage.js _pointermove, the !triggeredOnShape branch), and suppresses pointer events entirely while a drag is in flight -- so the 'empty canvas only' condition is enforced by Konva as well as by the explicit gates, not instead of them. NOT verified by me: the on-screen behaviour -- I cannot drive a browser. The dev pass in the ticket's verification list is what remains: hovering a bundle in Import graph and in Files and symbols, the popup disappearing the instant a node is under the pointer, no stale popup after panning/dragging/marquee, and the frame rate while sweeping the full ~190-file graph. The synthetic timings above say the query is ~1% of a 16 ms frame at that size, but a real sweep is the real test. If 32 px turns out too grabby or too fussy, EDGE_HOVER_RADIUS_PX in web/src/settings.ts is the one-line adjustment.

- 2026-09-01T06:37:48 claude.opus.001: User confirmed in the running app, distance ordering included. Closing.
