---
id: tic-1d9a
title: 'Goto: import-row tooltip on canvas + travel out of the current focus scope'
status: closed
type: bug
tier: medium
domain: ui
epic: viz-workspace
priority: 3
tags:
- goto
- tooltip
- canvas
- scope
- fs-tree
assignee: code
depends_on: []
blocked_by: null
created: '2026-08-30T22:51:16'
updated: '2026-08-30T23:03:57'
closed: '2026-08-30T23:03:57'
---

## Description
Two goto defects from user feedback:

## Notes
- 2026-08-30T23:03:57 code: (A) Tooltip: replaced the unreliable host-div-title tooltip on canvas icon buttons with a real positioned .canvas-tooltip bubble reported via onTooltip(clientX,clientY) through NodeChip -> CanvasIconButton (Workspace.tsx, IconButton.tsx, styles.css); covers go-into and import-row goto buttons. (B) Out-of-scope travel: added minimalScopeForTarget() in modes/fsTree.ts; App passes resolveGotoScope to Workspace; the onGoto handler now pops the focus out to the minimal scope containing an unresolvable target, skips the focus-change fit while a pending goto is queued, then flies once the wider scene lands. 4 new tests (fsTree); 289 web tests pass; tsc -b clean.
