---
id: tic-b1ab
title: 'Entering a scope: auto-expand the folder, and an on-workspace breadcrumb toolbar'
status: closed
type: feature
tier: medium
domain: ui
epic: viz-workspace
priority: 2
tags:
- navigation
- scope
- breadcrumb
- hud
assignee: code
depends_on: []
blocked_by: null
created: '2026-08-30T20:57:04'
updated: '2026-08-30T21:36:01'
closed: '2026-08-30T21:36:01'
---

## Description
Two changes to what happens when you drill into a folder.

1. AUTO-EXPAND. Going into a collapsed folder currently shows an empty scope. Entering a scope should expand that folder if it is not already expanded (setFocusPath in src/state/store.ts, expand state in the same mode slice). Entering must not collapse anything the user had already opened.

2. ON-WORKSPACE BREADCRUMB TOOLBAR. The '/' and '..' buttons currently sit in the bottom HUD, far from the thing they act on. Move that navigation onto the canvas, in a small toolbar floating just above the focused folder's group rectangle:
   - a '/' button back to root,
   - a '..' button up one level,
   - then a sequence of breadcrumb buttons, one per ancestor segment, each jumping straight to that level.
   The toolbar only exists while focusPath is non-empty. Position it in world space against the top edge of the focus group rect, but draw its text at a readable size regardless of zoom -- a toolbar that shrinks to nothing when zoomed out is useless. Long paths must degrade gracefully (elide middle segments rather than running off the canvas).
   Decide deliberately whether this is a Konva overlay layer or an HTML overlay positioned from the viewport transform; HTML is likely simpler for buttons with text, tooltips and focus behaviour, and the workspace already has an HTML HUD to follow as a pattern.
   Remove the now-duplicated '/' and '..' from the bottom HUD (and the divider added for them), leaving Fit and Relayout.

EXIT: going into a collapsed folder shows its contents; a breadcrumb toolbar sits above the focused group and jumps to any ancestor level; the bottom HUD no longer carries duplicate navigation.

## Notes
- 2026-08-30T21:35:59 code: Implemented auto-expand on scope enter in store.setFocusPath (adds dir:<path> to the mode's expand state, purely additive so nothing open collapses; re-opens a folder collapsed from inside the scope). Added a world-space HTML BreadcrumbToolbar (canvas/BreadcrumbToolbar.tsx) floating above the focused folder's group box, showing /, .., one button per ancestor segment plus the current folder, with middle-segment elision and clamping to the workspace; pure breadcrumb path logic factored into canvas/breadcrumbs.ts. Removed the duplicate / and .. buttons (and their divider) from the bottom HUD. Tests: new breadcrumbs.test.ts (7), store auto-expand (+3), fsTree group-box anchor (+1). All 265 web tests pass; tsc -b clean.
