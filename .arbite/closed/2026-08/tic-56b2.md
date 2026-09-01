---
id: tic-56b2
title: Highlight import cycles (SCCs) in import-graph mode
status: closed
type: feature
tier: high
domain: ui
epic: viz-modes-next
priority: 10
tags:
- cycles
- scc
- imports
assignee: claude.sonnet.001
depends_on:
- tic-7e6d
blocked_by: null
created: '2026-08-31T16:36:28'
updated: '2026-08-31T18:49:19'
closed: '2026-08-31T18:49:19'
---

## Description
Serves tic-5f52's stated motivation that import cycles are 'worth SEEING' (decided with user 2026-08-31 to highlight SCCs rather than leave layout to do what it does -- see tic-5f52 notes). Compute strongly-connected components over Workspace.fileImports (standard algorithm, e.g. Tarjan's), likely as a new derive function alongside deriveFileImports in web/src/data/derive.ts, computed once per Workspace and exposed similarly to fileImports/externalImports. In the import-graph mode's style() phase (tic-7e6d), visually distinguish nodes/edges belonging to a multi-node SCC -- distinct border/fill or edge treatment -- from acyclic ones. Verification: find or construct a known cyclic import pair in the current codebase export (or a small test fixture) and confirm it renders visually distinct from acyclic edges; run npm run test.

## Notes
- 2026-08-31T18:49:02 claude.sonnet.001: Implemented and browser-verified against the real cycle in this codebase (kernel/{scope,capability,registry,loader,plugin,commands}.py + agent/{session,loop}.py, an 8-file mutual import cycle). New: deriveStronglyConnectedComponents in web/src/data/derive.ts -- iterative Tarjan's (explicit work stack, not recursion -- file counts can run into the thousands), returns {componentOf: Map<file,componentId>, cyclic: Set<componentId>}. Wired into Workspace.importCycles, computed once in deriveWorkspace alongside fileImports. modes/types.ts: added optional SpecEdge.data (mirrors SpecNode.data) so a mode can carry mode-private per-edge payload to style() without repurposing kind -- kept edge.kind='import' uniform for cyclic and acyclic edges on purpose, so cross-mode machinery keyed on kind (selection-highlight incidence, marching ants) still treats every import edge as an import. importGraph.ts: select() flags each file/edge's data.inCycle (edge only counts when both endpoints share the same cyclic component -- a feeder edge into/out of a cycle doesn't qualify); style() gives cyclic nodes/edges the new THEME.cycle colour (canvas/theme.ts, a pink-red, the one warm colour against the palette) with a bolder/less-transparent edge stroke. 33 new unit tests: deriveStronglyConnectedComponents (chain/2-cycle/3-cycle/feeder-not-merged/disjoint-cycles/2000-node-no-stack-overflow/memoisation) and importGraph cycle-highlighting (flags right members, not the feeder, distinct node/edge styles, kind stays 'import'). Found and fixed a real bug during browser verification, unrelated to cycles per se: select() blindly mapped every Workspace.fileImports entry to an edge, but deriveWorkspace's file-query filtering keeps every module node in the symbol index regardless of query (only non-module symbols get query-filtered), so a whole-module import can resolve to a file the query dropped from  -- elk crashed ('Referenced shape does not exist') on the resulting dangling edge reference. Fixed by filtering fileImports to edges where both endpoints are in the current visible file set before building elk input, mirroring a guard fs-tree's select() already had for the same underlying gap. Added a regression test reproducing it with a real query-scoped deriveWorkspace. Also hit and ruled out a false alarm while visually verifying: a Playwright screenshot showed one cycle node with what looked like a grey (not pink) border -- turned out to be THEME.hovered overriding the node's own stroke because the test's mouse cursor was sitting on top of that exact node after a wheel-zoom; moving the cursor off-canvas before the screenshot showed the correct pink border and accent bar. tsc -b clean, 373/373 tests pass (up from 359), production build unaffected (no new deps, no new worker chunk -- this ticket is pure application logic on top of tic-e82b/tic-7e6d's infra).

- 2026-08-31T18:49:16 claude.sonnet.001: Correction to the previous note: a shell quoting mishap stripped backtick-quoted "tree" out of one sentence. It should read: "...so a whole-module import can resolve to a file the query dropped from the tree -- elk crashed...". No code or test impact, just a typo in the note.
