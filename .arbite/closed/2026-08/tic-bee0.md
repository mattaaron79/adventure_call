---
id: tic-bee0
title: 'Camera goto: centerOn action plus goto icons in the file tree and inspector
  imports'
status: closed
type: feature
tier: medium
domain: ui
epic: viz-workspace
priority: 2
tags:
- camera
- navigation
- ui
- viewport
assignee: orchestrator
depends_on: []
blocked_by: null
created: '2026-08-30T18:45:30'
updated: '2026-08-30T19:59:03'
closed: '2026-08-30T19:59:03'
---

## Description
Give every place that names a node a way to fly the camera to it.

WORK
1. src/state/store.ts + src/canvas/viewport.ts -- a centerOn(rect, size, opts) action that pans (and optionally zooms to a comfortable minimum) so a given world rect is centred. Reuse the existing fitTo math rather than writing new projection code. Animate the transition (~250ms ease-out) so the user keeps their bearings; instant jumps are disorienting on a graph this size.
2. Resolve an id to a rect through the current ModeOutput. Nodes not present in the current scene (filtered out, or inside a collapsed container) must degrade gracefully -- prefer centring the nearest visible ancestor over doing nothing silently, and select the target so the inspector follows.
3. src/ui/FileTree.tsx -- each folder and file row gets a small 'goto' icon button on the right that centres that node. Icon-only, revealed or emphasised on row hover, with an aria-label; it must not steal the click that expands a directory.
4. src/ui/Inspector.tsx -- each row in the Imports list gets the same goto icon, centring the imported symbol or its file.

The 'go in' icon that sits to the right of goto is tic-<focus-scope> and is NOT part of this ticket; leave room for it in the row layout so it can be slotted in without a reflow.

EXIT: clicking goto anywhere centres and selects the right node with a smooth transition; directory rows still expand on their normal click.

## Notes
- 2026-08-30T19:58:59 code: Implemented camera goto (tic-bee0): centerOn(rect,size,opts) in viewport.ts + store action; GOTO_EVENT constant in data/events.ts with browser emitGoto/onGoto in data/goto.ts; generic goto index on SceneSpec/ModeOutput + resolveGoto in modes/types.ts, built per file/dir path with nearest-visible-ancestor fallback in modes/fsTree.ts (buildGotoIndex); GotoIcon component wired into FileTree rows (files + dirs, hover-revealed, does not steal expand click) and Inspector header (centres selected node's file); Workspace subscribes onGoto, resolves through ModeOutput, honours drag overrides, animates ~250ms ease-out via store setViewport, and selects the target so the inspector follows. Tests added (viewport.centerOn, store.centerOn, fsTree goto index + resolveGoto). npm test: 184 passed. npm run build (tsc -b && vite build): green.
