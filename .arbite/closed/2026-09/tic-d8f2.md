---
id: tic-d8f2
title: Dominator-based chokepoints on the condensed call DAG
status: closed
type: feature
tier: high
domain: ui
epic: call-flow
priority: 9
tags:
- call-flow
- dominators
- analysis
assignee: claude.opus.001
depends_on:
- tic-a8a6
- tic-22db
blocked_by: null
created: '2026-09-01T07:26:00'
updated: '2026-09-01T20:43:07'
closed: '2026-09-01T20:43:07'
---

## Description
"Everything downstream of here goes through this function" -- the load-bearing walls of the codebase.

Compute the dominator tree of tic-a8a6's condensed DAG rooted at tic-22db's entry set (a synthetic super-root over all entries, since there is no single entry). A node X dominates Y when every path from an entry to Y passes through X, so X's dominated subtree is exactly the region that becomes unreachable if X is removed. That is the honest form of "chokepoint" -- strictly better than the fan-in/fan-out heuristics in tic-1ecc, which only guess at it.

Use a standard algorithm -- iterative Cooper-Harvey-Kennedy is simple, fast enough at this size, and much easier to get right than Lengauer-Tarjan. Work over the condensed DAG, never the raw graph.

Two things fall out, both worth surfacing: the dominator subtree SIZE per function (a ranking of load-bearing-ness), and the immediate dominator, which gives "the last thing that must happen before this can".

Caveat to carry into the UI: dominance is computed over the RESOLVED call graph. An unresolved or dynamic call into the middle of a dominated region would break the claim, and with ../carnot resolving ~39% of call sites that is not hypothetical. Phrase results as "in the resolved call graph, everything reaching X goes through Y" and let tic-171f's coverage figures sit next to it.

Verification: unit tests on synthetic graphs with hand-computed dominator trees -- a diamond (the join point dominates nothing above it), a chain, multiple entries, and an unreachable node. Against ../carnot, report the top ten by dominated-subtree size and sanity-check that they are plausible. npm run test, tsc -b.

## Notes
- 2026-09-01T20:43:07 claude.opus.001: Done. `web/src/data/dominators.ts`, plus a `gates N` clause on the mode 3 chip.

## The claim the ticket wanted checked, checked

Top ten by dominated-subtree size on ../carnot, straight out of the shipped
implementation and identical to the independent python oracle:

  gates  28  audit.audit_source                        <- ENTRY
  gates  19  audit._Scan.run                           <- audit_source
  gates  18  my_plugins.tools.plan.Plan.run            <- ENTRY
  gates  17  {audit._Scan._block, audit._Scan._statement}  <- _Scan.run
  gates  15  tests.test_registry.test_disabled_plugins_are_skipped <- ENTRY
  gates  14  workbench.pending.extract.Extract.run     <- ENTRY
  gates  13  my_plugins.tools.market_radar.MarketRadar.run <- ENTRY
  gates  13  kernel.registry.Registry.instantiate_all  <- test_disabled_plugins
  gates  13  web.gateway.Gateway.handle_inbound        <- ENTRY
  gates  12  cli.tui.CarnotApp.render_transcript       <- ENTRY

Plausible, and the second-to-fourth rows are the shape you want to see: a
chain, `audit_source -> _Scan.run -> {_block, _statement}`, each gating the
next. hypermenu gives the same picture with `JobScheduler.start -> _loop ->
run_job`.

## tic-1ecc's heuristics are not a proxy for this, measured

  top-20 by gates vs top-20 by fan-in   1 symbol in common (both codebases)
  top-20 by gates vs top-20 by reach    0 on ../carnot, 3 on hypermenu

  fan-in  70  gates  5  reach 42   agent.session.Session
  fan-in  63  gates  3  reach  3   agent.loop.Agent
  fan-in  59  gates  0  reach  0   kernel.types.ToolResult.success
  fan-in  54  gates  0  reach  0   kernel.types.ToolCall

`ToolResult.success` has 59 callers and gates NOTHING, and the popularity is
exactly why: every caller reaches it directly, so deleting it disconnects
nobody from anything else. Fan-in ranks popularity, reach ranks blast radius,
dominance ranks exclusivity. Only the third answers "what breaks if this
goes", and the ticket's "strictly better" is right for a sharper reason than
it stated -- the two rankings are not a refinement of each other, they are
nearly disjoint.

## Two design points the ticket did not settle

