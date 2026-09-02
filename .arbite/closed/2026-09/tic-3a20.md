---
id: tic-3a20
title: Per-function CFG and dominators for an honest 'this call is unavoidable'
status: closed
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
assignee: claude.opus.001
depends_on:
- tic-b47a
blocked_by: null
created: '2026-09-01T07:26:00'
updated: '2026-09-02T01:17:20'
closed: '2026-09-02T01:17:20'
---

## Description
Tier 2 of the guarded/unguarded question, deliberately deferred until tic-b47a and tic-5069 have shipped and we know whether the cheap approximation is actually insufficient. Do not start this before that is answered.

tic-b47a gives `unguarded` -- the call is not inside a conditional -- which is honest but weaker than it sounds: an early `return` or `raise` above the call still kills it. The true statement requires a control-flow graph. Build basic blocks per function body from the tree-sitter AST (handling if/elif/else, loops with break/continue, try/except/else/finally, with, match, and early return/raise), then a call is UNAVOIDABLE iff its block lies on every path from entry to exit -- computable as: the block is dominated by entry and post-dominates... concretely, compute both the dominator and post-dominator trees and require the call's block to dominate the exit node's predecessors appropriately. The implementer should derive and state the exact condition in the docstring, with the test cases that pin it.

That upgrade turns `unguarded` into a real `certain`, which is the difference between "this call is not guarded" and "if this function runs, this call runs".

Cost is real: a CFG per function over an entire codebase, plus two dominator computations each. Measure parse time before and after and report it; if it is material, make it opt-in behind a CLI flag rather than paying it on every run.

Python-specific traps worth naming up front: `finally` runs on every path INCLUDING exceptional ones, `else` on try and for means something unusual, a bare `raise` re-raises, and generators suspend rather than exit. Each needs a test.

Verification: fixture functions with hand-derived answers for each construct and each trap; explicitly test that a call after an unconditional early return is NOT certain, and that a call in a `finally` IS. Run the Python test suite.

## Notes
- 2026-09-02T01:17:20 claude.opus.001: Done. `adventure_call/cfg.py`, a `certain` flag on every call site, schema
8 -> 9, and `EdgeTags.certain` on the web.

## The gate, answered first as the ticket required

Before writing any of it, measured across every unguarded call site: a
conditional early exit sits above 16.3% of ../carnot's 9411 and 14.9% of
hypermenu's 3205, and another 2.5%/3.2% sit in a `try:` body after something
that can raise. So `unguarded` overclaims on roughly one call in six. That is
what justified building it.

The shipped implementation then measured the same thing exactly rather than as
a bound: of the drawn (resolved) call sites,

  ../carnot   3313 unguarded, 887 of them NOT certain  (26.8%)
  hypermenu    535 unguarded, 113 of them NOT certain  (21.1%)

and the reasons split:

  ../carnot   49.5% an early return/raise above it, or a generator
              46.0% an `assert`, which `python -O` removes outright
               4.5% in a `try:` body after something that can raise
  hypermenu   81.4% / 0% / 18.6%

carnot's assert share is a test-heavy codebase showing its shape. Excluding
asserts it comes to 16.5%, which lands on the gate's 17.4% estimate -- the
cheap approximation predicted the size of its own error to within a point.

  resolved sites certain:  carnot 2441/4410 (55.4%)   hypermenu 596/921 (64.7%)
  CALLS edges where EVERY site is certain: 2151 of 3621, and 2 of 613

## Cost: not material, so no CLI flag

    without the CFG   4096 / 3964 / 4030 ms
    with it           4400 / 4296 / 4330 ms      +7.7%

The ticket said to make it opt-in if the cost were material. It is not, so it
runs on every export and consumers can rely on the field being there.

## The exact condition, and why the ticket asked for one computation too many

A call at statement S is unavoidable iff every path from entry to exit passes
through S. With a single synthetic exit that IS the definition of *S dominates
EXIT*, so:

    S is reachable from ENTRY, and S dominates EXIT.

The ticket asked for both a dominator and a post-dominator tree. It needs only
one: *S post-dominates ENTRY* and *S dominates EXIT* unfold to the same
sentence, so the second computation would restate the first. Reachability is
the other half and is not optional -- an unreachable node vacuously dominates
everything, and without it a statement below an unconditional `return` comes
out certain. There is a test for exactly that.

