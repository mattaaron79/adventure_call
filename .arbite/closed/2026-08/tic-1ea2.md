---
id: tic-1ea2
title: Scope 'animate all' to import lines only, not folder/nesting lines
status: closed
type: bug
tier: low
domain: ui
epic: viz-canvas
priority: 6
tags:
- canvas
- edges
- animation
assignee: deepseek-v4-flash.001
depends_on: []
blocked_by: null
created: '2026-08-31T13:57:13'
updated: '2026-08-31T13:58:05'
closed: '2026-08-31T13:58:05'
---

## Description
The 'animate all' checkbox currently marches ants on every edge, including the folder/nesting elbow lines. The user wants only the import lines animated when the box is checked; the folder (nesting) lines should stay static. Update isAntsEdge so the animate-all gate matches only kind==='import' edges, and adjust the associated tests.

## Notes
- 2026-08-31T13:57:57 deepseek-v4-flash.001: Scoped the 'animate all' toggle to import lines only. isAntsEdge (scene.ts) now returns edge.kind==='import' when animateAll is on (previously it matched every edge), so folder/nesting elbows and unkinded lines stay static while the box is checked; the default (off) behaviour is unchanged (highlighted directional import only). Updated isAntsEdge tests in scene.test.ts with import/nesting/unkinded cases. npm test: 336 passed; npm run build: OK. ; arbite close tic-1ea2
