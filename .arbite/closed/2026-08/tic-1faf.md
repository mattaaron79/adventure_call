---
id: tic-1faf
title: 'Mode 1 ''fs-tree'': tiered folder/file spatial graph with expandable file
  containers'
status: closed
type: feature
tier: high
domain: ui
epic: viz-workspace
priority: 5
tags:
- frontend
- mode
- fs-tree
assignee: zoo.glm
depends_on:
- tic-cdeb
- tic-3399
blocked_by: null
created: '2026-08-30T11:54:18'
updated: '2026-08-30T16:51:18'
closed: '2026-08-30T16:51:18'
---

## Description
The first visualization mode.

- Collapsed file: compact chip (kind icon, filename, symbol count).
- Expanded file: a container laid out as header + sections -- Imports, Classes (with methods and attributes nested inside), Functions, Variables.
  * CRITICAL forward-compat: every row is an individually hit-testable element carrying its own symbol id, and its rect is written back into the layout result. The next phase's import/call lines anchor to the FILE when collapsed and to the SPECIFIC SUB-ITEM when expanded -- this must need no re-architecture.
- Click a file toggles expand/collapse -> re-measure -> re-layout, animated with a konva position tween (~200ms). Directories are collapsible too.
- Nesting lines between parent directory and its children (elbow connectors from tic-cdeb).
- Inspector panel on selection: signature, docstring, params, bases, decorators, and source (lazy-loads symbol_registry.json for the code field).
- Noise filter on by default (.pytest_tmp, scratch, __pycache__) with a sidebar toggle that re-layouts.

EXIT: the full target tree renders legibly and uncluttered; expansion works; verified against raw JSON for a known file (e.g. src/carnot/agent/loop.py: 8 symbols, Agent class with 6 methods).

## Notes
- 2026-08-30T16:51:10 zoo.glm: Mode 1 fs-tree landed. web/src/modes/fsTree.ts is a pure scene builder: fsTreeScene(workspace, expanded) -> { scene, rects, symbolOfRow, expandable }. Collapsed files are chips (name + symbol count); expanded files are containers laid out as header + sections (Imports, Classes with methods and attributes nested and indented, Functions, Variables). Forward-compat as specified: every row is an individually hit-testable SceneNode (draggable false) carrying its own symbol id via symbolOfRow, and every row rect is written into the rects map keyed row:<path>:<symbolId> (import rows row:<path>:imp:<symbolId>); import lines anchor to the file chip when collapsed and to the specific contributing sub-item row once expanded -- no re-architecture needed for the next phase. Directories are chips too (file count), collapsible, with elbow nesting lines to their children and a translucent group box behind each expanded subtree (both from tic-cdeb). Click detection added to Workspace (pointerdown/up within 5px slop -> onActivate prop) and App toggles expanded for ids in expandable; re-layout animates via a 200ms Konva position tween in NodeChip (position now owned imperatively so react-konva cannot teleport nodes; drags unaffected). Inspector panel (ui/Inspector.tsx, overlay bottom-right) shows kind, path:line, signature, docstring, params, bases, decorators, and source lazy-loaded from symbol_registry.json via loadRegistry. Noise toggle in the sidebar lifts the built-in patterns (.pytest_tmp/scratch/__pycache__) without touching the persisted user list; toggling re-derives and re-layouts. placeholderScene is no longer used by App (left in place with its tests for tic-83ec to retire). Tests: 13 new in modes/fsTree.test.ts over a synthetic 3-file corpus (sections order incl. nested children, rows inside container bounds, row anchoring of import edges, collapsed-dir hiding, determinism). EXIT verified headlessly against the real ../out export with a throwaway test (not committed): full tree lays out with zero overlap across 171 files, and src/carnot/agent/loop.py expands to Agent with 6 methods plus 2 attributes (11 nodes total -- the ticket's 8-symbol figure predates tic-88dd's attributes), every row carrying a rect. Full suite 116/116 green; tsc -b and vite build clean.
