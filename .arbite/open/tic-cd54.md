---
id: tic-cd54
title: symbol --code prints source as raw text after the JSON; clarify AGENTS.md (--code,
  no analyze)
status: open
type: feature
tier: medium
domain: io
epic: agent-cli
priority: 4
tags:
- cli
- docs
- agents-md
- vcall-feedback
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-14T14:21:56'
updated: '2026-09-14T14:21:56'
closed: null
---

## Description
Three agents (diku tic-6949, tic-dac8, tic-2e31) asked for a 'combined symbol + source view'. It already exists as 'symbol ID --code', so this is discoverability plus ergonomics: the body is JSON-escaped inside 'code', which is hard to read and costs extra tokens.

Change:
- symbol --code: print the JSON (without the 'code' field) on the first line, then a blank line and the raw source under a '# ID path:start-end' header (same format as the source command). Keep --pretty working. Consider allowing multiple IDs for symbol (batch) if trivial.
- AGENTS.md (adventure_call/agents_doc.py): make the symbol row say '--code appends the body as plain text'; add the recipe 'Understand a function: symbol ID --code'.
- AGENTS.md: state explicitly that queries refresh the store automatically and agents should NOT run 'analyze' (it writes JSON into the cwd that the queries never read -- diku's instructions told agents to run 'vcall analyze .' after every ticket, leaving 17MB of stray files in the repo root). Mention 'vcall update' only for option changes.
- analyze: when run inside a directory that has a .adventure-call/ store and -o was not given, print a stderr hint: 'queries use .adventure-call/ and refresh automatically; you probably want vcall update'.

Acceptance: tests for the text layout of symbol --code; guide output contains the no-analyze note; AGENTS.md stays concise (the maintainer note at its top applies).

## Notes
