---
id: tic-13d7
title: 'READS/WRITES: a fourth edge type for module variables and class attributes'
status: open
type: feature
tier: frontier
domain: io
epic: call-flow
priority: 10
tags:
- parser
- resolver
- dataflow
- edges
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-01T07:26:38'
updated: '2026-09-01T07:26:38'
closed: null
---

## Description
The real answer to the user's "nearness to variables" question, decided with them 2026-09-01: it is an EDGE, not a relevancy score. If you can compute "what is affected when X changes", do not approximate it with a number.

Today the parser extracts assignment TARGETS (tic-82b0's module constants and class attributes -- 246 variables and 958 attributes in the ../carnot export) and call CALLEES, but never name REFERENCES. So the symbols exist with nothing pointing at them.

Add reference extraction, deliberately narrow: capture identifier and one-level attribute reads, then keep only those that RESOLVE to a known symbol -- a module-level variable, a class or instance attribute, or an imported name. Everything else is discarded rather than emitted as noise; an unresolved reference is worth nothing here and there will be a flood of them. Distinguish reads from writes (an assignment target is a write; augmented assignment is both).

Emit as a new EdgeType alongside CALLS/IMPORTS/CONTAINS, from the enclosing definition to the variable symbol, merged through GraphBuilder._merge_edge the way call edges already are. Bump SCHEMA_VERSION; mirror in web/src/data/types.ts.

The sleeper value is `self.x`. Attribute reads and writes couple methods of a class that never call each other -- a call graph is structurally blind to that, and this makes it visible. Expect that to be the most surprising thing the whole feature surfaces.

Scale warning, to be measured before committing to the shape: references are far more numerous than calls, and this could add more edges than the graph currently holds in total. Measure the edge-count and file-size delta on ../carnot early, and if it is unmanageable, consider emitting reads/writes into the registry per symbol rather than as graph edges. Report the numbers before building the UI on top.

Verification: parser and resolver tests for module-variable read, write, augmented assignment, class attribute, self.x read from a sibling method, an imported constant, and a local shadowing a module variable (must NOT produce an edge). Confirm ../carnot still parses with zero diagnostics. Run the Python test suite.

## Notes
