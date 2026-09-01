---
id: tic-ece1
title: Highlight the nodes at both ends of a lit connection (both modes)
status: open
type: feature
tier: medium
domain: ui
epic: viz-modes-next
priority: 13
tags:
- highlight
- selection
- canvas
assignee: null
depends_on: []
blocked_by: null
created: '2026-08-31T20:28:09'
updated: '2026-08-31T20:28:09'
closed: null
---

## Description
User request: in both modes, when a node is highlighted and its connection lines light up, highlight the connected nodes too, using the same brighter-grey border the hover state already uses (THEME.hovered in web/src/canvas/theme.ts).

The lit-edge half already exists (tic-5393): web/src/canvas/Workspace.tsx memoises highlightIds from the hover plus the selection via importEdgesIncidentTo (web/src/canvas/scene.ts, ~line 358). This ticket adds the far-end node half.

WORK
1. web/src/canvas/scene.ts: new pure helper, e.g. endpointNodesOf(scene, edgeIds): Set<string> -- every from/to of the named edges, plus each endpoints container ancestors walked through SceneNode.parent (so an import line anchored to a row inside an expanded container also lights the container it lives in; SceneNode.parent is already populated during assemble, see modes/types.ts assemble()). Pure and unit-tested next to importEdgesIncidentTo in canvas/scene.test.ts.
2. web/src/canvas/Workspace.tsx: memoise connectedIds from highlightIds (keyed on the same scene + highlightIds inputs the existing memos use, so a pan or zoom still pays nothing), and return the shared stable empty set when nothing is lit -- mirror the NO_HIGHLIGHT constant so the idle scene keeps re-rendering for free.
3. Pass a connected boolean prop down to NodeChip and extend its stroke precedence to: selected -> THEME.selected, else hovered -> THEME.hovered, else connected -> THEME.hovered, else node.stroke. NodeChip is memoised, so one more scalar prop is cheap; do not widen it to an object.
4. The node under the pointer must not be counted as its own neighbour in a way that changes its appearance -- hovered already wins in the precedence above, so no special casing should be needed, but confirm.

Verification: cd web && npm run test (new scene helper tests: both endpoints returned, ancestors included, edges with missing from/to ignored, empty in = empty out). npm run build. npm run dev and check BOTH modes: in Files and symbols, hovering a file lights its import lines and gives the files at the far end the grey border; in Import graph the same. Confirm a cyclic node (THEME.cycle pink, tic-56b2) still shows its own colour when it is neither hovered nor connected, and that clearing the hover clears every borrowed border.

## Notes
