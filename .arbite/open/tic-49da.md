---
id: tic-49da
title: 'CLI subcommands: init/update a .adventure-call store, full help'
status: open
type: feature
tier: high
domain: io
epic: agent-cli
priority: 1
tags:
- cli
- agents
- store
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-14T11:08:04'
updated: '2026-09-14T11:08:04'
closed: null
---

## Description
Restructure the CLI into subcommands. 'init [ROOT]' creates ROOT/.adventure-call/ (config.json with analysis options, analysis JSON, AGENTS.md, .gitignore) and runs the analysis; 'update' re-runs it from the saved config, found by walking up from cwd. Legacy 'adventure-call ROOT ...' keeps working as 'analyze'. Every command carries full --help text. AGENTS.md is generated, starts with a note to keep it concise but comprehensive.

## Notes
