---
id: tic-8ff7
title: Interaction settings module; soften the goto camera zoom to about a third
status: closed
type: feature
tier: medium
domain: ui
epic: viz-workspace
priority: 2
tags:
- camera
- viewport
- settings
- config
assignee: code
depends_on: []
blocked_by: null
created: '2026-08-30T20:57:27'
updated: '2026-08-30T21:29:49'
closed: '2026-08-30T21:29:49'
---

## Description
Flying to a node lands far too close -- centerOn with zoom:true uses the fitToRect scale, which fills the viewport with a single chip. The user wants roughly a THIRD of the current zoom-in, and wants it adjustable rather than buried in a call site.

WORK
1. Add a single settings module (e.g. src/settings.ts) holding the tunable interaction constants as one exported, documented object -- goto zoom, goto animation duration, wheel zoom rate, fit padding, drag click threshold, tween duration. Values currently sit as literals scattered across src/canvas/viewport.ts (wheelZoomFactor, fitToRect padding), src/canvas/useViewport.ts and src/canvas/Workspace.tsx; move them, do not copy them.
2. Soften the goto zoom to about a third of what it does now. Express it as a named, commented factor in that module -- the point is that the next adjustment is a one-line edit by a human, so name it for what it means, not 'MAGIC_0_33'.
3. Keep centerOn's existing 'comfortable minimum' behaviour: it should still zoom IN when the target would otherwise be too small to see, just not nearly as far, and it must still never zoom OUT past what the user had.
4. Respect MIN_SCALE/MAX_SCALE clamping, and keep the existing unit tests in src/canvas/viewport.test.ts meaningful -- update the expectations rather than deleting the cases.

EXIT: goto lands at a comfortable middle distance with surrounding context visible; every tunable named above reads from the settings module; tests pass.

## Notes
- 2026-08-30T21:29:46 code: Consolidated interaction constants into web/src/settings.ts (goto zoom+duration, wheel rate+clamp, fit padding, drag thresholds, tween duration). Softened goto zoom to ~1/3 of fit scale (GOTO_ZOOM_FACTOR=0.33) via centerOn zoomFactor floor; never zooms out past the user's zoom. Consumers (viewport, useViewport, Workspace, iconButtonLogic) now read from settings. Added settings.test.ts; updated viewport.test.ts and store.test.ts. Full suite: 20 files, 254 tests pass; tsc -b clean.
