---
id: tic-e82b
title: Add elkjs + web worker layout infrastructure
status: closed
type: feature
tier: high
domain: ui
epic: viz-modes-next
priority: 9
tags:
- elk
- worker
- layout-infra
assignee: claude.sonnet.001
depends_on: []
blocked_by: null
created: '2026-08-31T16:36:11'
updated: '2026-08-31T16:53:56'
closed: '2026-08-31T16:53:56'
---

## Description
Foundational layout infrastructure for tic-5f52's import-relationship graph mode. Add elkjs as a dependency (web/package.json currently lists only konva/react/react-dom/react-konva/zustand). Build the project's first web worker (Vite pattern: new Worker(new URL('./x.worker.ts', import.meta.url), {type: 'module'}) -- no .worker.ts or Worker() calls exist anywhere in the project yet) wrapping elk's 'layered' algorithm. Define a message contract: input = elk graph description (nodes with sizes, compound container nodes with ports so a future mode can anchor edges to rows inside an expanded file, edges with source/target); output = a position map plus edge routing points, shaped compatibly with the Positioned type consumed by VizMode.layout() in web/src/modes/types.ts. Configure elk so rank flows top-down with importers ranked above what they import (decided with user 2026-08-31, see tic-5f52 notes). Expose a promise-based async function that hides the worker's postMessage/onmessage plumbing so a mode's layout() phase can await it like any other call. Out of scope: the import-graph mode itself (separate ticket, depends on this one) and SCC/cycle detection (separate ticket after that). Reference: web/src/layout/tidyTree.ts is the existing tree-only layout engine, explicitly documented as 'swappable (elkjs later)' -- confirms this new module replaces it for non-tree graphs without touching tidyTree.ts itself.

## Notes
- 2026-08-31T16:53:53 claude.sonnet.001: Implemented: elkjs added (^0.12.0). web/src/layout/{elkTypes,elkConvert,elkGraph}.ts. Deviation from the plan text worth flagging: no hand-written elk.worker.ts message loop. elkjs already ships a complete, self-contained worker script (elk-worker.min.js) implementing the register/layout/error-conversion protocol; elk-api.js's thin ELK client just needs a workerFactory pointing a real Worker at it. Reinventing that protocol by hand would've been a worse copy of what elkjs already provides, so elkGraph.ts does 'new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url))' via workerFactory instead -- still a genuine dedicated Worker, still this project's first one, just backed by elkjs's own script rather than a custom .ts file. Verified end to end: production build (npm run build) correctly code-splits the algorithm into its own ~1.4MB chunk (elk-worker.min-*.js), separate from the ~510KB main bundle which only gains elk-api's thin client. Two other elkjs entry points are traps for this use case, documented in elkGraph.ts's header: bare 'elkjs' (main.js) and 'elkjs/lib/elk.bundled.js' both resolve to a Node-oriented wrapper that conditionally requires an uninstalled 'web-worker' polyfill, which Rollup flags as an unresolved external at build time -- elk-api.js avoids that wrapper entirely. Direction is set to elk.direction=DOWN (source/importer ranks above target/imported), matching tic-5f52's resolved convention. Pure conversion logic (toElkNode/fromElkResult) is unit-tested in elkConvert.test.ts (9 tests, no real algorithm run needed); the worker plumbing itself isn't unit-tested (needs a real browser Worker), but is build-verified. Important open item for tic-7e6d: VizMode.layout() (modes/types.ts) is a SYNCHRONOUS phase called inside a synchronous useMemo in App.tsx, but layoutGraph() here is necessarily async (Promise-based, worker round-trip). tic-7e6d's mode cannot just await layoutGraph() from inside layout() -- it needs its own cache-and-recompute bridge (kick off layoutGraph once per distinct scene, return a previous/empty result synchronously until it resolves, then trigger a re-render, e.g. via a version counter in zustand state, that picks up the cached result). This bridge is documented in elkGraph.ts's header comment but not built here -- it's tic-7e6d's responsibility. All tests pass (345/345), tsc -b clean, production build clean with no warnings related to this change.
