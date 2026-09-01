---
id: tic-ea9d
title: 'Import graph: double-click expands a file node into its detail container'
status: open
type: feature
tier: frontier
domain: ui
epic: viz-modes-next
priority: 14
tags:
- imports
- expansion
- rows
- imported-by
assignee: null
depends_on:
- tic-531b
- tic-0680
blocked_by: null
created: '2026-08-31T20:28:35'
updated: '2026-08-31T20:28:35'
closed: null
---

## Description
User request: give Import graph nodes the same expansion mechanic as Files and symbols -- double-click expands -- showing all the same data, since the code shortcuts are handy there. Hovering an import should highlight the particular line it connects to, exactly as fs-tree does. In merged-lines mode (tic-531b) that per-row anchoring does not apply and the aggregate line is good enough. The expanded cell shows an "Imported By" section ABOVE "Imports".

Everything needed is already generic. Double-click activation is Workspace.handlers.onPointerUp -> onActivate -> store.toggleExpanded, gated on ModeOutput.expandable, which comes from SpecNode.expandable. Rows with a symbolId get their VS Code source-line button for free (buildSourceLinks in web/src/ui/Inspector.tsx walks the layouts rects and symbolOf). Rows with gotoTo get the camera-goto button for free. Per-row line highlighting falls out of importEdgesIncidentTo once the edge anchors are row ids. web/src/modes/fsTree.ts is the reference implementation for all of it.

WORK in web/src/modes/importGraph.ts
1. select(): file SpecNodes become expandable: true. When ui.expanded[path] is true AND ui.lod < 3 (fs-tree collapses expanded containers at extreme zoom-out; match it), the nodes children are the detail rows from tic-0680s modes/fileDetail.ts fileRows(workspace, file, {importedBy: true}) -- Imported By, Imports, Classes with methods/attributes nested, Functions, Variables -- mapped to SpecNodes exactly as fsTree.visitFile does (role "section" for section headers, "row" otherwise, carrying symbolId, data: row, gotoTo: row.gotoTo).
2. Edge anchoring, mirroring fsTree.anchorId (~line 377): when an endpoint file is expanded, that end of the SpecEdge becomes the contributing import ROW id instead of the file id, so hover and selection light exactly one line. IMPORTANT: elk knows nothing about rows -- toElkGraphInput must keep using the FILE node ids for its edge sources/targets, or the worker will fail with an unresolved shape reference (the same class of crash tic-56b2 hit). Keep a per-edge map of {elkSource, elkTarget} and, after the elk result comes back, patch the first and last point of that edges polyline onto the anchored rows centre. Everything downstream (reproject on drag, marching ants, culling) already works off the polyline and the from/to ids.
3. When params.mergeLines is on, skip the row re-anchoring entirely and leave every edge anchored to its file node -- the shared trunk is the intended read (explicit user decision).
4. measure(): an expanded file sizes to layoutContainer(rows) from fileDetail.ts; a collapsed one keeps the current FILE_CHIP sizing. Rows themselves get a zero-width, row-height entry as fsTree.measure does -- they are placed by layout, not by the graph algorithm.
5. layout(): after the elk rect for a container is known, place its rows at container-relative offsets from layoutContainer, exactly as fsTree.layout does. The cache key already folds in sizes thanks to tic-531b, so an expansion correctly misses the cache and re-runs elk.
6. style(): give rows and section headers the fs-tree treatment (draggable: false on rows and sections, kind-coloured accent, muted external-import rows); an expanded container uses THEME.surface2 like fs-trees.

WORK outside the mode
7. web/src/App.tsx: wantsRegistry is gated on modeId === "fs-tree" (~line 184), so external-import rows would render empty in Import graph. Widen it to any mode with an open expansion.
8. Check the HUD Collapse All / Expand All (web/src/canvas/Workspace.tsx collapseTargets / expandTargets): collapseTargets already picks up non-dir: expanded ids, so Collapse All will fold import-graph containers; expandTargets is dir:-only, so Expand All stays inert here. Confirm both buttons enable and disable sensibly in this mode rather than misbehaving; note whatever you decide in the ticket.

Verification: cd web && npm run test -- extend modes/importGraph.test.ts: expanded spec shape, Imported By emitted above Imports, edges anchored to rows when expanded and to files when collapsed, anchoring skipped under mergeLines, container sizing, cache key changes when an expansion changes sizes. npm run build. npm run dev: double-click a file in Import graph, confirm the container shows Imported By then Imports then the symbol sections, that the VS Code and goto buttons work on rows, that hovering one import row lights exactly one line while hovering the container lights all of them, and that the mergeLines checkbox still behaves. Re-check Files and symbols for regressions.

## Notes
