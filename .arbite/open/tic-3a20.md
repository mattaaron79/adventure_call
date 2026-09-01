---
id: tic-3a20
title: Per-function CFG and dominators for an honest 'this call is unavoidable'
status: open
type: feature
tier: frontier
domain: io
epic: call-flow
priority: 12
tags:
- parser
- cfg
- dominators
- control-flow
assignee: null
depends_on:
- tic-b47a
blocked_by: null
created: '2026-09-01T07:26:00'
updated: '2026-09-01T07:26:00'
closed: null
---

## Description
Tier 2 of the guarded/unguarded question, deliberately deferred until tic-b47a and tic-5069 have shipped and we know whether the cheap approximation is actually insufficient. Do not start this before that is answered.

tic-b47a gives `unguarded` -- the call is not inside a conditional -- which is honest but weaker than it sounds: an early `return` or `raise` above the call still kills it. The true statement requires a control-flow graph. Build basic blocks per function body from the tree-sitter AST (handling if/elif/else, loops with break/continue, try/except/else/finally, with, match, and early return/raise), then a call is UNAVOIDABLE iff its block lies on every path from entry to exit -- computable as: the block is dominated by entry and post-dominates... concretely, compute both the dominator and post-dominator trees and require the call's block to dominate the exit node's predecessors appropriately. The implementer should derive and state the exact condition in the docstring, with the test cases that pin it.

That upgrade turns `unguarded` into a real `certain`, which is the difference between "this call is not guarded" and "if this function runs, this call runs".

Cost is real: a CFG per function over an entire codebase, plus two dominator computations each. Measure parse time before and after and report it; if it is material, make it opt-in behind a CLI flag rather than paying it on every run.

Python-specific traps worth naming up front: `finally` runs on every path INCLUDING exceptional ones, `else` on try and for means something unusual, a bare `raise` re-raises, and generators suspend rather than exit. Each needs a test.

Verification: fixture functions with hand-derived answers for each construct and each trap; explicitly test that a call after an unconditional early return is NOT certain, and that a call in a `finally` IS. Run the Python test suite.

## Notes
