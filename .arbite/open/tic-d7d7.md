---
id: tic-d7d7
title: 'Import graph: "Local View" -- single-hop neighbourhood scope with a return-to-root
  toolbar'
status: open
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
assignee: null
depends_on:
- tic-ea9d
blocked_by: null
created: '2026-08-31T20:29:14'
updated: '2026-08-31T20:29:14'
closed: null
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
