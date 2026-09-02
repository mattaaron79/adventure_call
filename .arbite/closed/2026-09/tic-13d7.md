---
id: tic-13d7
title: 'READS/WRITES: a fourth edge type for module variables and class attributes'
status: closed
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
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-01T07:26:38'
updated: '2026-09-01T22:14:10'
closed: '2026-09-01T22:14:10'
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
- 2026-09-01T22:14:10 claude.opus.001: Done, as graph edges. The scale warning turned out to be unfounded, and the
sleeper value turned out to be real and large.

## Scale, measured before building (the thing the ticket asked for first)

  carnot      4749 -> 5855 edges  (+23%)   READS 742  WRITES 364
  hypermenu    963 -> 1451 edges  (+51%)   READS 419  WRITES  69

  carnot codebase_graph.json  6646 -> 7059 KiB  (+6.2%)
  carnot export time          3.07s -> 3.92s   (+28%)
  diagnostics                 0, unchanged

Nowhere near "more edges than the graph currently holds". The reason is that
GraphBuilder._merge_edge folds per (source, target) pair: 1448 resolved access
SITES on carnot become 1106 edges. So no registry fallback is needed; these are
ordinary graph edges like every other kind.

The +28% export time is the real cost, and it is the broad query, not the
resolution. Acceptable at 3.9s for 258 files, worth knowing if a much larger
codebase ever shows up.

## The sleeper value was right, and it is not small

Method pairs in ONE class that share an attribute and have NO call edge
between them, in either direction:

  carnot     780   (591 once __init__ is excluded)
  hypermenu  420   (409 once __init__ is excluded)

  Agent._converse       <-> Agent._invoke
  PromptStore._load     <-> PromptStore.all
  RemoteCamoufox.goto   <-> RemoteCamoufox.screenshot

221 attributes on carnot are touched by two or more methods. A call graph is
structurally blind to every one of these and no amount of call-graph analysis
would recover them.

## Four things the ticket did not anticipate

1. THE CALLABLE LOOKUP TABLES CANNOT BE REUSED. `module_members` and
   `class_members` deliberately EXCLUDE non-callables -- the comment in
   `_build_indexes` says why, a constant sharing a function's name would make
   that name ambiguous for CALL resolution -- so a read lookup has nothing to
   look in. Added `module_values`/`class_values` as separate tables, plus
   `_lookup_value` as the value-side twin of `_lookup_member`, walking bases
   the same way. `self.x` declared on a base class and read from a subclass
   method resolves because of that walk.

2. SHADOWING IS A FUNCTION-SCOPE QUESTION AND ONLY THAT, which is the exact
   opposite of what tic-89fa needs. 89fa wants a module-level binding to
   shadow; here a name bound at module or class level IS the symbol we want to
   point at, so consulting the bound set there would suppress every read of
   every constant -- the entire feature. `_is_local` is therefore a separate
   walk from `_is_bound` and stops at the first non-function scope. Both the
   module-level and the class-level halves are mutation-checked, and they fail
   to different mutations.

3. `self` AND `cls` ARE PARAMETERS, so the shadow check suppressed every
   `self.x` on the first run. They are exempt: a receiver is not a name being
   read, the attribute after it is.

4. `global X; X = 2` HAD TO BE UNDONE SPECIALLY. The assignment puts X in the
   function's bound set, so the shadow check killed it -- but the declaration
   says the name is the module's, and a function writing a module-level
   constant is exactly the edge worth drawing. `_declared_globals` re-permits
   those names.

## Deliberate exclusions

* A DECLARATION IS NOT A WRITE. `LIMIT = 5` at module level, `x = 1` in a
  class body: the accessor is the symbol's own owner, and the graph already
  says that with CONTAINS. Every variable symbol would otherwise get a
  redundant self-edge. Reads are never redundant this way, so only writes are
  dropped.
* A NAME THAT RESOLVES TO A CALLABLE IS NOT AN ACCESS. That is tic-89fa's
  REFERENCES, which already exists and says it better. The path that matters
  is an import binding, which points straight at a function -- only the kind
  check refuses it, so the test uses an imported callable rather than a local
  one (the first version of that test passed under the mutation).
* NO `unresolved` COUNTERPART, and much more so than for references. The query
  matches every identifier in the file: 33974 candidate sites on carnot for
  1448 accesses. Recording the other 32000 would say nothing except that
  Python has variables.
* ONE LEVEL ONLY. `a.b.c` names nothing this can follow. A locally-typed
  receiver (`cfg = Config(); cfg.limit`) is also not followed -- tic-97ce's
  local types are wired into call resolution, not this. Worth a later ticket
  if the numbers justify it; `self.x` already carries the feature.

## Shape

Two edge types, not one with a flag: "what does this depend on" is READS and
"what does changing this break" is WRITES, and a consumer almost always wants
exactly one. A pair can be both -- `x += 1` -- and `_merge_edge` already knows
how to hold two type names, as it does for a pair that is both a call and an
import. The parser emits two accesses for an augmented assignment rather than
inventing a third word, so a consumer asking either question finds it.

Module-level accessors survive `module_call_edges=False`, like references: the
flag is about calls executed at import time, and a module reading another
module's constant is not a call at all.

Schema 7 -> 8, `reads`/`writes` in the stats, EdgeType mirrored in
web/src/data/types.ts. Nothing on the web side consumes them yet -- every
existing derivation filters by type, so they are inert there, verified against
a real schema-8 export (2718 call-graph nodes, unchanged).

## Verification

249 python tests, up from 220. 817 web tests unchanged, tsc -b and build
clean. ../carnot parses with zero diagnostics.

Mutation-checked seven rules, each failing exactly the tests that state it:
ignoring the scope kind in the shadow walk fails 1, walking that check out to
module level fails 4, exempting nothing from it for self/cls fails 10,
augmented-assignment-is-only-a-write fails 3, allowing callables through fails
1, not walking bases in the value lookup fails 1, keeping the declaration write
fails 3, and removing the value tables fails 9.

tic-675a is now unblocked, and its edge counts are workable.
