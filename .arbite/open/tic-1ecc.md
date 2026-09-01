---
id: tic-1ecc
title: 'Per-function call-graph metrics: rank, reach, shape, test-only, resolution
  coverage'
status: open
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 4
tags:
- call-graph
- metrics
- derive
assignee: null
depends_on:
- tic-a8a6
- tic-22db
blocked_by: null
created: '2026-09-01T07:23:46'
updated: '2026-09-01T09:34:27'
closed: null
---

## Description
The numbers the call-flow mode styles and sorts by, and the ones an LLM summariser will eventually read. All computed from tic-a8a6's condensed DAG plus the existing export -- no new extraction.

Per callable:
- `rank` / depth: layers from the nearest entry point over the condensed DAG. This is the 1D reading of the call graph the user asked about, and it is real: a low-rank utility calling a high-rank orchestrator is an architectural inversion worth surfacing later.
- `reachDown`: size of the forward transitive closure -- blast radius, "what does calling this set in motion".
- `reachUp`: size of the backward closure -- "who is affected if I break this". This is the number people actually want.
- `shape` from fan-in/fan-out: facade (many in, few out), orchestrator (few in, many out), pipe (1-in 1-out, an inlining candidate), hub (many both), leaf.
- `testOnly`: every in-project caller lives in a test file. Cheap, and good triage.
- `coverage`: how many of THIS function's call sites resolved, out of how many it has. Feeds tic-171f; the raw material is in the registry's unresolved_calls, keyed by caller_id.

Compute closures over the CONDENSED DAG, not the raw graph -- on the raw graph a cycle makes "reach" ill-defined and the memoisation unsound. Reach for a member of a cyclic component is the component's reach, and every member shares it; say so in the UI rather than pretending the members differ.

Performance: ~2500 callables and ~2900 CALLS edges today, so a memoised DFS over the DAG in reverse topological order is comfortably enough -- do that rather than anything clever, and note the measured time. Memoise per Workspace as the existing derivations do.

Verification: unit tests per metric on synthetic graphs, including reach through a cyclic component (all members equal), rank with multiple entry points (nearest wins), and an unreachable node (no entry reaches it -- decide and document what rank it gets). npm run test, tsc -b.

## Notes
