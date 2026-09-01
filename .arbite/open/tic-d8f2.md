---
id: tic-d8f2
title: Dominator-based chokepoints on the condensed call DAG
status: open
type: feature
tier: high
domain: ui
epic: call-flow
priority: 9
tags:
- call-flow
- dominators
- analysis
assignee: null
depends_on:
- tic-a8a6
- tic-22db
blocked_by: null
created: '2026-09-01T07:26:00'
updated: '2026-09-01T07:26:00'
closed: null
---

## Description
"Everything downstream of here goes through this function" -- the load-bearing walls of the codebase.

Compute the dominator tree of tic-a8a6's condensed DAG rooted at tic-22db's entry set (a synthetic super-root over all entries, since there is no single entry). A node X dominates Y when every path from an entry to Y passes through X, so X's dominated subtree is exactly the region that becomes unreachable if X is removed. That is the honest form of "chokepoint" -- strictly better than the fan-in/fan-out heuristics in tic-1ecc, which only guess at it.

Use a standard algorithm -- iterative Cooper-Harvey-Kennedy is simple, fast enough at this size, and much easier to get right than Lengauer-Tarjan. Work over the condensed DAG, never the raw graph.

Two things fall out, both worth surfacing: the dominator subtree SIZE per function (a ranking of load-bearing-ness), and the immediate dominator, which gives "the last thing that must happen before this can".

Caveat to carry into the UI: dominance is computed over the RESOLVED call graph. An unresolved or dynamic call into the middle of a dominated region would break the claim, and with ../carnot resolving ~39% of call sites that is not hypothetical. Phrase results as "in the resolved call graph, everything reaching X goes through Y" and let tic-171f's coverage figures sit next to it.

Verification: unit tests on synthetic graphs with hand-computed dominator trees -- a diamond (the join point dominates nothing above it), a chain, multiple entries, and an unreachable node. Against ../carnot, report the top ten by dominated-subtree size and sanity-check that they are plausible. npm run test, tsc -b.

## Notes
