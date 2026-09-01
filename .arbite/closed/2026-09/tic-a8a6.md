---
id: tic-a8a6
title: 'Call-graph derive layer: CALLS adjacency and SCC condensation into a DAG'
status: closed
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 3
tags:
- call-graph
- scc
- derive
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-01T07:22:26'
updated: '2026-09-01T08:09:45'
closed: '2026-09-01T08:09:45'
---

## Description
Foundation for mode 3 (call flow). Pure derive-layer work over the existing export -- no parser changes, no new data.

Build, in web/src/data/derive.ts alongside deriveFileImports, a call-graph derivation over the CALLS edges already in codebase_graph.json: adjacency in both directions keyed by symbol id, restricted to callable nodes (kind function|method), with each edge carrying the `count`, `lines`, `confidence` and `call_types` the exporter already merges onto it.

Then condense it. The key structural fact this whole mode rests on: a raw call graph is not a DAG (recursion, mutual recursion) and so cannot be layered, but its condensation -- every strongly-connected component collapsed to a single node -- always is. Reuse deriveStronglyConnectedComponents (the iterative Tarjan's written for tic-56b2, already in this file and already proven on thousands of nodes) by pointing it at call adjacency instead of fileImports. Expose: the adjacency maps, componentOf/cyclic as that function already returns, and the condensed DAG itself (component id -> component ids it calls), plus per-component membership so a cluster can be opened.

Self-recursion needs care: Tarjan's returns a single-member component for a self-loop, so a `recursive` flag has to come from checking the self-edge explicitly rather than from component size. Both cases -- self-recursive and mutually-recursive -- must be distinguishable, because they read very differently to a human.

Memoise per Workspace the way fileImports and importCycles already are, and hang it off Workspace so the mode reads it rather than recomputing.

Verification: unit tests covering a straight chain, direct self-recursion, a 2-cycle, a 3-cycle, a feeder edge into a cycle that must NOT be absorbed into it, disjoint cycles, and a condensation that is verified acyclic. Confirm against the real ./out export that the condensed graph is a DAG and report the component-count/largest-component numbers in the ticket notes -- those numbers decide whether the mode's layout is viable at all. Run npm run test and tsc -b.

## Notes
- 2026-09-01T08:09:44 claude.opus.001: Implemented and measured against the real ./out export (../carnot, regenerated post-tic-9ff4).

New in web/src/data/derive.ts: `stronglyConnectedComponents(adjacency)` -- tic-56b2's iterative Tarjan's split out of `deriveStronglyConnectedComponents`, which now builds its adjacency and delegates, keeping its signature, memoisation and behaviour unchanged. Then `deriveCallGraph(edges, index)`, memoised per (edges, index) like the other derivations, exposing nodes / callees / callers / componentOf / cyclic / members / recursive / condensed, and hung off `Workspace.callGraph`.

DEVIATION FROM THE TICKET, agreed to be the right call after measuring: the ticket said restrict nodes to kind function|method. That is wrong, and the data says so -- 635 of 3449 CALLS edges (18%) TARGET a class, because the exporter resolves `Foo()` to the class symbol, and another 38 come FROM a class body. Restricting to function|method would have silently deleted every constructor call from a mode whose whole premise is not lying about what it cannot see. So classes are nodes here (and only here -- the rest of the app still treats them as containers), but only by TAKING PART in a call: a class nobody constructs stays out, or all 223 of them would drown tic-22db's orphan analysis. Where a constructed class has an in-project `__init__`, a derived `class -> __init__` edge (CallEdge.implicit, count 0, no lines) carries the flow onward; without it `__init__` would read as an entry point. Only 27 of 96 constructed classes have one -- the rest are dataclasses, exception and framework subclasses whose `__init__` genuinely is not in this codebase, and for those the class is honestly a leaf.

Two properties of Tarjan's are now documented as load-bearing, because later tickets lean on them: every adjacency key lands in componentOf (so isolated nodes survive as components of one, which is what keeps orphans findable), and component ids come out in REVERSE TOPOLOGICAL ORDER -- for any cross-component edge, id(target) < id(source). That hands tic-1ecc a topological order for free, and it is itself the acyclicity proof, so the tests check the DAG property by asserting every condensed edge descends in id rather than by running a second cycle search.

MEASURED against the real export (2574 nodes, 3476 edges, 27 of them derived):
- derive time 8.6 ms; no performance concern at this size.
- components 2573, largest component 2, condensation is a DAG with 0 back-edges.
- exactly ONE cyclic component in the whole codebase: src.carnot.audit._Scan._block <-> ._statement, hand-verified in the source (a recursive-descent AST walker -- _block calls _statement at audit.py:326, _statement calls _block at 335/338/360). Correct.
- 11 self-recursive functions, none of them in a cyclic component, which is exactly why `recursive` is tracked separately from `cyclic`.

TWO FINDINGS THE NEXT TICKETS NEED:

1. Layout viability (the question this ticket was asked to answer): the call graph is already very nearly a DAG. Largest component 2 means SCC condensation buys almost nothing structurally on this codebase -- it is still worth having, because it is what makes the mode CORRECT on a codebase that does recurse mutually, but tic-d8a8 should not expect condensation to reduce the picture. 2574 nodes and 3476 edges is the real layout problem, and it is a size problem, not a cycle problem.

2. In-degree zero is nearly useless as an entry-point signal here, and tic-22db must not be built on it alone: 1660 of 2574 nodes (64%) have NO callers at all, and 525 have no edges whatsoever. Breakdown: 1225 of those are in test files, 435 are not, and 133 carry a decorator. Two causes, both worth separating in tic-22db -- pytest-called test functions (a framework role, exactly what the decorator/role map is for) and, for the rest, call sites that simply did not resolve. This is tic-171f's coverage problem showing up as a structural artefact, and it is the strongest argument yet that the coverage ticket cannot be deferred.

Tests: 19 new (481 -> 500, 25 files), covering the ticket's list -- chain, self-recursion (asserting it is NOT flagged cyclic), 2-cycle, 3-cycle, feeder-not-absorbed, disjoint cycles, condensation acyclic -- plus edge payload passthrough, reverse-topological ordering, orphan retention, dangling-endpoint drop (the tic-56b2 elk crash shape), IMPORTS ignored, the five class cases, a 2000-node chain, memoisation, and the Workspace exposure. tsc -b clean, production build fine, no new dependencies.

Two notes for the record. (a) web/src/data/derive.ts contains a literal NUL byte at line 213 -- a map-key separator written raw rather than as an escape -- which makes git and grep treat the file as binary; filed separately, not touched here. (b) I briefly ran `npx prettier` on two files, which is NOT a project dependency and reformatted them to its own defaults (semicolons, double quotes) against the repo's actual style; reverted and the edits reapplied by hand, so the final diff is minimal -- 4 added lines in Inspector.test.ts and nothing incidental in derive.ts.