## Two things the CFG alone gets wrong

1. SUB-STATEMENT GUARDS. `x = a if c else f()` is one statement, and the
   statement always runs -- but `f()` runs on one branch of it. The first
   implementation reported 65 ../carnot sites as certain while their own
   tic-b47a breadcrumb said `ternary`, `bool`, `comprehension` or `lambda`.
   A statement-granularity CFG cannot see inside an expression and the
   breadcrumb already can, so `certain` is the CONJUNCTION of the two checks.
   That makes it a strict subset of `unguarded` by construction, which is the
   right relationship between a claim and the weaker one it replaces --
   measured, zero of 2441 certain sites are guarded.

2. `assert`. `python -O` removes assert statements outright, so a call in one
   is not something to promise. It joins the sub-statement set and
   deliberately NOT `GUARD_TOKENS`, which is tic-b47a's published vocabulary
   whose measured distribution should not shift underneath it.

## The Python traps, each with a test

* `finally` runs on every path out, exceptional ones included, so its
  statements ARE certain -- and code AFTER a `try/finally` is not, because the
  exception carries on past the finally. That second case is what needs the
  exceptional edge out of the finally; without it the first case still passes
  while the second quietly goes wrong, so both are pinned.
* `try/else` runs only when the body did not raise. `for/else` only when the
  loop was not broken out of.
* A bare `raise` re-raises: `b()` below a `try/except: raise` is NOT certain,
  and swapping the `raise` for a `pass` makes it certain again. I expected the
  opposite writing that test and the CFG was right.
* Only the FIRST statement of a `try:` body is certain -- an exception there is
  a path the code itself wrote down, unlike the implicit "anything can raise",
  which is not modelled because it would make nothing certain anywhere.
* A generator's body does not run when the function is called, so nothing in
  it is certain however the graph reads. A `yield` in a nested `def` does not
  count.
* `while True:` is a `while` like any other here: its test is certain, its
  body is not. Nothing in a syntactic CFG knows the condition never goes
  false, and the failure mode of not folding constants is a call we decline to
  promise.
* Module level gets the same question asked, which is what keeps a Django
  URLconf's `path(...)` from reading as conditional.

## Web side

`CallEdge.certains` rides parallel to `count` beside `controls`, pooled across
collapsed edges the same way. `EdgeTags.certain` is every-site-or-nothing, like
`allLooped` and for the same reason. It is `boolean | null`, and the null
matters: a pre-v9 export cannot say, and a UI reading that as "no" would report
every call in the codebase as avoidable.

Nothing draws it yet. `edgeStyleFor` already spends its channels on the tags
tic-23eb measured, and adding a fifth without measuring what it displaces would
be guessing; the honest place for `certain` is a badge or a filter, which is a
UI ticket rather than this one.

## One mutation survived, and the code was redundant rather than untested

`_body_of` looks up `body`, then `consequence`, then the first `block` child.
Deleting the first two breaks nothing: the governed block is also always the
first `block` child of every construct here. Unlike the dead branch in
tic-59b1 I kept these, because they are a more precise lookup with a less
precise fallback rather than a duplicate operation -- a grammar that ever put
another block first would make the scan silently wrong where the field lookup
would still be right. The docstring now says which half is doing the work.

## Verification

285 python tests, up from 249 -- 36 of them hand-derived CFG cases where the
expected set of always-run lines was worked out by eye before the code was
asked. 903 web tests, up from 899. tsc -b clean, build clean, ../carnot parses
with zero diagnostics.

Mutation-checked eleven rules. Nine of nine on the Python side that could
fail, did: reading only `body` (see above), dropping the finally's exceptional
edge fails 1, making a loop body always run fails 3, dropping the try-body
handler edges fails 3, counting generators fails 2, making `match` exhaustive
fails 1, letting `return` fall through fails 6, dropping the sub-statement
guards fails 1, and dropping the CFG check entirely fails 2. On the web,
`some` instead of `every` fails 1 and null-instead-of-false fails 1.

That closes the call-flow epic.
