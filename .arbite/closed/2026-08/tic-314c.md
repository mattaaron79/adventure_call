---
id: tic-314c
title: Surface external/third-party imports from the registry
status: closed
type: feature
tier: medium
domain: ui
epic: viz-workspace
priority: 3
tags:
- imports
- external
- derive
- registry
assignee: code
depends_on: []
blocked_by: null
created: '2026-08-30T18:46:09'
updated: '2026-08-30T20:06:54'
closed: '2026-08-30T20:06:54'
---

## Description
Third-party and stdlib imports (collections.abc, typing, pathlib, rich.console, pytest, ...) are missing from the UI. They are ALREADY IN THE DATA -- no parser work is required.

WHERE THEY LIVE
symbol_registry.json carries every import in modules[*].imports (module, alias, target_module, target_symbol, is_relative, level, is_wildcard, line, target). codebase_graph.json keeps only RESOLVED INTERNAL IMPORTS edges, which is why nothing external reaches the canvas today. Verified against the current out/: 127 distinct external modules, collections.abc included.

CLASSIFICATION -- do not use a first-segment heuristic. It wrongly buckets both ways: 'carnot.kernel.types' is the analysed project imported as an installed package (90 occurrences), and 'test_tui' / 'reverse_text' are local modules that simply did not resolve. Classify an import as external when its target does not resolve to a known symbol or module in the graph index. registry.bindings already labels entries with kind: 'external' -- prefer that where it is available and fall back to index lookup.

WORK
1. src/data/load.ts already memoises the registry lazily. Extend deriveWorkspace (src/data/derive.ts) with an optional import-detail layer that is populated once the registry arrives, so startup stays on codebase_graph.json alone and the canvas simply gains detail when the registry lands.
2. Show external imports in the expanded file container's Imports section (src/modes/fsTree.ts) and in the inspector, visually distinct from internal ones -- a muted or dashed treatment reads best against the resolved ones.
3. They link to nothing for now, by design. No placeholder nodes on the canvas, no edges. Just make them visible.
4. Group repeats sensibly (many files import typing) so the sections stay readable.

EXIT: opening a file that imports collections.abc shows it in the Imports section, marked external; internal imports keep their current appearance and behaviour; the app still starts without fetching symbol_registry.json.

## Notes
- 2026-08-30T20:06:51 code: Implemented lazy external-import layer. derive.ts: deriveExternalImports classifies via registry.bindings kind 'external' with index-lookup fallback (no first-segment heuristic); deriveWorkspace takes optional registry param, workspace gains externalImports (empty at boot). App loads registry lazily on first expanded file or selection. fsTree.ts: expanded Imports section renders external rows muted (textFaint stroke/accent), linkless (symbolId null), grouped with count. Inspector.tsx: External imports section (muted css). derive.test.ts + fsTree.test.ts extended. Tests: 196 pass; build (tsc -b && vite build) passes.
