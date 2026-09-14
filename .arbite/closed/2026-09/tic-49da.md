---
id: tic-49da
title: 'CLI subcommands: init/update a .adventure-call store, full help'
status: closed
type: feature
tier: high
domain: io
epic: agent-cli
priority: 1
tags:
- cli
- agents
- store
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-14T11:08:04'
updated: '2026-09-14T11:21:02'
closed: '2026-09-14T11:21:02'
---

## Description
Restructure the CLI into subcommands. 'init [ROOT]' creates ROOT/.adventure-call/ (config.json with analysis options, analysis JSON, AGENTS.md, .gitignore) and runs the analysis; 'update' re-runs it from the saved config, found by walking up from cwd. Legacy 'adventure-call ROOT ...' keeps working as 'analyze'. Every command carries full --help text. AGENTS.md is generated, starts with a note to keep it concise but comprehensive.

## Notes
- 2026-09-14T11:21:01 claude.opus.001: Done together with tic-34c1 (one CLI rewrite): adventure_call/store.py (Store.find walks up, config.json options, manifest.json mtimes for staleness, AGENTS.md from agents_doc.py, .gitignore), cli.py subcommands analyze/init/update/guide + queries, legacy positional form preserved, wrapped full help per command, adventure_call console alias. tests/test_cli.py.
