---
id: tic-ece1
title: Highlight the nodes at both ends of a lit connection (both modes)
status: closed
type: feature
tier: medium
domain: ui
epic: viz-modes-next
priority: 13
tags:
- highlight
- selection
- canvas
assignee: claude.opus.002
depends_on: []
blocked_by: null
created: '2026-08-31T20:28:09'
updated: '2026-08-31T20:49:43'
closed: '2026-08-31T20:49:43'
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
- 2026-08-31T20:49:43 claude.opus.002: Implemented the node half of the lit-connection highlight (tic-ece1), completing what tic-5393 started on the lines. New pure helper in canvas/scene.ts, endpointNodesOf(scene, edgeIds) -> Set<nodeId>, sitting directly after importEdgesIncidentTo: it collects every from/to of the named edges and then walks each endpoint up through SceneNode.parent, so an import line anchored to a row inside an expanded container also lights the container and the directory chip the row lives in. The parent map is built only when edgeIds is non-empty, and the ancestor walk's hit.has() guard doubles as both a de-duplicator and a termination condition, so a malformed parent cycle cannot hang a render (pinned by a test). Edges with no from/to, and ids naming no edge in the scene, contribute nothing. Workspace.tsx memoises connectedIds off [scene, highlightIds] -- deliberately derived from the already-computed lit-edge set rather than from hover/selection directly, so there is exactly one notion of incidence and it follows the mode's expand-state anchors for free -- and returns the shared NO_HIGHLIGHT reference when nothing is lit. I reused that one constant for both sets rather than adding a parallel empty set: two distinct empty sets would render identically but would each need their own stable identity, and one shared reference keeps the idle scene and every pan/zoom frame re-rendering for free, which is the property Workspace's whole memo layering exists to protect. NodeChip takes one extra scalar prop (connected: boolean), not a set or object, so the memo still bails out. Stroke precedence resolved as selected -> THEME.selected, else hovered -> THEME.hovered, else connected -> THEME.hovered, else node.stroke. Confirmed point 4 needs no special casing: the hovered node IS among its own edges' endpoints, but hovered outranks connected and both paint the same grey, so it cannot change appearance from being its own neighbour. The branches are written out separately rather than collapsed to (hovered || connected) so the precedence stays legible if the two colours ever diverge. Consequence worth recording: a cyclic file (THEME.cycle pink, tic-56b2) reads its pink from node.stroke, the last branch, so it keeps its colour while idle and while merely selected-adjacent-to-nothing, but a cyclic node at the far end of a lit line shows the borrowed grey instead of pink for as long as the hover lasts -- that is the precedence the ticket specified, and the pink returns the instant the hover clears. Deliberately NOT done: no change to strokeWidth (connected stays 1px, only selection gets 2px, so a borrowed border never reads as a selection); no new THEME colour; no per-mode code -- Workspace consumes ModeOutput.scene, and I verified by inspection that both modes emit kind:'import' edges carrying from/to (importGraph.ts:110-118 uses bare file paths, so the ancestor walk is a no-op there; fsTree.ts:496-500 uses anchorId(), which is exactly the row-inside-container case the walk exists for), so both modes get this with no mode file touched. Scope respected: tic-0680 owns data/derive.ts, modes/fsTree.ts and modes/fileDetail.ts and none were edited or needed. Verification: 6 new tests in canvas/scene.test.ts (both endpoints returned; union across several edges; two-level ancestor chain included; edges with no endpoints and unknown edge ids ignored; empty-in/empty-out and an empty scene; looping parent chain terminates). 373 -> 379 tests, 23/23 files pass; npm run build (tsc -b + vite) clean, only the pre-existing chunk-size advisory. Files changed: web/src/canvas/scene.ts, web/src/canvas/Workspace.tsx, web/src/canvas/scene.test.ts.
