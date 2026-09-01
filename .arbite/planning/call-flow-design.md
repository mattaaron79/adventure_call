# Mode 3: call flow -- design decisions

Recorded 2026-09-01 from a design conversation with the user. Tickets in the
`call-flow` epic reference this document; it is the "why", they are the "what".

## The framing

Modes 1 and 2 (folder structure, import graph) answer *where code lives* and
*what depends on what*. Mode 3 answers *what can happen when this runs*. The
long-term goal is the same for all three: feed automated LLM analysis that
summarises chains, edges and groups into a compressed "codebase as semantic
graph", useful to bots and humans alike.

## Decisions

**Recursion does not defeat 2D.** A raw call graph is not a DAG, but its
*condensation* -- every strongly-connected component collapsed to one node --
always is, and a DAG layers cleanly in 2D and ranks cleanly in 1D. A recursive
function is a node with a badge; a mutual-recursion knot is one node badged
with its size, openable. This is the structural fact the whole mode rests on.
`deriveStronglyConnectedComponents` (iterative Tarjan's, written for tic-56b2)
already exists and only needs pointing at CALLS instead of file imports.

**The node is the callable symbol we already export.** `symbol_id` is already
the qualified `module.class.function` path, so identity and lexical distance
(common dotted-prefix length) come free. Classes are containers, not nodes.
Three synthetic additions: external sinks (aggregated per external module),
entry points, and dynamic holes -- a computed callee is a *badge on the
caller*, not a node, because drawing an honest hole beats drawing nothing.

**"Unguarded", never "unconditional" or "always".** `guard_depth == 0` means
the call is not inside a conditional. It does *not* mean the call happens: an
early return or raise above it kills it, and the caller may itself be
conditional. The cheap approximation (tic-b47a, tic-5069) is honest as long as
it is named honestly. A true "unavoidable" needs a per-function CFG and
dominators, deferred to tic-3a20 and deliberately not started until we know
the approximation is insufficient.

**Variables are an edge type, not a relevancy score.** "What is affected if X
changes" is computable, so it should be computed, not approximated with a
number. Module variables and class/instance attributes already exist as
symbols; what is missing is *reads* (tic-13d7). Function locals are listed,
never graphed (tic-799e) -- invisible outside the function by definition, so
as nodes they would be noise. `self.x` reads couple methods of a class that
never call each other, which a call graph is structurally blind to; that is
expected to be the most surprising thing the feature surfaces.

**The mode has two states.** Unfocused (`focusPath === ''`) is the entry-point
overview, which doubles as an architecture map and solves the discovery
problem -- a purely rooted mode is only usable if you already know what to ask
about. Focused (`focusPath === <symbol id>`) is the rooted local view:
`get_room_context` from the README, generalised from one hop to N and given a
picture. This mirrors fs-tree, where empty `focusPath` means the whole tree.

**`focusPath` means whatever the mode says it means.** A directory in fs-tree,
a file in import-graph's Local View (tic-d7d7), a symbol id in call flow.
App.tsx's `resolveGotoScope` already documents and guards that divergence.

**Cross-mode navigation is the one missing seam.** `setMode` preserves each
mode's own state and `focusTo` drills only within the current mode, so there
is no "switch to mode X, rooted at Y". tic-e738 adds it as a general
"open symbol S in mode M" -- built generally from the start, because the
return trip (call flow -> fs-tree, "where does this live on disk") is the same
mechanism and must cost nothing extra. Prefer a new SpecNode field over
overloading `focusTo`: "go into this, here" and "go look at this elsewhere"
are different gestures.

## The constraint everything must respect

Measured against ../carnot on 2026-09-01: 3547 calls resolved, 732 heuristic,
7499 unresolved (2058 builtins). The call graph sees roughly **39% of
non-builtin call sites**.

A flow view that silently drops the majority of its edges is *worse* than no
view, because it looks authoritative and will be believed. Hence tic-171f
(coverage worn visibly, never hardcoded) is the most important ticket in the
epic and the easiest to skip.

Two fixes raise the number materially:

- tic-9ff4, a real bug: module ids are path-derived (`src.carnot.kernel.types`)
  but imports say `carnot.kernel.types`, so 823 in-project calls are marked
  `external: carnot.*`. Every src-layout project hits this.
- tic-97ce: the `unknown receiver` cases (`pilot` 389, `app` 250) are *locals*
  bound by `with ... as` and `x = Foo()`, not annotated params -- an initial
  hypothesis that the data disproved. Needs a shallow within-function symbol
  table.

And a ceiling worth naming so nobody chases it: much of the remainder is
duck-typed stdlib methods on locals (`lines.append` 110, `parts.append` 42,
`"\n".join` 52). Those will never resolve to an in-project symbol and should
be *classified*, not counted as holes.

## Sequencing

0. tic-9ff4 -- standalone bug, unblocks everything, no epic.
1. Derive layer over today's export: tic-a8a6, tic-22db, tic-1ecc. Enough for
   a working mode with no parser changes at all.
2. The mode: tic-e738, tic-d8a8, tic-7a5e, tic-d6af, tic-171f.
3. Parser control flow: tic-b47a -> tic-5069 -> tic-23eb, plus tic-d7d1.
4. Data flow: tic-2255, tic-799e, tic-13d7 -> tic-675a, tic-59b1.

Look at what stage 1 produces before committing to stages 3 and 4. The
open question stage 1 answers: is the condensed DAG small enough to lay out,
and does the entry-point overview read as an architecture map or as a mess?
