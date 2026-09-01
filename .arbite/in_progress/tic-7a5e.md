---
id: tic-7a5e
title: 'Mode 3: the rooted local view -- one function''s call flow, upstream and down'
status: in_progress
type: feature
tier: high
domain: ui
epic: call-flow
priority: 5
tags:
- mode
- call-flow
- focus
assignee: claude.opus.001
depends_on:
- tic-d8a8
blocked_by: null
created: '2026-09-01T07:24:42'
updated: '2026-09-01T13:02:51'
closed: null
---

## Description
The mode's focused state, and the thing the whole feature is for: pick a function, see what it can set in motion and what can reach it.

`focusPath` here names a SYMBOL ID. That is a third meaning for the same per-mode field -- fs-tree reads it as a directory, import-graph as a file (tic-d7d7's Local View), and App.tsx's resolveGotoScope already documents that divergence and guards against handing one mode another's kind of path. Extend that guard; do not let a directory path reach this mode.

Conceptually this is get_room_context from the README -- callers on one side, callees on the other -- generalised from one hop to N and given a picture.

Params: direction (downstream / upstream / both), depth limit, and whether recursive clusters render condensed or expanded. Direction matters more than it sounds: "what does this trigger" and "who can reach this" are different questions asked at different moments, and showing both at once is usually too much.

Clicking any node in the view re-roots on it. That is the mode's own navigation and needs nothing from tic-e738 -- it is a plain focusPath change, the same gesture import-graph's Local View already supports.

Depth needs a real default chosen against real data, not a guess: measure how many nodes depth 1/2/3/4 pulls in for a few representative ../carnot functions (a leaf utility, a mid-layer helper, a top orchestrator) and record the numbers in the notes before picking. A default that explodes on orchestrators makes the mode feel broken.

Verification: browser-verify all three directions against a known ../carnot function with both callers and callees; verify a recursive cluster expands and collapses; verify re-rooting by click; verify depth capping. npm run test, tsc -b.

## Notes
- 2026-09-01T13:02:51 claude.opus.001: Done. The measurements the ticket asked for first, since they changed the design rather than just picking a number.

## "Upstream and down" cannot be one walk

Measured over all 1196 non-test callables in ../carnot, components drawn per root:

                depth 1       depth 2         depth 3          depth 4
  mixed walk    med 3 p90 8   med 12 p90 47   med 42 p90 160   med 121 p90 431
  two cones     med 3 p90 8   med  4 p90 18   med  5 p90  28   med   5 p90  38

A breadth-first walk over the undirected call graph explodes because one step
up to a caller drags in everything ELSE that caller calls, and the step after
drags in their callers. Those siblings answer neither question the view asks
("what does this set in motion", "who can reach this"), so a walk that
collects them is answering neither, at ten times the size. The mode walks two
independent cones instead -- strictly ancestors, strictly descendants. The
condensation is a DAG, so the two sets cannot overlap.

That is the whole reason a rooted view is drawable at 168 chips instead of
610. It is not a tuning decision.

## The default is depth 2 with a node budget of 80

The median root draws 3 components at depth 1, 4 at depth 2, 5 at depth 3 --
most functions have almost nothing around them and the depth knob barely
moves them. The tail is what the default has to survive: at depth 2 the p90 is
18 and the p99 is 57, which is a picture; depth 3's p99 is 93 and depth 4's is
232.

Depth alone does not bound it, though. carnot's ConfigError has 9 callers at
one hop, 42 at two and 135 at three. So a node budget refuses a whole level
that will not fit -- never part of one, because taking part would mean picking
which callers of a hub to believe in, and there is no honest basis for that.
At depth 2 a budget of 80 refuses a level for 6 of 1196 roots (0.5%); 40
refuses one for 26 (2.2%). Verified the budget can never refuse the FIRST
level: the widest one-hop cone across all 2573 components is 69.

Representative roots at the shipped defaults (both directions, depth 2):

  playground.main          16 components, +26 beyond
  build_app.ws_endpoint    24, +6
  audit.audit_source       29, +3
  transcript.Transcript    38, +67   (a hub; the cone is nearly all ancestors)
  kernel.errors.ConfigError 42, +93  (283 things can reach it)
  audit._Scan._block       14, +5    (carnot's only cycle, rooted on the knot)
  my_plugins.tools.plan._load 10, +0

## What shipped

- coneOf() with the two-cone walk, whole-level budget, and a `beyond` count
  that only looks in the directions being asked about (under direction:'up',
  the root's callees are not "beyond the edge", they are outside the question).
- Params: direction (Both/Calls/Callers, a segmented control via the existing
  paramOptions), rootDepth (separate from the overview's depth -- the overview
  at depth 2 draws 2286 of carnot's 2574 nodes while a root at depth 1 draws a
  median of 3; one number cannot serve both), expandCycles.
- Re-rooting by clicking any chip: `focusTo` on every node, which the canvas
  already renders and already hides on the element that IS the focus. No new
  framework surface -- as the ticket predicted, it needed nothing from
  tic-e738. The OVERVIEW chips carry it too, which is what makes the rooted
  view discoverable: 153 of the overview's 168 chips offer it (the other 15
  are external sinks).
- Root chip wears the accent border and says what is missing.

## Two things I changed course on

1. The root chip's sublabel does NOT say "reaches N". That figure is the
   overview's vocabulary -- it ranks entries by blast radius -- and on a root
   it misleads: an upward view of ConfigError first read "reaches 0 · +93
   more", inviting the reader to subtract two numbers measuring opposite
   directions. It now reads "errors · 93 not shown", and "(depth capped)" when
   a budget cut the walk short rather than the depth limit.

2. The breadcrumb toolbar named its root-only crumb by slicing the last '/'
   segment off the focus path. That is right for a file (the segment IS the
   basename) and wrong for a dotted symbol id, which has no slash -- the crumb
   came out as the whole `src.carnot.web.app.build_app.ws_endpoint`. The
   toolbar now takes the focused element's own chip label off the scene, which
   is mode-agnostic and strictly better for the import graph too, plus a CSS
   ellipsis so a long name cannot stretch the floating bar off the canvas.

## Refactor along the way

Edges are now built from the raw per-symbol call edges through a
symbol-to-element map, replacing the condensed-edge builder. One function
serves both states: condensed, it reproduces the condensation exactly; with a
knot expanded, the same pass draws the calls BETWEEN its members, which is the
only reason to expand one. Verified parity on carnot -- the overview still
draws exactly 168 nodes and 283 edges, and all 40 pre-existing tests passed
unchanged.

Also added CallGraph.condensedCallers (derive.ts) rather than inverting the
condensation inside the mode: it is a fact about the graph, not a rendering
decision, and tic-d8f2's dominators will want it.

## Verification

- 656 web tests (29 files), tsc -b clean, production build clean.
- Mutation-checked the two claims that carry the design: making `both` a mixed
  walk fails 3 tests; taking a partial level instead of refusing the whole one
  fails 2.
- Against the real ../carnot export: no dangling edges in any rooted scene, all
  three directions, expandCycles splitting _Scan._block/_statement into two
  chips and 19->21 edges (the mutual recursion), and all three fallback cases
  ('' / a bogus symbol / a DIRECTORY path) landing on the 168-node overview.
- App.tsx's resolveGotoScope needed no code change -- it already allow-lists
  the fs-tree -- but the comment now states why call flow is opted out, and
  that a new mode is opted out until it says otherwise.

NOT browser-verified by me. The ticket asks for it and the user has the dev
server; everything above is programmatic against the real export.
