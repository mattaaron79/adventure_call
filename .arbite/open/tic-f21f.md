---
id: tic-f21f
title: Coverage should separate 'leaves the project' from 'we could not follow it'
status: open
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 6
tags: []
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-01T14:58:58'
updated: '2026-09-01T14:59:03'
closed: null
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
