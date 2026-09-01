---
id: tic-d7d1
title: Per-function complexity proxy, from the control-flow walk already being done
status: open
type: feature
tier: low
domain: io
epic: call-flow
priority: 8
tags:
- parser
- metrics
- complexity
assignee: null
depends_on:
- tic-b47a
blocked_by: null
created: '2026-09-01T07:25:20'
updated: '2026-09-01T07:25:20'
closed: null
---

## Description
Nearly free once tic-b47a lands, and it is exactly what both humans and LLM summarisers want for "where is this hairy".

tic-b47a's walk already visits every control-flow construct inside a function. Count them into a single cyclomatic-style number on the callable's SymbolDef: one plus the count of if/elif, match cases, for, while, except handlers, boolean `and`/`or`, ternaries and comprehension guards. Count constructs in the function's OWN body only, not in nested defs -- a nested def carries its own number.

Do not chase textbook exactness. This is a proxy for "how many ways can control move through this", it will be compared against other functions in the same codebase, and relative ordering is all it needs to support. Say so in the docstring so nobody later "corrects" it into a different metric with different consumers.

Also record the plain statement/line count, which is a useful and completely unambiguous companion -- a long simple function and a short dense one are different problems.

Bump SCHEMA_VERSION, mirror in web/src/data/types.ts. Feed both numbers into the inspector and let the call-flow mode size or shade nodes by them if it wants.

Verification: parser tests over fixtures with known construct counts, including a nested def (outer number excludes it), a comprehension with a guard, and a chain of boolean operators. Report the distribution across ../carnot and name the top few functions -- if they are not intuitively the hairy ones, the proxy is wrong. Run the Python test suite.

## Notes
