---
id: tic-501a
title: 'Deploy scripts: install/update adventure-call as a global tool on Linux and
  Windows'
status: closed
type: chore
tier: medium
domain: io
epic: agent-cli
priority: 4
tags:
- deploy
- install
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-14T11:08:05'
updated: '2026-09-14T11:22:28'
closed: '2026-09-14T11:22:28'
---

## Description
scripts/install.sh and scripts/install.ps1 (install == update): uv tool install from this checkout (pipx fallback) so adventure-call / adventure_call are on PATH from any directory. Document in README.

## Notes
- 2026-09-14T11:22:28 claude.opus.001: scripts/install.sh|update.sh (tested against an isolated UV_TOOL_DIR: install, --js extra, bad option) and install.ps1|update.ps1 (NOT executed: no pwsh on this machine). README Deploy section.
