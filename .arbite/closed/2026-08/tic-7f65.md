---
id: tic-7f65
title: Goto should expand collapsed folder then navigate
status: closed
type: feature
tier: medium
domain: ui
epic: null
priority: 3
tags:
- goto
- filetree
- collapse
- expand
assignee: zoo.glm-5.3-flash.001
depends_on: []
blocked_by: null
created: '2026-08-30T23:18:01'
updated: '2026-08-30T23:20:27'
closed: '2026-08-30T23:20:27'
---

## Description
If a goto button is clicked and the target is inside a collapsed folder, expand the folder(s) first, then perform the goto.

## Notes
- 2026-08-30T23:20:24 zoo.glm-5.3-flash.001: Implemented expand-then-goto: FileTree now subscribes to the goto event (onGoto) and, when a target is inside a collapsed folder, opens the folder chain above it before the canvas flies there. Added exported ancestorDirs(path) helper (web/src/ui/FileTree.tsx) that yields the root-relative dirs containing a target, skipping the target itself and no-op'ing for non-path targets (scene element ids / symbol ids via a ':' guard). Applies to goto buttons on any surface -- file tree, inspector, canvas import rows -- since they all emit the same event; the workspace still owns the flight. 6 new unit tests in web/src/ui/fileTree.test.ts; 297/297 pass, tsc -b clean.
