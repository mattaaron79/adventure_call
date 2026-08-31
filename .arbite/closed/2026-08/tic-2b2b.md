---
id: tic-2b2b
title: Animate directional edges with marching ants when highlighted
status: closed
type: feature
tier: medium
domain: ui
epic: viz-canvas
priority: 5
tags:
- canvas
- edges
- animation
- direction
assignee: deepseek-v4-flash.001
depends_on: []
blocked_by: null
created: '2026-08-31T11:30:00'
updated: '2026-08-31T11:34:51'
closed: '2026-08-31T11:34:51'
---

## Description
Add a subtle marching-ants (animated dashed line) effect to edges that carry directionality, to visually show direction. Currently only the import edges are directional. The animation must only be visible when the edge is highlighted/colored (not grayed out). Reference: user request 'To show directionality for any lines that have directionality, please implement a subtle marching ants animation on the lines. Right now the only direction lines are the import lines. Only show the animation when the line would be highlighted and colored (not gray)'.

## Notes
- 2026-08-31T11:34:48 deepseek-v4-flash.001: Implemented marching-ants animation on directional edges. Added 'directional' flag to SpecEdge (types.ts) and SceneEdge (scene.ts), set true on import edges in fsTree.ts and placeholderScene.ts. New pure helpers in scene.ts: ANTS_DASH=[6,6], ANTS_SPEED_PX_PER_SEC=60, antsDashOffset(), isAntsEdge(). Workspace.tsx: single shared Konva.Animation drives dashOffset on registered lit directional lines (looked up by id each frame via edgeShapes); EdgeLine opts in/out via registerAnts effect; dash reverts and offset resets when unlit. Animation only runs while at least one directional edge is highlighted (not gray). Tests added in scene.test.ts (6 new assertions). npm test: 334 passed; npm run build: OK.
