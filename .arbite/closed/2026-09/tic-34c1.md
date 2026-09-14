---
id: tic-34c1
title: 'Agent query commands: find/symbol/file/tree/imports/calls/entries/impact/state/overview/source'
status: closed
type: feature
tier: high
domain: io
epic: agent-cli
priority: 3
tags:
- cli
- agents
- query
assignee: claude.opus.001
depends_on:
- tic-5671
- tic-49da
blocked_by: null
created: '2026-09-14T11:08:05'
updated: '2026-09-14T11:21:02'
closed: '2026-09-14T11:21:02'
---

## Description
Expose the query layer as CLI subcommands with compact JSON output, exit codes (0 ok, 1 error, 2 no match, 3 no store), stale-index warning on stderr, and document them in the generated AGENTS.md.

## Notes
- 2026-09-14T11:21:02 claude.opus.001: Query commands overview/find/symbol/file/tree/imports/calls/entries/impact/state/orphans/source; compact JSON, exit codes 0/1/2/3, auto-refresh on stale sources (--no-refresh to warn only). Verified on a copy of ../diku (115 files): queries <0.2s, refresh ~3s.
