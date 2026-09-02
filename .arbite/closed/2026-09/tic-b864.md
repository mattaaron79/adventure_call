---
id: tic-b864
title: 'Highlight tweaks: reverse ants on Shift; lit lines keep their own colour'
status: closed
type: feature
tier: medium
domain: ui
epic: viz-modes-next
priority: null
tags:
- canvas
- edges
- hover
- shift
assignee: deepseek.v4-flash.001
depends_on: []
blocked_by: null
created: '2026-09-02T12:19:00'
updated: '2026-09-02T12:21:06'
closed: '2026-09-02T12:21:06'
---

## Description
Follow-ups to the nearest-line hover / double-click thread (tic-1250, tic-0961). Two tweaks: (1) While Shift is held, the nearest (hovered) line's marching-ants animation should run in REVERSE -- it already flips its popup arrow to '<' and a shift+double-click flies to the line's source, so the flow indicator should point back toward the source rather than the destination. (2) A connection line that is highlighted for ANY reason (incident to a hovered/selected node, or the nearest line under the cursor) should keep its own stroke colour instead of being recoloured to THEME.import / THEME.nearest: the mode already colours lines semantically (grey imports, warm call/state/type lines), and a lit line should read as the same line made prominent (thicker, full opacity, drawn on top, marching where directional) rather than as a different-coloured line. Acceptance: shift held over a line reverses its ants; releasing shift resumes forward; ants on non-nearest highlighted lines are unchanged; lit and nearest lines render in edge.stroke; tests and build stay green.

## Notes
- 2026-09-02T12:21:03 deepseek.v4-flash.001: Implemented the two highlight tweaks in web/src/canvas/Workspace.tsx and theme.ts. (1) Reverse ants on Shift: the marching-ants registry is now a Map<edgeId, reverse>; EdgeLine registers itself with a reverse flag (reverseAnts = nearest && shiftHeld) and the single Konva.Animation drives each line's dash offset as -antsDashOffset(time) when reversed, so the nearest (hovered) line's flow points back toward its source while Shift is held -- matching its '<' popup arrow -- and resumes forward on release. Only the nearest line reverses; other lit/animate-all lines are untouched. (2) Lit lines keep their own colour: EdgeLine no longer recolours highlighted or nearest edges to THEME.import / THEME.nearest -- stroke is always edge.stroke -- so a lit line reads as the same semantically-coloured line made prominent (thicker, full opacity, drawn on top, marching where directional). THEME.import / THEME.nearest docstrings updated to palette documentation. 963/963 pass; tsc -b and vite build clean.
