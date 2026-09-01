---
id: tic-ea7b
title: 'Canvas chip polish: icon order, centred icons on closed chips, wider import-graph
  chips, fit on focus'
status: closed
type: chore
tier: high
domain: ui
epic: viz-modes-next
priority: 15
tags:
- icons
- chips
- canvas
- local-view
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-01T06:03:03'
updated: '2026-09-01T06:09:33'
closed: '2026-09-01T06:09:33'
---

## Description
Four polish items from the user's review of tic-d7d7:

1. Swap the two on-chip icons so the source-link (VS Code) button is the RIGHT-most one and the action button (focus affordance / camera goto) sits to its left.
2. Every CLOSED node should carry its icons vertically centred; the fs-tree folder chips are the model. Today a file item pins its icons to y=4 (upper right), which is right for a tall expanded container but wrong for a 40px chip.
3. The import graph's file chips are too narrow next to the fs-tree's; raise the max width and, more to the point, make the measured width account for the icon slots the chip actually carries, so a name is not clipped by its own buttons.
4. Entering a Local View should fit the camera to the new scene. The existing focus-change fit fires while the import graph's elk layout is still in flight, so it fits an empty scene and nothing re-frames when the real layout lands.

## Notes
- 2026-09-01T06:09:24 claude.opus.001: All four done. (1) + (2) are now one pure rule, iconSlots(width, height, hasSource, hasAction) in canvas/iconButtonLogic.ts, which NodeChip reads for both button positions and the label inset -- the module already exists to keep exactly this kind of geometry testable in the node env, and the tic-d7d7 overlap bug was the argument for extracting it. Ordering: two slots at the right edge filled outermost first, source link always outer, action button (focus affordance on a chip, camera goto on a row -- never both) inboard of it; a lone button takes the outer slot rather than leaving a gap. Vertical: centred when the node is CENTRED_ICON_MAX_HEIGHT (56) or shorter, top-corner-pinned above that. Height is the honest discriminator between 'chip' and 'expanded container' -- every chip in every mode is 24-40 units tall and the shortest container is a 36-unit header plus padding plus a row, so nothing lands near the line. Net effect: fs-tree FILE chips move from y=4 to centred (what was asked); directory chips and rows are unchanged, having been centred all along; containers keep their corner. (3) importGraph CHIP_PAD 24 -> 76, min 120 -> 150, max 260 -> 340. The max was never what bound: real names top out at 24 chars (~178 units), and the actual problem was that the pad predated the chips having icons at all, so a chip measured for its name alone lost 64 units of that name to the buttons drawn over it. 76 = the 12-unit label inset plus the two 24-unit icon slots, so the measure covers name AND furniture. (4) The focus-change effect no longer calls fit() inline; it sets a pending flag that a new effect consumes on the first NON-EMPTY scene. Empty scenes are skipped rather than consuming it, which is the whole point: the import graph re-renders with an empty scene the moment focusPath changes and only fills in when elk answers, so the old inline fit framed nothing and the arriving scene was never framed. A synchronous mode still fits in the same commit.

- 2026-09-01T06:09:33 claude.opus.001: Verified: cd web && npm run test 465 pass / 25 files; npm run build clean; the running dev server transforms every changed module. New coverage in iconButtonLogic.test.ts for iconSlots (source outer / action inner, a lone button taking the outer slot, centred on chip and row, corner-pinned on a container, the label inset per button count, and that the label can never run under the inner button). importGraph.test.ts's measure bounds moved to 150/340 and gained a case asserting the widest chip leaves its longest name clear of both icon slots. NOT verified by me: the on-screen result -- I cannot drive a browser. Worth a look in particular at (2), since it moves the icons on every fs-tree file chip, and at (3), where a median chip is now ~159 units against the fs-tree's fixed 190; if they still read narrow, CHIP_PAD or FILE_CHIP_MIN_WIDTH is the knob, not the max.
