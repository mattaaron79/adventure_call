---
id: tic-468e
title: Source-line (file-symlink) icon button on workspace items
status: closed
type: feature
tier: high
domain: ui
epic: viz-modes-next
priority: 6
tags:
- canvas
- icons
- vscode-link
- source
- ui
assignee: deepseek.v4-flash.001
depends_on: []
blocked_by: null
created: '2026-08-31T08:55:45'
updated: '2026-08-31T08:58:50'
closed: '2026-08-31T08:58:50'
---

## Description
The selection inspector already shows the symbol's source line as a clickable vscode://file/... deep link (vscodeFileLink/launchVscodeLink). Add the same link as a small file-symlink icon button (lucide file-symlink glyph) on each source-bearing workspace item -- file chips and symbol rows -- positioned to the left of the existing goto button on import rows (and in the icon slot for items without a goto). Clicking launches the deep link the same way the inspector does (hidden-iframe launch, no blank tab). The canvas needs the per-element vscode URL map (resolved from the mode output's symbolOf + the workspace index via the module graph / symbol index) plus the shared icon paths; the app computes the map from absoluteRoot.

## Notes
- 2026-08-31T08:58:46 deepseek.v4-flash.001: Implemented. Each source-bearing workspace item (file chips and symbol rows) now shows a small file-symlink icon button (lucide file-symlink glyph, scaled into the shared 16x16 viewBox) that opens the item's source line in VS Code via the same vscode://file/... deep link the inspector shows (launchVscodeLink, hidden-iframe so no blank tab). On import rows it sits to the left of the existing goto button; elsewhere it takes the icon slot, and the label inset widens to fit. A new buildSourceLinks helper resolves each scene element to a symbol (via the mode output's symbolOf + index) or to a file (moduleByFile) and builds the URL from absoluteRoot; App memoises the map and passes it to Workspace. Added FILE_SYMLINK_ICON_PATHS plus a reusable FileSymlinkIcon component (ui/FileSymlinkIcon) and shared .file-symlink-icon chrome in styles.css. 4 new tests for buildSourceLinks; 318 tests pass, tsc clean, production build clean.
