---
id: tic-4d7c
title: 'Canvas icon buttons: shared hit target, go-into fixes, tooltips, goto on import
  rows'
status: closed
type: bug
tier: medium
domain: ui
epic: viz-workspace
priority: 1
tags:
- canvas
- konva
- icons
- hover
- tooltip
assignee: code
depends_on: []
blocked_by: null
created: '2026-08-30T20:56:51'
updated: '2026-08-30T21:18:56'
closed: '2026-08-30T21:18:56'
---

## Description
Several small defects in the on-canvas icon affordances, plus one addition. They all live in the same code (GoInChip and its neighbours in src/canvas/Workspace.tsx) so they are one job.

FIRST: factor the ad-hoc GoInChip into a shared canvas icon-button component -- own hover state, own hit target, pointer-down/up click discrimination, optional tooltip, an SVG path to draw. Everything below then falls out of it rather than being patched in four places.

FIXES
1. Hover bleed. GoInChip is handed the CHIP's hover flag (hovered === node.id in Workspace.tsx), so hovering anywhere on a folder lights the icon as though the pointer were on it. The icon must track its own onMouseEnter/onMouseLeave.
2. Wrong icon. It draws a Text '→'. Use the folder-with-arrow-dropping-in glyph already defined in src/ui/GoInIcon.tsx -- that shape reads as 'step into' and is what the sidebar file search already uses, so the two surfaces should match. Render it as a Konva Path from the same path data; do not hand-redraw it.
3. No tooltip. Konva shapes have no title attribute. Give the shared component a tooltip -- setting the stage container's title on enter/leave is the cheapest honest option; a canvas-drawn tooltip is fine too if it does not add a listening layer. Match the sidebar's wording ('Go into <path>').
4. The folder currently focused must not offer a go-into button on itself -- there is nowhere to go. Hide it when the chip's target equals the active focusPath.

ADDITION
5. Import rows inside an expanded file container get an inline goto button on the right side of the row, matching the one the inspector's import card already has. It emits the same goto event (emitGoto in src/data/goto.ts) so the camera flight logic is not duplicated. Rows with no resolvable target -- external imports from tic-314c -- show no button.

Keep the edge and group layers listening={false}; only the node layer hit-tests. The icons must not arm the parent chip's Konva drag (GoInChip's existing cancelBubble + preventDefault handling is the pattern to preserve).

EXIT: the go-into icon lights only under its own pointer, shows the folder-arrow glyph and a tooltip, is absent on the focused folder; import rows fly the camera from the canvas; dragging a folder chip by its body still works.

## Notes
- 2026-08-30T21:18:53 code: Implemented shared canvas icon button (web/src/canvas/IconButton.tsx + iconButtonLogic.ts): own hover state (fixes hover bleed - no longer handed the chip's hovered flag), own 18px hit target, pointer-down/up click-vs-drag discrimination with cancelBubble + preventDefault (chip drag preserved), optional container-title tooltip (Go into <path> / Go to <path>), glyph rendered as Konva Path from GO_IN_ICON_PATHS/GOTO_ICON_PATHS (single source of truth with sidebar icons). Go-into hidden on the focused folder via shouldShowGoIn. Import rows inside expanded containers carry gotoTo = imported file path and render a crosshair goto button that emits the existing goto event so the camera flies there; external rows (tic-314c) have no target. Edge/group layers stay listening=false. Tests: new iconButtonLogic.test.ts (8) + fsTree.test.ts additions (4); npm test 245 pass, tsc -b clean.
