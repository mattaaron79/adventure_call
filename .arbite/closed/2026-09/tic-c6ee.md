---
id: tic-c6ee
title: derive.ts holds literal NUL bytes, so git and grep treat it as binary
status: closed
type: bug
tier: low
domain: ui
epic: call-flow
priority: 6
tags: []
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-01T08:09:52'
updated: '2026-09-01T12:50:04'
closed: '2026-09-01T12:50:04'
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
- 2026-09-01T12:50:04 claude.opus.001: Two raw NUL bytes, not one: the map-key separators in deriveFileImports (line 222) and deriveExternalCalls (line 824). Both are now the \u0000 escape, byte-identical at runtime and already the form used at the other two key-separator sites (deriveExternalImports line 730, deriveWorkspace line 907) -- so this is consistent now, not merely fixed. Verified: git diff --stat reports a line count instead of 'Bin', grep -n finds all four separators, 628 web tests pass unchanged. Found while working tic-7a5e, where it had forced every edit to derive.ts through a python script.
