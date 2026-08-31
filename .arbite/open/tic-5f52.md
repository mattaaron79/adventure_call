---
id: tic-5f52
title: 'New mode: import-relationship graph instead of folder structure'
status: open
type: feature
tier: frontier
domain: ui
epic: viz-modes-next
priority: 9
tags:
- mode
- imports
- graph-layout
- elk
- design-questions
assignee: null
depends_on: []
blocked_by: null
created: '2026-08-30T20:58:23'
updated: '2026-08-30T20:58:23'
closed: null
---

## Description
NOT FOR THE ORCHESTRATOR -- filed to wishlist/. There ARE questions to resolve first; they are listed below.

A second VizMode where position is driven by IMPORT relationships rather than directory nesting. The interface from tic-83ec (select/measure/layout/style) is already the seam for this, and the registry makes it switchable; the fs-tree mode is the reference implementation.

WHAT ALREADY EXISTS
- 322 resolved internal IMPORTS edges over 191 files in the current export, plus file->file edges already derived in src/data/derive.ts (deriveFileImports, which keeps the contributing symbol ids so edges can anchor to a file when collapsed or to a row when expanded).
- 127 distinct EXTERNAL modules surfaced by tic-314c, currently shown but linked to nothing.

WHY THIS IS NOT JUST ANOTHER TREE
The import graph is not a tree and is not guaranteed acyclic, so src/layout/tidyTree.ts does not apply. This needs a layered/hierarchical graph layout. The original plan already earmarked elkjs (its 'layered' algorithm, run in a web worker) for exactly this -- it also handles compound nodes with ports, which is what lets edges anchor to rows inside an expanded container. Confirm that choice before building; a force-directed layout is the alternative and gives a very different, less readable result for dependency structure.

OPEN QUESTIONS -- resolve with the user before implementing
1. What is a node? Files only, or symbols too (a file's rows becoming edge endpoints when expanded, as in fs-tree)? Files only is far more legible; symbols are more truthful.
2. Do folders still appear, as grouping shapes behind the laid-out files, or does directory structure disappear entirely in this mode?
3. Direction and rank: should importers sit above what they import, or below? Which way does the arrow point?
4. Do external modules (typing, pathlib, rich.console) become real nodes here, or stay excluded? They would add ~127 leaf nodes with high fan-in.
5. Cycles: import cycles are worth SEEING. Highlight strongly-connected components, or just let the layout do what it does?
6. Scope: whole graph at once, or does this mode lean on the focus scope (tic-e7d2) and show one subtree's imports at a time? 322 edges over 191 nodes is drawable; a symbol-level view would be far denser.
7. Does the existing CALLS edge set (2402 edges) belong in this mode too, or is that a third mode later?

## Notes
