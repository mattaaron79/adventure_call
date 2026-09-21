---
id: tic-0e70
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
created: '2026-09-20T23:50:14'
updated: '2026-09-20T23:50:14'
closed: null
---

## Description
This is a **raw** ticket: it was captured from a brief request without proper classification. It must be filled out before it can be worked.

Original request: Re-exported names produce no IMPORTS edge: with src/core.py defining run, src/api.py doing 'from src.core import run' and tests/test_api.py doing 'from src.api import run', no edge is emitted from tests/test_api at all (verified by probe), while importing a name defined in src/api does emit one. So the file import graph, and with it imports/impact/tests, misses dependencies that go through a re-export hub (a package __init__, a facade module). Tests that reach a changed module only that way can be missed.

What still needs to be done -- human or agent triage, which `arbite fetch` starts and `arbite promote <id>` finishes in one write:
- title -- replace "Requires Classification" with a short human-readable summary
- tier -- low | medium | high | frontier (agent capability tier required to work it; how capable the agent must be, not how urgent the work is)
- domain -- e.g. mesh, image_gen, audio_gen, ui, io (drives routing)
- epic -- this raw ticket is auto-grouped under the 'classification' epic (so triage can find it with `arbite list next --epic classification`); pass the real epic this work belongs to (e.g. mesh-pipeline) to `arbite promote` and it replaces that grouping
- priority -- numeric urgency index, lower = more urgent
- description -- expand this body into a proper task description based on the original request, including any acceptance criteria
- status -- `arbite promote <id> ...` classifies these fields in place and moves the ticket to `open` (or claims it in the same command with `--agent <your-id>`) so it becomes workable via `arbite list next`; the same fields can still be written by hand with `arbite set`

## Notes
