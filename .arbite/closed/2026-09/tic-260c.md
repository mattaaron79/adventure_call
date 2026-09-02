---
id: tic-260c
title: 'Give call-flow lines the import lines'' hover treatment: popup, highlight,
  ants'
status: closed
type: feature
tier: high
domain: ui
epic: viz-modes-next
priority: 1
tags:
- canvas
- callflow
- hover
- popup
- ants
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-02T11:03:20'
updated: '2026-09-02T11:20:03'
closed: '2026-09-02T11:20:03'
---

## Description
Three things the canvas does for import lines and not for call/state/type lines, all from the same root cause: importEdgesIncidentTo, isAntsEdge and Workspace's connections filter each hardcode kind === 'import'. (1) The near-pointer popup names nothing in call flow. It should, and for these lines 'a -> b' is not enough -- the line's meaning is which KIND it is and what its tags say. (2) EDGE_POPUP_MAX_LINES is 8; raise to 20, and check the popup's flip-near-the-edge threshold, which assumes a ~160px box. (3) Hovering a function should light its call lines and march their ants, as hovering a file does for its imports.

## Notes
- 2026-09-02T11:19:44 claude.opus.001: Done. Call, state and type lines now get everything import lines had, the
popup cap is 20, and the popup says what a line MEANS rather than only which
two things it joins.

## One root cause behind all three parts

Three cross-mode behaviours each tested `edge.kind === 'import'` outright:
`importEdgesIncidentTo` (highlighting), `isAntsEdge`'s animate-all path, and
Workspace's `connections` filter for the popup. True when only the fs-tree and
the import graph drew lines; quietly wrong from the moment call flow shipped.

Worth recording: `FlowEdgeData`'s own docstring claimed "selection
highlighting and marching ants both test for a `call` edge". They did not, and
had not since it was written. The line that was going to keep call flow
working was describing behaviour that never existed.

Replaced with CONNECTION_KINDS = {import, call, state, type}, STRUCTURAL_KINDS
= {nesting, stub, section, module}, and `isConnection`. `importEdgesIncidentTo`
becomes `connectionEdgesIncidentTo`, which is what it now is.

An INCLUSION set rather than "anything that is not nesting", because the two
fail opposite ways. A kind left out of an inclusion set is a line that does
not light up -- visible and fixed by adding a word. A structural kind that
slips through an exclusion set puts a popup over a folder elbow reading
"app -> errors.py" and animates a line with no direction to show.

That is enforced rather than hoped for: fsTree.test, importGraph.test and
callFlow.test each take a spec their suite already builds and assert every
kind in it is classified. Not a checklist -- the kinds come from real specs,
so a kind added and forgotten fails there. The call-flow case turns the
overlays on, since those are the two most likely to be added and forgotten.

## The ants needed nothing

`isAntsEdge`'s default path was already `highlighted && directional`, and call
flow already set `directional: true` on all three kinds. So the ants were
never the missing piece -- highlighting was. Once a call line can be lit it
marches, with the same speed, dash and animation as an import.

One case falls out correctly: a MUTUAL state coupling sets `directional:
false`, so it lights without ants. Nothing to march, because tic-675a draws it
undirected on purpose. Pinned with a test.

## The popup had to say more than "a -> b"

Over an import line the endpoints are the whole story. Over a call-flow scene
they are not: three kinds of line can join the same two chips, and which kind
this one is, is the reader's actual question. So SpecEdge/SceneEdge gained
`detail`, written by the mode and appended by `describeConnections`. The canvas
composing it would mean the canvas layer knowing what a breadcrumb is.

  call    3 calls, guarded, always in a loop, resolved by name guess
  state   both write: _driver     (or `shares: _driver` when one-way)
  type    passes Rule, and calls it
  extern  external

Same vocabulary as EDGE_LEGEND, read off the same tags, so a reader who has
met the legend meets no new words. `mixed` gets its own words ("guarded at
some sites") though it shares guarded's dash -- the style phase had no channel
to spare for 2% of edges, and a popup has room.

A non-directional connection also gets a two-headed arrow. A mutual coupling
drawn "a -> b" would name a source that does not exist.

## tic-3a20's `certain` finally lands somewhere

The style phase declined it and the note said the honest home was a badge or a
filter. This is it. Said only on an UNGUARDED line, where it is the whole
question, and the split earns the words: measured on ../carnot, of the
unguarded call edges the overview draws, 60 always run and 62 do not; at depth
3, 413 against 342. Neither answer is the boring majority.

Silent on a guarded line (certain is a strict subset of unguarded, so the
answer is always no) and silent on `null`, which means the export could not
say and must never be read as "no".

## 8 -> 20, and the flip threshold that would have broken

Counting connections per node on ../carnot -- a layout-free proxy, since it
bounds what one chip contributes to a bundle -- 7.3% of call-flow nodes and
9.1% of import-graph nodes carry more than 8. The popup was ending in "+N
more" on about one busy line in twelve. At 20 that is 0% and 3.3%: truncation
stops in call flow entirely and becomes a hub-file event in the import graph,
which is the case the cap was written for.

The raise has a cost the ticket asked me to check, and it was real. The popup
flips above the pointer near the bottom of the canvas, and that decision is
made before the box exists, so its height was a hardcoded 160 -- fine at 8
lines, wrong by more than double at 20. It would have run off the bottom in
exactly the dense case the raise was for. Now `edgePopupHeight(lines, more)`
predicts it from the line count, mirroring the CSS, with the `+N more` tail
counted as a line. Over-estimating flips a little early and nobody notices;
under-estimating is the bug.

## Verification

957 web tests, up from 926 at the start of this ticket (920 before tic-ec97).
tsc -b clean, build clean.

21 mutations, 21 caught. Nineteen on the first pass; the two survivors were
both things I had asserted in prose and pinned nowhere -- the legend's new
hover clause, and the cap itself. The cap's test is tied to its reason rather
than mirroring the number: it must clear 18, the busiest node in ../carnot's
call-flow overview, and stay under 105, the busiest in the import graph.

Also: I could not measure "lines within the 32px pick radius" directly. The
layout is elk-backed through a worker and does not resolve in the node test
environment, so the per-node incidence figures above are a proxy, and I have
said so rather than presenting them as the thing itself.
