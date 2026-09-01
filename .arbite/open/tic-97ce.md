---
id: tic-97ce
title: 'Resolver: bind local variables to types so receiver method calls resolve'
status: open
type: feature
tier: high
domain: io
epic: call-flow
priority: 6
tags:
- resolver
- type-inference
- coverage
assignee: null
depends_on:
- tic-2255
- tic-9ff4
blocked_by: null
created: '2026-09-01T07:23:44'
updated: '2026-09-01T07:26:53'
closed: null
---

## Description
The largest remaining recoverable slice of unresolved calls, after tic-9ff4.

Measured on the current ../carnot export: `unknown receiver 'pilot'` (389 sites), `'app'` (250), `'console'` (56) and friends. I checked whether these were annotated parameters -- they are NOT. They are LOCALS, bound by forms like `async with app.run_test() as pilot:` and `x = Foo()`. The resolver has no within-function symbol table, so any method call on a local dies.

Add a narrow, deliberately shallow one: within a single function body, bind a local name to a symbol id for the unambiguous forms only -- `x = SomeClass(...)` where SomeClass resolves to an in-project class, `x: SomeClass = ...` and bare `x: SomeClass`, `with expr() as x` / `async with expr() as x` where the callee's return type is known, and `for x in ...` only where the iterable's element type is obvious (probably: skip it in v1). Then use those bindings in SymbolResolver._resolve_call's receiver lookup, marked confidence `heuristic`, never `exact` -- a local can be rebound and this analysis does not track that.

Explicitly out of scope: reassignment/flow sensitivity, container element types, duck typing, and anything requiring a real type checker. If a name is bound twice to different types, drop it rather than guess.

Depends on tic-2255 (`returns` as its own field) for the `with ... as` case, which needs the context manager's return type without parsing signature text.

Honesty about the ceiling, so nobody chases this too far: a large share of the remaining unresolved calls are duck-typed stdlib methods on locals -- `lines.append` (110), `parts.append` (42), `"\n".join` (52), `s.strip` -- which will never resolve to an in-project symbol and should be classified as stdlib methods rather than counted as holes. Consider adding that classification here; it makes the coverage numbers in tic-171f honest instead of pessimistic.

Verification: fixture tests per binding form plus the rebinding case (must NOT resolve); re-run ../carnot and report the before/after calls_resolved / calls_heuristic / calls_unresolved numbers in the notes; confirm no previously-exact resolution downgrades. Run the Python test suite.

## Notes
