---
id: tic-ec97
title: Explain every mode control in the sidebar with a real tooltip
status: closed
type: feature
tier: medium
domain: ui
epic: viz-modes-next
priority: 1
tags:
- ui
- modepicker
- discoverability
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-02T10:35:59'
updated: '2026-09-02T10:51:53'
closed: '2026-09-02T10:51:53'
---

## Description
The mode controls are opaque. 'State coupling', 'Type flow', 'Merge import lines', 'Sibling wrap' -- a reader cannot tell what any of them do from the label, and the one existing explanation (App.tsx's coverage tooltip) predates the tag work and is now incomplete. Give every declared param control a written explanation, surfaced where the control is.

## Notes
- 2026-09-02T10:51:38 claude.opus.001: Done. Every control in the mode panel now carries a written explanation, and
App.tsx's edge legend has been rebuilt where it will not drift again.

## Two surfaces, because a tooltip alone answers the wrong question

`help` is required on ParamToggle, ParamOption and ParamNumber -- not
optional, so the type system, not a reviewer, is what stops a control
shipping unexplained. ModePicker renders it twice:

* the native `title`, always there, for "what is this one thing" mid-task;
* an inline paragraph under the label, switched by a `?` in the Mode
  heading, for "what is this whole panel".

The second is the one the request was actually about. A reader meeting the
sidebar for the first time has nine controls to understand, and hover
tooltips make them do it one at a time while holding each answer on screen
only as long as the pointer sits still. The pin turns the panel into
something readable top to bottom.

The pinned flag lives under its own localStorage key (`adventure-call:ui:`)
rather than in the per-mode ModeState: it is a reading preference, so it
should not travel inside a preset and should not reset when the mode changes.
It reads back only the exact string it writes -- anything else is "closed" --
and a store that throws (private mode, blocked site data) degrades to closed
rather than taking the sidebar down.

## Scope: nine controls, not seven

The ask was the checkboxes. I wrote help for the segmented controls and
number inputs as well, because the mechanism is identical and "Sibling wrap"
sitting unexplained between two explained checkboxes is worse than either
state on its own. Nine controls across three modes.

## The legend App.tsx carried was wrong, and it is why EDGE_LEGEND moved

The coverage HUD's tooltip said "Solid edge = exact resolution, fine dash =
heuristic, faint dash = external". Written for tic-171f's three confidence
voices, never updated for tic-23eb's tags. Two failures by the time I found
it: solid had come to mean "exact AND unguarded" while the sentence still
claimed only the first, and the coarse guarded dash -- 20% of edges, the
dash a reader meets most often -- was not mentioned at all.

EDGE_LEGEND now sits beside `edgeStyleFor` in callFlow.ts, so a channel
added without a legend line is a one-screen omission rather than a
cross-file one, and names all six things that change how a line is drawn.
`typeCheckingOnly` stays out of both, since the style phase declines to draw
it.

## Verification

920 web tests, up from 903. tsc -b clean, build clean, 285 python tests
untouched and passing.

Sixteen mutations, sixteen caught:

  help restating its own label, help not ending as a sentence, the title
  dropped from each of the three control kinds, help always inline, help
  never inline, aria-pressed dropped, the legend dropping `guarded`, the
  legend dropping `looped`, the legend reverting to its old wording, the
  pinned flag trusting any stored value, the flag moved into the workspace
  namespace, the flag rethrowing on a blocked store, two controls sharing a
  key, and a control key drifting from defaultParams.

One test-design note. ModePicker.test.ts renders through
renderToStaticMarkup, and zustand's SSR snapshot is the store's INITIAL
state -- calling setMode before rendering changes nothing in the markup. So
those cases test the mode the workspace opens with, which is not a thin
sample: the fs-tree declares all three control kinds. The other modes'
controls are held by the sweep in registry.test.ts, which needs no renderer
to check that each is explained. Both limits are written into the file's
docstring rather than worked around.

I also lost the first pass of this work by running `git checkout -- src` in
a mutation loop over uncommitted changes. Redone, and the mutations were
re-run against a staged baseline so the revert restores the index.
