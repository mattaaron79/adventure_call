---
id: tic-d7d7
title: 'Import graph: "Local View" -- single-hop neighbourhood scope with a return-to-root
  toolbar'
status: closed
type: feature
tier: frontier
domain: ui
epic: viz-modes-next
priority: 16
tags:
- imports
- focus-scope
- local-view
- icons
assignee: claude.opus.001
depends_on:
- tic-ea9d
blocked_by: null
created: '2026-08-31T20:29:14'
updated: '2026-09-01T06:37:49'
closed: '2026-09-01T06:37:49'
---

## Description
User request: in the manner of the Files and symbols "go into" mode, a local view of import relationships -- a less spacious view for quicker analysis of which files a change immediately affects. Button title "Local View", lucide vector-polygon icon, and a cut-down breadcrumb toolbar that is really just a return-to-root button.

CONTENT, confirmed with the user 2026-08-31: one hop in BOTH directions -- the centre file, every file it imports, every file that imports it -- PLUS every import edge that exists between those neighbours, so a dependency shared by two neighbours is visible rather than hidden. Not a bare star, not two hops.

WORK -- the affordance (generic framework, not import-graph-specific)
1. web/src/modes/types.ts: SpecNode already carries focusTo (tic-e7d2) and the canvas renders the go-into button from it generically. Add focusIcon?: "go-in" | "local-view" and focusLabel?: string, carried through assemble() onto SceneNode (web/src/canvas/scene.ts) alongside focusTo.
2. web/src/canvas/Workspace.tsx: pick the glyph from a small id -> paths map, defaulting to GO_IN_ICON_PATHS and todays "Go into ..." tooltip so fs-tree is untouched; use focusLabel as the tooltip when present.
3. New web/src/ui/VectorPolygonIcon.tsx exporting LOCAL_VIEW_ICON_PATHS, following the two conventions the existing icons already document: lucide source is 24x24 and CanvasIconButton assumes a 16x16 box, so scale by 2/3 (see FILE_SYMLINK_ICON_PATHS in web/src/ui/FileSymlinkIcon.tsx), and CanvasIconButton only draws path d strings, so the four circles must be written as arc data (see the circle in GOTO_ICON_PATHS in web/src/ui/GotoIcon.tsx). The lucide vector-polygon glyph is four r=2 circles at (11,4) (15,20) (20,8) (4,13) joined by four line paths: m12.828 4.813 5.344 2.375 / m15.769 18.153 3.461-8.306 / m5.687 14.074 7.625 4.852 / M9.772 5.579 5.228 11.42.

WORK -- the scope
4. web/src/modes/importGraph.ts select() reuses the existing per-mode ui.focusPath rather than inventing new state: it is already persisted (web/src/state/persist.ts), already captured by presets, and setFocusPath already clears stale drag overrides. Every file SpecNode gets focusTo: file.path, focusIcon: "local-view", focusLabel: "Local View". A non-empty focusPath naming a file in the current workspace scopes the scene to the neighbourhood described above; a focusPath that names nothing visible falls back to the whole graph, the way fsTree.scopeRoot does. Emphasise the centre file in style() so it is obvious which node the view is about.
5. "Less spacious": pass tighter layerGap / nodeGap (ElkLayoutOptions, web/src/layout/elkTypes.ts) while a local view is active, so the neighbourhood reads compactly instead of at whole-graph spacing. The cache key already folds in params/sizes after tic-531b -- make sure the focus path is part of what distinguishes one cached layout from another.

WORK -- the toolbar
6. web/src/canvas/Workspace.tsx focusRect (~line 688) only resolves the fs-tree ids dir:<path>:group and dir:<path>; add a final fallback to output.rects.get(focusPath) so a file-id focus anchors the toolbar.
7. web/src/canvas/BreadcrumbToolbar.tsx gains a rootOnly prop: render the "/" button ("Back to the whole graph") plus the current file as a plain non-clickable label, with no ".." and no ancestor crumbs -- a file paths parent directories are meaningless in this mode. Keep the existing measuring/clamping behaviour (tic-de05s bail-out is load-bearing; do not break it).
8. web/src/App.tsx: resolveGotoScope is fsTree.minimalScopeForTarget over the fs tree; return null in Import graph so a camera goto never pops the focus out to a DIRECTORY path this mode cannot scope to.
9. Note for whoever works this: store.setFocusPath also sets expanded["dir:" + path] = true. Harmless here (no such element exists in this mode) but call it out in your close note rather than leaving it as a surprise for the next reader.

Verification: cd web && npm run test -- neighbourhood selection (importers in, imports in, neighbour-to-neighbour edges kept, an isolated file yields just itself, an unknown focus path falls back to the whole graph), and the rootOnly toolbar rendering. npm run build. npm run dev: click Local View on a hub file, confirm the scoped view shows its importers above and its imports below with the cross-edges drawn, that the toolbar "/" returns to the whole graph, that the camera re-frames on entry and exit, and that the view survives a reload (persisted focusPath).

