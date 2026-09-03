---
id: tic-bc09
title: 'Sunburst follow-up: zoomed-scope labelling, pie-chunk labels, Files and symbols
  parity'
status: closed
type: feature
tier: high
domain: ui
epic: viz-workspace
priority: 6
tags:
- sunburst
- canvas
- modes
- fs-tree
- labels
- pie
- scope
assignee: deepseek-v4-flash.001
depends_on:
- tic-70f9
blocked_by: null
created: '2026-09-02T15:42:17'
updated: '2026-09-02T16:40:16'
closed: '2026-09-02T16:40:16'
---

## Description
Follow-up to tic-70f9 (the Sunburst mode it landed, closed). The wedge geometry, ring layout, metric sizing, focus scoping and the directory go-into affordance are all in; this ticket is the labelling and stock-mode-parity pass on top. Three threads, all touching web/src/modes/sunburst.ts and the WedgeNode renderer in web/src/canvas/Workspace.tsx.

## 1. 'Zoomed in' scope labelling
When the sunburst is scoped -- a directory slice's go-into, or the breadcrumb toolbar -- the focused folder becomes the hub at the centre (depth 0, a full disk). That hub is never labelled on the canvas. WedgeNode labels a slice only when `canLabel = span >= 0.16 && thickness >= 26 && chord >= 60` (Workspace.tsx ~1765), and `chord = 2 * midRadius * sin(span / 2)`: for the full-circle hub `midRadius = 60` and `span = 2*pi` makes the chord 0, so the gate always fails and the hub draws neither a label nor (a root slice has no `focusTo`) a button. In the stock fs-tree the focused folder's own chip stays in the scene with its name and 'N files' sublabel, so the canvas itself says where you are; in the sunburst the only cue is the HTML breadcrumb floating above. Give the hub an in-scene identity -- at minimum a centred label naming the focused folder, drawn on the disk where there is plenty of room -- so scoping into a directory is legible from the chart itself. Confirm placement during implementation (centred hub text vs. a label at the inner edge of ring 1, and what to show when the hub is the unscoped root).

## 2. Pie chunk labels
Slice labels today are minimal and purely geometry-gated:
- Only the short name is ever drawn. No slice carries a sublabel even though SceneNode.sublabel exists, assemble carries it (modes/types.ts), and NodeChip already renders one at lod 0. The fs-tree labels files 'N symbols' and directories 'N files'; the sunburst already sizes every slice by exactly those numbers (Slice.value in sunburst.ts) but never shows them. Draw a sublabel on slices with room for a second line.
- Text is horizontal and centred at the slice's midpoint, width-capped at `min(chord, 220)` with ellipsis, so a slice that is wide but radially thin still clips names that would fit rotated. Consider arc-aligned or step-rotated text so a name reads along its own sector.
- Slices below the canLabel thresholds are nameless at every zoom, so the many small outer files of a real codebase are indistinguishable wedges. In fs-tree every row is labelled once zoom allows; give the sunburst an equivalent floor (small-slice label, hover/tooltip reveal, or a threshold that reveals names as the camera comes in to lod 0).
Follow the chips' LOD rules (Workspace.tsx: name at lod < 2, sublabel only at lod 0) rather than geometry alone.

## 3. Closer to the stock 'Files and symbols' (fs-tree) mode
Parity items the sunburst lacks today, each to scope for fit inside a pie:
- Sublabels on both slice kinds: file wedges show their symbol count (the number fileValue measured), directory wedges their file count -- the fs-tree chip sublabels.
- The cross-mode open-in affordance on file slices (fs-tree visitFile sets openIn to the import graph's Local View, tic-e738); a file wedge should offer the same jump to its import neighbourhood.
- Keep selection/inspector resolution working through the fs-tree id scheme (dir:<path> / bare file path), and make sure a focused hub's name/path resolves sensibly once it is labelled.
- Consider whether a file wedge should reveal its contained symbols (the fs-tree expands a file into its rows) through the inspector or a hover listing, since a pie has no room for the rows themselves.
Anything not listed is deliberately out of scope (e.g. drawing file-to-file import lines as arcs across the pie).

## Acceptance criteria
- A sunburst scoped into a directory shows that folder's name on the hub in-canvas, not only in the breadcrumb toolbar.
- Slices that fit show name and a metric sublabel; small slices are identifiable at lod 0 (label reveal, tooltip, or a documented threshold) rather than silent wedges.
- File wedges carry the fs-tree's Local View open-in affordance; directory wedges keep go-into and gain a file-count sublabel.
- Pure logic (sublabel text, label-fit thresholds, scope-name derivation) lives in sunburst.ts and is unit-tested in the project's node-test pattern; the full suite stays green (web tests + tsc -b + vite build clean).

## Notes
- 2026-09-02T16:31:47 deepseek-v4-flash.001: Implemented: (1) zoomed-scope hub labelling -- the hub (innermost disk) now carries the focused folder's name + file count centred on the disk when scoped; an unscoped root is left clean instead of a lone '/'. (2) Pie chunk labels -- slices that can host text now show name + a count sublabel (files: 'N symbols', dirs: 'N files') at lod 0, following the chips' LOD rules; a pure canvas/wedgeLabel.ts helper owns the label/sublabel/affordance fit floors, with a lod-0 reveal that relaxes the label floors so the small outer file slices get names when zoomed in. (3) Files & symbols parity -- file wedges carry the fs-tree's Local View open-in (openIn to import-graph), directory wedges keep go-into and gain the file-count sublabel; a wedge shows its text in the radial middle and any affordance icon at the outer arc so the two never collide. Verified: full web suite 1000 pass; tsc -b and vite build clean. NOTE: label placement/geometry verified only in unit tests and by inspection -- the on-screen look of the two-line hub/slice labels and the outer-arc affordance wants a browser check.

- 2026-09-02T16:36:34 deepseek-v4-flash.001: Reopened.

- 2026-09-02T16:40:11 deepseek-v4-flash.001: User review: the per-top-level-branch rainbow was hard to read. Replaced BRANCH_COLORS in web/src/modes/sunburst.ts with a single hue family: every slice is now a shade of THEME.accent (the module/file cell blue, == KIND_COLOR.module == selection colour), via a new exported pure sliceShade(branch, depth) that mixes the cell blue toward black a little more with each ring out (rings read as steady darkening from the hub) and nudges by branch parity so adjacent top-level slices stay distinguishable without changing hue. Removed the unused 8-hue table and the whitewards lighten() helper; hub stays THEME.surface2 neutral. New tests in sunburst.test.ts: every non-hub slice fill is blue-dominant (blue > red and >= green) so no rainbow hue can sneak in; two top-level slices at the same depth differ in shade; a deeper slice is darker than its top-level folder. Verified: full web suite 1002 pass; tsc -b and vite build clean. On-screen contrast for a browser look, but the fills stay mid-to-dark so the new labels stay legible.
