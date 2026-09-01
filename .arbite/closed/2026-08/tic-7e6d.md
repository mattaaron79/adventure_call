---
id: tic-7e6d
title: 'New VizMode: import-relationship graph (files-only, elk-layered)'
status: closed
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
assignee: claude.sonnet.001
depends_on:
- tic-e82b
blocked_by: null
created: '2026-08-31T16:36:21'
updated: '2026-08-31T17:13:59'
closed: '2026-08-31T17:13:59'
---

## Description
Implements tic-5f52's import-relationship graph mode. Design decisions resolved with user 2026-08-31 (see tic-5f52 notes): node = files only, not symbols; no folder/directory grouping shapes -- pure import topology; edges point importer -> imported, with importers ranked above what they import; the 127 external modules (deriveExternalImports) are excluded for v1; whole graph renders at once (322 edges / 191 nodes), no focus-scope constraint; CALLS edges (2402) are explicitly out of scope for this mode. Implement VizMode<P> (web/src/modes/types.ts, four phases select/measure/layout/style) at a new file e.g. web/src/modes/importGraph.ts, using web/src/modes/fsTree.ts as the structural reference implementation: select() builds one SpecNode per file from Workspace.tree and one SpecEdge per entry in Workspace.fileImports (FileImportEdge[] from deriveFileImports in web/src/data/derive.ts, ~lines 191-231, shape {source,target,count,symbolIds}) -- no external-import nodes, no folder nodes; measure() sizes file chips, reusing fsTree.ts's file-chip sizing approach; layout() calls the worker-based elk layout runner from tic-e82b instead of layoutTree from web/src/layout/tidyTree.ts; style() sets file node fill/stroke/accent and import-edge styling, no dir-chip styles needed. Register the mode with one new entry in MODES in web/src/modes/registry.ts. Verification: cd web && npm run dev, switch to the new mode via ModePicker, confirm ~191 file nodes and up to 322 edges render without node overlap, arrows point importer to imported, importers rank above dependencies. Also run npm run build (typecheck) and npm run test.

## Notes
- 2026-08-31T16:54:06 claude.sonnet.001: Depends-on tic-e82b is now closed. Layout infra lives at web/src/layout/{elkTypes,elkConvert,elkGraph}.ts -- layoutGraph(graph, options?): Promise<ElkGraphResult>. IMPORTANT: VizMode.layout() (modes/types.ts) is a synchronous phase, called inside a synchronous useMemo in App.tsx (App.tsx:120-123), but layoutGraph() is necessarily async (real worker round-trip). This mode's layout() cannot simply await it. Needed: a cache-and-recompute bridge -- e.g. layout() synchronously checks an in-memory cache keyed by a stable hash of the scene spec/params; on a cache hit, return the cached Positioned; on a miss, kick off layoutGraph() in the background (fire-and-forget from layout()'s perspective), return a reasonable synchronous fallback in the meantime (previous rects, or an empty/loading result), and when the promise resolves, store the result in the cache and trigger a re-render (e.g. bump a version counter in zustand state, per web/src/state/store.ts's existing pattern) so useMemo reruns and hits the now-warm cache. Direction is already set importer-above-imported (elk.direction=DOWN) inside toElkNode, so this mode's edges (source=importer, target=imported) don't need any direction handling of their own.

- 2026-08-31T17:13:56 claude.sonnet.001: Implemented and browser-verified. New files: web/src/modes/{importGraph,importGraph.test,asyncLayout}.ts. Registered in web/src/modes/registry.ts (MODES now [fsTreeMode, importGraphMode]). select() emits one file-role SpecNode per file (from Workspace.tree via walkFiles) and one directional import SpecEdge per Workspace.fileImports entry (from=importer, to=imported); no dir/row/group nodes, no external-import nodes, matching the resolved decisions. measure() sizes file chips by label length (120-260px wide, 40px tall). style() gives every file the module kind colour and every import edge a muted 0.45-opacity stroke. Async bridge: layout() cannot await tic-e82b's layoutGraph() since VizMode.layout is synchronous, so it uses a single-slot content-keyed cache (cacheKeyOf, exported and unit-tested) -- cache hit returns synchronously, cache miss kicks off layoutGraph() in the background and returns an empty Positioned, and the promise's resolution calls the new web/src/modes/asyncLayout.ts's notifyLayoutReady(). App.tsx now subscribes to that via useSyncExternalStore (getLayoutVersion/subscribeLayoutReady) and includes the version in the renderMode useMemo's deps, so the resolved layout triggers a second, cache-hit layout() call and the graph pops in. asyncLayout.ts is deliberately outside the zustand store -- it's a ping, not durable per-mode state. 20 new unit tests (14 in importGraph.test.ts covering select/measure/style/cacheKeyOf/toElkGraphInput, plus the existing elkConvert suite) -- all pure; layout()'s async orchestration and the worker itself aren't unit tested (same reasoning as tic-e82b), but were verified for real. Browser-verified end to end with Playwright against the actual /out dataset (189 files, dev server on :5175): switched ModePicker to 'Import graph', HUD read '176 nodes / 235 edges' matching the sidebar's Files shown/File imports stats, zero console errors, Fit-to-content showed a clean layered layout with no node overlap. fs-tree mode re-verified unaffected (regression check, same session). tsc -b clean, 359/359 tests pass (up from 345), production build clean, no new warnings. tic-56b2 (SCC cycle highlighting) can now be picked up -- it depends on this ticket's style() phase and cacheKeyOf/spec shape, both stable.
