---
id: tic-f21f
title: Coverage should separate 'leaves the project' from 'we could not follow it'
status: closed
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 6
tags: []
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-01T14:58:58'
updated: '2026-09-01T17:04:33'
closed: '2026-09-01T17:04:33'
---

## Description
This is a **raw** ticket: it was captured from a brief request without proper classification. It must be filled out before it can be worked.

Original request: tic-97ce now classifies unresolved calls by WHERE they go -- 'external: rich.console.Console', 'stdlib method on list', 'foreign base: textual.app.App' -- but tic-171f's coverage figure still counts every one of them as unresolved, which reads as 'the analysis has a hole here' when the truthful reading is 'this call leaves the project and we know exactly where to'. Measured on carnot 619 of the 6226 unresolved sites are now positively identified this way (301 stdlib, 142 foreign base, 176 newly external) and on hypermenu 183 of 3524; that is on top of the external calls the export always knew about. Coverage should report at least three buckets rather than two: resolved in-project, known to leave the project (external/stdlib/foreign base), and genuinely unfollowed (computed callee, ambiguous, unknown receiver). Mode 3 already draws external sinks, so the first two are both flow the picture can show; only the third is a hole. Needs a decision on whether the headline percentage counts 'leaves the project' as covered -- I think it should, with the breakdown beside it, because a call into django is not a failure of the analysis.

What still needs to be done (human or agent triage, typically via `arbite fetch`):
- title -- replace "Requires Classification" with a short human-readable summary
- tier -- low | medium | high | frontier (agent capability tier required to work it; how capable the agent must be, not how urgent the work is)
- domain -- e.g. mesh, image_gen, audio_gen, ui, io (drives routing)
- epic -- this raw ticket is auto-grouped under the 'classification' epic (so triage can find it with `arbite list next --epic classification`); replace it with the real epic this work belongs to, e.g. mesh-pipeline
- priority -- numeric urgency index, lower = more urgent
- description -- expand this body into a proper task description based on the original request, including any acceptance criteria
- status -- set to `open` once classified so it becomes workable via `arbite list next` (skip this if you're claiming it yourself instead -- `arbite claim` sets status to `in_progress` directly)

## Notes
- 2026-09-01T17:04:32 claude.opus.001: Done. Three buckets, and a double-count bug in tic-171f fixed on the way.

## The bug that was there already

`stats.calls_heuristic` is a SUBSET of `stats.calls_resolved` -- writer.py
counts the resolved list and then filters it by confidence -- but the coverage
figure summed the two, in both the numerator and the denominator. carnot read
"38% of call sites resolved (4279 exact + 786 heuristic of 13191)" where the
honest figure is 34% of 12405; the denominator was 786 larger than the number
of call sites the codebase has, and `exact` was never exact, it was every
resolution including the heuristic ones.

Two tic-171f tests asserted the wrong arithmetic (`total: 13062`), so they were
rewritten rather than deleted, and there is now a test whose whole job is that
the buckets sum to the total.

## Three buckets

  inProject     landed on a project symbol -- the edges the graph draws
  outOfProject  destination known, not in this project: builtins, plus
                tic-97ce's external: / stdlib method on / foreign base:
  unknown       destination not known; `computed` is the subset where flow
                provably leaves the map rather than merely not being followed

Measured on the real exports, this is the difference between a report and a
misreport:

  carnot     12,405 sites   34% in project · 31% out of project · 34% unknown
  hypermenu   4,879 sites   19% in project · 36% out of project · 45% unknown

Reported as "19% resolved", hypermenu looks like an analysis that failed. It is
not: better than a third of its calls go into django, and we can now say which
django. The old line could not tell that apart from a call we cannot place.

HUD, verified end to end against both exports:

  12,405 call sites · 34% in project · 31% out of project · 34% unknown ·
      847 computed callees

## The decision the ticket asked for

I filed this asking whether the headline percentage should count "leaves the
project" as covered. Answer: there is no headline percentage any more. Three
proportions that add to 100 say the true thing without needing one number to
carry it, and any single number here would be choosing which of two honest
readings to privilege -- "how much of the graph did we draw" (34%) and "how
much of the flow can we account for" (66%) are both true and are different
questions. The line states the parts and lets the reader take either.

## Degrading before the registry lands

The reason split needs `unresolved_calls`, which arrives with the registry a
moment after the graph. Until then everything unresolved sits in `unknown`,
`classified` is false, and the HUD shows what it can stand behind:

  12,405 call sites · 34% in project · 66% elsewhere — classifying…

rather than publishing a 66%-unknown share that halves a second later. That
understates outOfProject, which is the honest direction to be wrong in.

## Deliberately NOT done

The per-node clause on a chip still reads `3/9 sites resolved · 2 computed` and
was left alone. Adding `· 4 out of project` would push a sublabel that already
carries module, framework, reach and coverage past the 320px chip cap, and a
clause that overflows makes the picture worse than the pessimism does. The
data is there (destinationOf is exported) whenever something with more room --
the inspector -- wants it.

## Verification

678 web tests (up from 671), tsc -b clean, production build clean.
Mutation-checked all three rules: restoring the double-count fails 5 tests,
un-teaching destinationOf the out-of-project prefixes fails 3, and claiming a
full split before the registry lands fails 2.
Verified end to end against the real carnot and hypermenu exports: the HUD
line reads correctly in both the classified and unclassified states, and the
buckets sum exactly to the total in both.
