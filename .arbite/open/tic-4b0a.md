---
id: tic-4b0a
title: 'Inspector: wider panel, vscode:// deep link, import list with goto'
status: open
type: feature
tier: medium
domain: ui
epic: viz-workspace
priority: 4
tags:
- inspector
- ui
- vscode
- imports
assignee: null
depends_on:
- tic-bee0
blocked_by: null
created: '2026-08-30T18:46:18'
updated: '2026-08-30T18:46:18'
closed: null
---

## Description
Build out the bottom-right detail panel (src/ui/Inspector.tsx).

WORK
1. About 50% wider than today, with the source block and long signatures still wrapping or scrolling cleanly rather than pushing the panel wider. Check it against a deeply nested path and a long generic signature.
2. The file path line becomes a link that opens the file in VS Code at the right line: vscode://file/<absolute-path>:<line>:1. The absolute path is the graph root joined to file_path -- graph.graph.root is a RELATIVE path as generated ('../carnot' in the current export), so it cannot be resolved in the browser. Have the dev server resolve and expose the absolute root (extend web/plugins/outData.ts, which already knows the out dir) rather than guessing client-side. Degrade to plain non-link text when no absolute root is available.
3. An Imports section listing what the selected file imports, each row with the goto icon from tic-bee0 to centre the camera on the imported target. Internal targets go to that symbol or its file; external targets (tic-<external-imports>) have no target and show no goto.
4. Richer detail generally: kind, module, line range, async flag, param defaults and annotations, bases, decorators, and for a file its module docstring and symbol counts by kind.

EXIT: the panel is wider without overflowing, the path opens the correct file and line in VS Code, and import rows fly the camera to their target.

## Notes
