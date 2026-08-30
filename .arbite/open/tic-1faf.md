---
id: tic-1faf
title: 'Mode 1 ''fs-tree'': tiered folder/file spatial graph with expandable file
  containers'
status: open
type: feature
tier: high
domain: ui
epic: viz-workspace
priority: 5
tags:
- frontend
- mode
- fs-tree
assignee: null
depends_on:
- tic-cdeb
- tic-3399
blocked_by: null
created: '2026-08-30T11:54:18'
updated: '2026-08-30T11:54:18'
closed: null
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
