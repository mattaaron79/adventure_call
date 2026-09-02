---
id: tic-260c
title: 'Give call-flow lines the import lines'' hover treatment: popup, highlight,
  ants'
status: in_progress
type: feature
tier: high
domain: ui
epic: viz-modes-next
priority: 1
tags:
- canvas
- callflow
- hover
- popup
- ants
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-02T11:03:20'
updated: '2026-09-02T11:03:25'
closed: null
---

## Description
Three things the canvas does for import lines and not for call/state/type lines, all from the same root cause: importEdgesIncidentTo, isAntsEdge and Workspace's connections filter each hardcode kind === 'import'. (1) The near-pointer popup names nothing in call flow. It should, and for these lines 'a -> b' is not enough -- the line's meaning is which KIND it is and what its tags say. (2) EDGE_POPUP_MAX_LINES is 8; raise to 20, and check the popup's flip-near-the-edge threshold, which assumes a ~160px box. (3) Hovering a function should light its call lines and march their ants, as hovering a file does for its imports.

## Notes
