---
id: tic-c6ee
title: 'bug (raw): Requires Classification'
status: raw
type: bug
tier: 'TODO: low|medium|high|frontier'
domain: 'TODO: e.g. mesh, image_gen, audio_gen, ui, io'
epic: classification
priority: null
tags: []
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-01T08:09:52'
updated: '2026-09-01T08:09:52'
closed: null
---

## Description
This is a **raw** ticket: it was captured from a brief request without proper classification. It must be filled out before it can be worked.

Original request: web/src/data/derive.ts contains a literal NUL byte at line 213 -- the map-key separator in deriveFileImports is written as a raw \x00 inside a template literal rather than as an escape like \0 or \u0000. It works at runtime, but git and grep both classify the file as binary: git diff shows no hunks without --text and reports '-' for numstat, and grep/ripgrep report 'Binary file matches' instead of results, which silently breaks code search over one of the most-edited files in the project. Fix is a one-character change to use an escape sequence; verify git diff and grep behave normally afterwards.

What still needs to be done (human or agent triage, typically via `arbite fetch`):
- title -- replace "Requires Classification" with a short human-readable summary
- tier -- low | medium | high | frontier (agent capability tier required to work it; how capable the agent must be, not how urgent the work is)
- domain -- e.g. mesh, image_gen, audio_gen, ui, io (drives routing)
- epic -- this raw ticket is auto-grouped under the 'classification' epic (so triage can find it with `arbite list next --epic classification`); replace it with the real epic this work belongs to, e.g. mesh-pipeline
- priority -- numeric urgency index, lower = more urgent
- description -- expand this body into a proper task description based on the original request, including any acceptance criteria
- status -- set to `open` once classified so it becomes workable via `arbite list next` (skip this if you're claiming it yourself instead -- `arbite claim` sets status to `in_progress` directly)

## Notes
