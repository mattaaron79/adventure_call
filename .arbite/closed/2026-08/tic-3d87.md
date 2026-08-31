---
id: tic-3d87
title: Sibling wrapping for the fs-tree mode (pack wide sibling lines into blocks)
status: closed
type: feature
tier: high
domain: ui
epic: viz-modes-next
priority: 7
tags:
- layout
- wrap
- sibling-block
- mode-params
- orientation
assignee: deepseek.v4-flash.001
depends_on: []
blocked_by: null
created: '2026-08-31T07:24:13'
updated: '2026-08-31T08:45:38'
closed: '2026-08-31T08:45:38'
---

## Description
Follow-up to tic-0419 (closed). Vertical trees get very wide and horizontal trees very tall when a directory holds many children (e.g. 191 files). Add an optional wrap: 0 or 1 means no wrapping (today's single-line sibling layout, unchanged); N >= 2 packs a node's children into N lines along the tier axis -- N columns in lr orientation, N rows in tb -- so a wide sibling row becomes a compact block. Wrap lines must clear the tier extent of the preceding line's subtrees so descendants never overlap the next line. Expose it as a numeric mode param (default 0) with a control in the left-pane ModePicker; it rides along in saved presets via the existing params capture.

## Notes
- 2026-08-31T07:27:52 deepseek.v4-flash.001: Implemented. layoutTree now takes wrap: 0/1 = the historical single-line layout (byte-identical output, all existing golden tests unchanged); N>=2 packs each node's children into N lines along the tier axis - N columns in lr, N rows in tb - via a per-node wrapOffset added to the global tier band, each line sized to clear the tier extent of the subtrees before it so wrapped siblings' descendants never overlap the next line. Exposed as the fs-tree 'wrap' numeric mode param (default 0) with a 'Sibling wrap' number input (0-8) in the left-pane ModePicker, via a new ParamNumber control type on VizMode; rides along in saved presets. 310 tests pass (7 new: 4 tidyTree wrap layout, 3 fsTree wiring), tsc clean.

- 2026-08-31T07:50:33 system: Reopened.

- 2026-08-31T07:53:47 deepseek.v4-flash.001: Reworked per user feedback so wrap now actually compacts the block. The first implementation stacked ALL of a node's children along the stack axis in order and only offset the wrapped lines along the tier axis, so the block kept its full single-line depth (same height, just wider) and the second column looked like it continued the stack. Now each wrap line stacks its children from the SAME stack base: the block's stack extent is its widest line, not the sum, so N columns (lr) / N rows (tb) sit side by side, top-aligned, and the block is roughly 1/N deep. Each child keeps its own elbow connector (per user choice). No-wrap output stays byte-identical (all existing golden tests unchanged). Added a compaction regression test; 311 tests pass, tsc clean.

- 2026-08-31T08:10:20 deepseek.v4-flash.001: Second round of user feedback addressed. (1) Connector routing: elbowConnectors now groups a node's direct children into tier lines and routes each line's elbow pipe in the gap before that line (a uniform tierGap/2 entry), so a later column's vertical pipe sits on the other side of the earlier column instead of slicing through it; single-line (non-wrapped) output keeps the historical midpoint pipe, so all existing golden tests are unchanged. (2) Cell overlap: replaced the relative tierExtent wrap offset with reachOf (the absolute deepest tier point of a subtree over the real tier bands), so each wrapped line clears the actual descendants of the prior lines - this fixes a real overlap where a wrapped second-row child landed on top of a first-row expanded descendant. Added a property test asserting no two node cells overlap across lr/tb and wrap 0/2/3 with chips, a 520-wide subtree and a 400-tall container. 313 tests pass, tsc clean.

- 2026-08-31T08:36:17 system: Reopened.

- 2026-08-31T08:38:54 deepseek.v4-flash.001: Drag re-route fixed. The canvas reproject (tic-1d7c) re-routes an edge when an endpoint is dragged, but it used the plain midpoint elbow, so the first drag reverted a wrapped connector to the old through-the-first-column pipe. Now the wrap-aware pipe and the layout orientation ride along on every SceneEdge: elbowConnectors tags wrapped edges with their pipe, the fs-tree layout collects them into Positioned.edgePipes + orientation, assemble attaches them to the scene edges, and reproject routes with elbow(from, to, edge.orientation ?? 'lr', edge.pipe). Non-wrapped edges carry no pipe, so the committed golden snapshot is unchanged. Added a reproject test asserting a wrapped edge keeps its gap pipe after a drag. 314 tests pass, tsc clean.

- 2026-08-31T08:43:38 system: Reopened.

- 2026-08-31T08:45:35 deepseek.v4-flash.001: Elbow pipe is now relative, not absolute. Previously the wrapped pipe was stored as an absolute world coordinate on each edge, so after a drag the pipe stayed in the old spot instead of following the object (and reproject reused the stale value). Now the pipe is a fixed offset from the child's leading edge ({dx} in lr, {dy} in tb, = tierGap/2), stored on the edge as relative, and re-derived from the child's current rect at every route: elbowConnectors derives it from the laid-out rect, and canvas reproject derives it from the placed rect on each drag (edge.orientation routes in the right axis). Paths are always derived on change. Accepted tradeoff: an individually dragged child carries its pipe with it. Updated the reproject test to assert the pipe follows a dragged child (still tierGap/2 before its left edge). 314 tests pass, tsc clean.