1. THE ROOT SET IS ENTRIES *UNION* SOURCES. Rooting at tic-22db's entries
   alone is not enough. An entry symbol has no caller other than itself, but
   its COMPONENT can still have one: two mutually recursive functions where
   something calls only the second form a component with an inbound edge and
   no entry member. Rooting only at entries never reaches it, and would then
   claim dominance along paths the real graph contradicts -- wrong, not merely
   incomplete.

   Measured: ../carnot has 1586 entry components and 1747 sources, and every
   one of the 161 sources with no entry member is ISOLATED, i.e. an orphan
   gating nothing (hypermenu 360 / 390, same story for all 30). Sources with
   outgoing edges and no entry member: ZERO on both. So the rule changes no
   answer today; it is a guard against a shape that is one mutual-recursion
   pair away. It also means nothing is ever unreachable, since every node of a
   finite DAG is reachable from some source -- so the ticket's "unreachable
   node" test became "an isolated orphan is IN the tree, under the super-root,
   gating nothing".

2. THE FIGURE BELONGS TO THE COMPONENT, NOT THE FUNCTION. Removing one member
   of a mutually recursive pair leaves the other standing, so
   `{_block, _statement}` gates 17 as a GROUP and neither member gates 17
   alone. Members share the figure (the same sharing effects and tic-1ecc's
   reach counts rest on), and `immediateDominatorOf` returns the dominating
   component's MEMBERS rather than picking one. On the chip the rule is
   enforced twice, once on the ordinary path and once on the root chip that
   rewrites its own sublabel: an expanded knot's per-member chips wear no
   figure at all, because they have no honest one. Both guards are
   mutation-checked.

## The caveat, with the number attached

Dominance is over the RESOLVED call graph, so the numbers are small and the
reason is worth writing down rather than apologising for: 2197 of ../carnot's
2716 components (81%) have the super-root as their immediate dominator -- 1747
because they are sources at all, the rest because more than one root reaches
them. Every caller the resolver could not follow promotes its callee to a
root. So 309 of 2718 symbols gate anything, median 1, max 28 (hypermenu 58 of
584, median 1, max 12).

Those are real chokepoints AND they are the ceiling this export's resolution
allows, not the codebase's. A UI must not read the flatness as "no load-
bearing walls here". That is why `gates N` sits immediately before tic-171f's
coverage clause on the chip: `gates 28 · 4/9 sites resolved` puts the claim
and the reason to doubt it side by side.

## Algorithm

Cooper-Harvey-Kennedy over the condensation, super-root = -1, reverse
postorder computed iteratively from the super-root (../carnot condenses to
2716 components; a deep chain would blow a recursive stack, same reason
`stronglyConnectedComponents` is iterative). On a DAG reverse postorder puts
every predecessor first, so pass one IS the fixpoint and pass two only
confirms it -- measured at exactly 2 passes on both codebases. The loop stays
because it is the algorithm, and because one pass is exact only while the
input is a DAG; the condensation always is, but this module should not be the
place that silently depends on it.

## Surfaced

`gates N` on the mode 3 chip, next to `reaches N` and before the coverage
clause, omitted at zero (89% of the codebase; a badge that common says
nothing). It survives on the rooted view's ROOT chip where `reaches` was
deliberately dropped in tic-7a5e -- `gates` is not a direction, so it does not
invite subtracting two numbers that measure opposite ways, and it says exactly
what the drawn cone cannot show.

NOT surfaced: `immediateDominatorOf` ("the last thing that must happen before
this can") and the ranked `chokepoints` list. Both are on the index and
tested; neither has a home today. The Inspector does not consume any call-flow
derivation yet -- tic-7189's effects have the same status -- and giving it one
is a panel, not a clause on a chip. Worth its own ticket.

## Verification

17 new tests in `dominators.test.ts` on hand-computed graphs: a chain, a
diamond (the join is dominated by the fork and by NEITHER arm), multiple
entries, mutual recursion, an isolated orphan, the entries-union-sources case,
and the fan-in-is-not-dominance shape. 8 more in `callFlow.test.ts` for the
chip.

817 web tests (up from 791), 220 python tests unchanged, tsc -b clean, build
clean.

Mutation-checked five rules, each failing exactly the tests that state it:
dropping sources from the root set fails 2; reporting one member of a cyclic
dominator fails 2; counting the component itself in `gates` fails 10; and each
of the two whole-component guards on the chip fails its own test. The knot
tests were vacuous twice before they were real -- the overview never expands a
cycle, and the fixture's only knot gated nothing -- so both were rebuilt
around a knot that gates something, rooted where the ordinary chip path draws
it.
