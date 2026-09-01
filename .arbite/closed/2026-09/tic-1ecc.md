---
id: tic-1ecc
title: 'Per-function call-graph metrics: rank, reach, shape, test-only, resolution
  coverage'
status: closed
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 4
tags:
- call-graph
- metrics
- derive
assignee: claude.opus.001
depends_on:
- tic-a8a6
- tic-22db
blocked_by: null
created: '2026-09-01T07:23:46'
updated: '2026-09-01T09:58:07'
closed: '2026-09-01T09:58:07'
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
- 2026-09-01T09:58:07 claude.opus.001: Implemented and measured against the real ./out export (../carnot).

New web/src/data/callMetrics.ts: `deriveCallMetrics(callGraph, index, entryPoints, registry?)`, memoised per (callGraph, entryPoints, registry). Returns `metricOf` plus the thresholds it used and `maxRank`. Also exported `isTestPath` from roles.ts rather than growing a second test-path regex that could drift from the one tic-22db's rules already use.

Every traversal runs over the condensed DAG, as specified, and both walks exploit tic-a8a6's documented id ordering (component ids ascend in reverse topological order): one pass 0..N computes reachDown with every callee already done, one pass N..0 does reachUp. No topological sort, no recursion, no memo-miss. The comment at that spot says explicitly that a non-null assertion there is load-bearing on the ordering property derive.test.ts pins -- so if that invariant ever breaks it throws rather than silently returning a number that is too small.

DECISIONS THE TICKET ASKED ME TO MAKE:

- Unreachable node's rank is `null`, not a sentinel number. "No entry reaches this" is not a large distance, and a number would let it land silently at one end of any sort; null forces the consumer to place it deliberately. On the real export the 169 unreachable nodes are exactly tic-22db's 169 orphans, which is the right correspondence.
- `shape` thresholds are DERIVED, not constant: the 90th percentile of this codebase's own fan-in and fan-out, floored at 3. The two distributions are not alike and neither is portable -- on ../carnot fan-in runs to 67 with a long tail while fan-out tops out at 13 -- so a constant tuned here would mislabel the next project. Both thresholds are exposed on the result so a UI can explain what it means by "hub" instead of asserting it.
- `testOnly` is FALSE for a function with no callers, not vacuously true. "Nothing calls this" is tic-22db's job and it says it better; reporting it here as test-only would dress a vacuous truth up as a finding.

MEASURED (2574 nodes, 29.4 ms for the whole thing):
- rank: maxRank is only 5. Distribution 1491 / 578 / 217 / 83 / 27 / 9. The call graph is extremely shallow and wide, which is worth knowing before tic-d8a8 designs a layered layout -- the layers exist but there are only six of them, and 58% of nodes sit in layer 0 because they are entry points.
- thresholds came out highFanIn 3, highFanOut 3 (p90 of both).
- shapes: leaf 972, plain 928, orchestrator 412, facade 123, pipe 104, hub 35.
- testOnly: 177.
- coverage overall: 4181/10389 call sites = 40.2%.
- top reachUp is a good sanity check that it works: ConfigError 283, Cursor 270, Transcript.__init__ 268, Transcript 267, GrantError 260, Grant 257 -- i.e. the core types everything depends on, which is exactly what "who breaks if this breaks" should surface. (Transcript.__init__ scoring exactly one higher than Transcript is the tic-a8a6 implicit edge behaving correctly.)
- top reachDown is dominated by test functions (117, 98, ...), which also makes sense: a test drives a deep path through the system.

FINDING THAT tic-d8a8 AND tic-171f MUST NOT IGNORE: `leaf` is mostly a lie on this data. 972 nodes have no resolved callees, but 718 of them (74%) DO have unresolved call sites -- they are opaque, not terminal. A mode that draws them as endpoints without the coverage figure beside them is asserting something false about three quarters of its leaves. I deliberately did NOT add an `opaque` shape: shape is registry-free by design so it is available at startup, and a shape that silently changes when the registry finishes loading would be worse than one that needs reading alongside a second number. The CallShape docstring says this at length, with the measured numbers, so it cannot be missed by whoever styles leaves.

Tests: 27 new (530 -> 557, 28 files). Per the ticket's list: reach through a cyclic component (both members equal, and equal to the component's), rank with multiple entries (nearest wins), unreachable node (null, documented), plus a diamond counted once rather than twice, rank shared across a cyclic component, every shape variant, threshold floor, testOnly's three cases including the no-callers one, coverage with and without a registry, the all-unresolved "opaque leaf" shape, the implicit class -> __init__ edge NOT counting as a resolved call site, a 2000-node chain, and memoisation across all three cache keys. tsc -b clean, production build fine, no new dependencies.

Not wired onto Workspace, deliberately and consistently with tic-22db: both depend on inputs the workspace cache is not keyed on (the user's role rules here, the lazily-fetched registry), so eagerly computing them in deriveWorkspace would either produce stale results or force those inputs into the workspace cache key. Consumers call deriveCallMetrics directly; it is memoised on its own inputs.
