---
id: tic-b182
title: 'File tree rows: local-view icon to the right of the goto icon'
status: open
type: feature
tier: low
domain: ui
epic: viz-workspace
priority: 8
tags:
- file-tree
- sidebar
- icons
- open-in
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-01T06:29:25'
updated: '2026-09-02T11:17:45'
closed: null
---

## Description
User request: in Import graph mode, in the left pane's file search/tree, add the local-view icon to the right of the goto icon.

Context: the sidebar file tree (web/src/ui/FileTree.tsx) already renders a GotoIcon on file rows (line ~138) and a GoInIcon beside it, both shared glyphs also drawn on the canvas. The canvas already has a 'local-view' affordance whose glyph lives in `LOCAL_VIEW_ICON_PATHS` (web/src/ui/VectorPolygonIcon.tsx) and whose action takes the store's `openInMode` jump -- the same call the canvas's open-in button and the inspector's cross-mode jump make (tic-d6af), so excursion provenance and the way back come for free.

Task: on file rows in the left pane's file tree (as used in Import graph mode), add a local-view button drawn from the same shared glyph data (`LOCAL_VIEW_ICON_PATHS`), placed to the right of the existing goto icon. Clicking it jumps the workspace into the open-in mode focused on that file, exactly as the canvas's local-view button does.

Placement detail to confirm during implementation: file rows currently order GotoIcon then GoInIcon; "right of the goto icon" most likely means at the row's end (after GoInIcon), keeping goto -> go-in -> local-view, but the user may mean literally between goto and go-in -- ask if it reads ambiguously on screen.

Acceptance criteria:
- File rows in the Import graph mode's left pane show the local-view glyph to the right of the goto icon, drawn from `LOCAL_VIEW_ICON_PATHS` so it matches the canvas's shape.
- Clicking it takes the same open-in jump the canvas's local-view button takes (store's `openInMode`), recording the same excursion provenance and way back.
- Icon activation is isolated from row selection and from the goto button (follow the existing row-icon conventions / IconButton pattern; no event bubbling into the row).
- Behaviour is unit-testable in the project's node-test pattern (pure logic extracted where the existing tests do).

## Notes
