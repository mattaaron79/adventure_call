---
id: tic-a8a6
title: 'Call-graph derive layer: CALLS adjacency and SCC condensation into a DAG'
status: open
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 3
tags:
- call-graph
- scc
- derive
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-01T07:22:26'
updated: '2026-09-01T07:22:26'
closed: null
---

## Description
Foundation for mode 3 (call flow). Pure derive-layer work over the existing export -- no parser changes, no new data.

Build, in web/src/data/derive.ts alongside deriveFileImports, a call-graph derivation over the CALLS edges already in codebase_graph.json: adjacency in both directions keyed by symbol id, restricted to callable nodes (kind function|method), with each edge carrying the `count`, `lines`, `confidence` and `call_types` the exporter already merges onto it.

Then condense it. The key structural fact this whole mode rests on: a raw call graph is not a DAG (recursion, mutual recursion) and so cannot be layered, but its condensation -- every strongly-connected component collapsed to a single node -- always is. Reuse deriveStronglyConnectedComponents (the iterative Tarjan's written for tic-56b2, already in this file and already proven on thousands of nodes) by pointing it at call adjacency instead of fileImports. Expose: the adjacency maps, componentOf/cyclic as that function already returns, and the condensed DAG itself (component id -> component ids it calls), plus per-component membership so a cluster can be opened.

Self-recursion needs care: Tarjan's returns a single-member component for a self-loop, so a `recursive` flag has to come from checking the self-edge explicitly rather than from component size. Both cases -- self-recursive and mutually-recursive -- must be distinguishable, because they read very differently to a human.

Memoise per Workspace the way fileImports and importCycles already are, and hang it off Workspace so the mode reads it rather than recomputing.

Verification: unit tests covering a straight chain, direct self-recursion, a 2-cycle, a 3-cycle, a feeder edge into a cycle that must NOT be absorbed into it, disjoint cycles, and a condensation that is verified acyclic. Confirm against the real ./out export that the condensed graph is a DAG and report the component-count/largest-component numbers in the ticket notes -- those numbers decide whether the mode's layout is viable at all. Run npm run test and tsc -b.

## Notes