## Notes
- 2026-08-31T23:39:08 claude.opus.001: Implemented. Framework: SpecNode/SceneNode gain focusIcon + focusLabel, carried through assemble(); Workspace picks the glyph from a FOCUS_ICON_PATHS map defaulting to GO_IN_ICON_PATHS and today's 'Go into ...' tooltip, so fs-tree is untouched. New web/src/ui/VectorPolygonIcon.tsx exports LOCAL_VIEW_ICON_PATHS (lucide vector-polygon scaled 2/3 into the 16x16 box, the four circles written as arc data); the path strings were parsed and ASCII-rasterised to confirm the glyph draws four dots joined by four lines. Scope: importGraph.select reads ui.focusPath as a FILE, scoping to neighbourhoodOf(centre) = centre + importers + imports, keeping every edge with both ends in that set (so neighbour-to-neighbour lines stay); an unknown/absent focus path falls back to the whole graph like fsTree.scopeRoot. Layout runs at layerGap 36 / nodeGap 8 while local (vs 64/12), and the centre is folded into cacheKeyOf -- needed, not belt-and-braces: on a two-file graph the local node/edge/size set is identical to the whole graph's while the spacing differs. style() gives the centre the accent border; the cycle colour keeps the accent bar, so a cyclic centre still says both things. Toolbar: Workspace's focusRect memo became a focus memo that also reports rootOnly -- a focus resolving to dir:<path>[:group] is fs-tree's directory scope, one resolving to a bare element id is a file scope -- and BreadcrumbToolbar gained rootOnly (no '..', no ancestor crumbs, the file as a non-clickable .crumb-label). tic-de05's measure bail-out is untouched; the crumbs memo just keys on rootOnly too. App.resolveGotoScope now returns null outside fs-tree.

- 2026-08-31T23:39:19 claude.opus.001: Two things for the next reader. (1) As item 9 warned, store.setFocusPath also writes expanded['dir:' + path] = true. In this mode that key names nothing: import-graph expand keys are bare file paths, so the centre's container does NOT auto-open on entering a Local View, and Workspace's collapseTargets/expandTargets read the mode's own expandable ids rather than the expanded record, so the stray key is inert. It does persist into localStorage and into any preset captured from a Local View -- harmless, but it is there. (2) One real collision had to be fixed to land this: import-graph file chips already carry a vscode:// source link (buildSourceLinks resolves a bare file path through index.moduleByFile), and its icon sat at width-26 -- exactly where the new focus button goes. NodeChip's slot arithmetic now counts a focus affordance the same way it counts a goto button, so the source link steps left to width-50, and a file item's focus button uses the same upper-right y as its source link instead of the vertical centre (on a tall expanded container, centred is halfway down the box). Side effect, deliberate: an fs-tree directory chip now reserves 40px of label inset for its go-into button instead of 20, so long folder names stop running under it.

- 2026-08-31T23:39:31 claude.opus.001: Verification. cd web && npm run test: 454 pass, 25 files (was 431/24) -- new coverage for neighbourhoodOf (one hop both ways, isolated file yields just itself, a neighbour outside the filter scope dropped), select under a Local View (scope, neighbour-to-neighbour edges kept, two-hop file and its edge dropped, goto index scoped, fallback to the whole graph for a stale/directory/unknown focus path), the affordance fields, the centre's styling, cacheKeyOf vs the identical-ids case, toolbarCrumbs in both shapes, and a new modes/types.test.ts proving assemble() carries focusIcon/focusLabel to the scene (a field it forgot to copy would be a silent no-op). npm run build: clean. Sanity-checked against the real out/codebase_graph.json (189 files, 235 edges) with a throwaway test since it is the honest test of 'less spacious': neighbourhood size p50 1 file, p75 4 files / 5 edges, p90 7 / 11, max 52 / 108 for src/carnot/kernel/plugin.py -- so a typical Local View is a handful of chips, and the one extreme hub is genuinely that connected. Every scoped edge had both ends in the scene (the elk unresolved-shape guard). NOT verified by me: the browser pass in item 45's list -- clicking Local View, the toolbar '/' returning to the whole graph, the camera re-frame on entry/exit, and survival across a reload. A dev server was already up on 5175 and serves every changed module (200, transformed), so that pass is a click away, but I could not drive a browser.

- 2026-09-01T06:37:48 claude.opus.001: User reviewed the running app across this and the follow-up tickets (tic-556d, tic-ea7b) and confirmed the behaviour; the browser pass the verification list called for is done from their side. Closing.
