---
id: tic-e7d2
title: 'Focus scope: drill into a folder, with root and up buttons in the HUD'
status: open
type: feature
tier: high
domain: ui
epic: viz-workspace
priority: 3
tags:
- navigation
- scope
- hud
- mode
assignee: null
depends_on:
- tic-bee0
blocked_by: null
created: '2026-08-30T18:45:40'
updated: '2026-08-30T18:46:42'
closed: null
---

## Description
A way to enter one region of the graph and see nothing else.

WORK
1. src/state/store.ts -- a per-mode focusPath (the directory path currently drilled into, empty string = root). Persist it with the rest of the mode state (src/state/persist.ts) and include it in presets (src/modes/presets.ts).
2. Scope the scene to focusPath. Do this in the mode's select phase (src/modes/fsTree.ts) so it flows through the VizMode interface -- the app must not special-case it. When focused, the scope directory becomes the root of the laid-out tree and everything outside it is absent from the scene, not merely dimmed.
3. Entering a scope should re-fit the camera and must not inherit stale drag overrides from the wider view.
4. src/canvas/Workspace.tsx -- each directory chip gets a 'go into' icon on its right edge. It is a distinct hit target from the chip body, which keeps its existing expand/collapse behaviour. Sized so it stays usable at normal zoom and dropped by the existing LOD thinning when zoomed far out.
5. HUD (bottom of Workspace.tsx, where Fit and Relayout live) -- add a '/' root button and a '..' up-one-level button to the LEFT of Fit/Relayout, with a small vertical divider between the two pairs. Both are hidden (not merely disabled) when focusPath is empty, since neither means anything at root.
6. src/ui/FileTree.tsx -- the 'go in' icon to the right of the goto icon added in the camera-goto ticket, drilling into that folder.

EXIT: clicking go-into on a folder shows only that subtree; '..' walks up one level; '/' returns to the whole graph; the scope survives a reload and rides along in a saved preset.

## Notes
