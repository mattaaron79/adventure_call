---
id: tic-b0b7
title: Fix VS Code Vite dev-server problem matcher config
status: closed
type: bug
tier: medium
domain: ui
epic: null
priority: 3
tags:
- vscode
- vite
- dev-server
- problem-matcher
assignee: copilot
depends_on: []
blocked_by: null
created: '2026-08-30T13:41:56'
updated: '2026-08-30T13:43:49'
closed: '2026-08-30T13:43:49'
---

## Description
The VS Code dev-server task is not matching Vite startup output correctly, so the integrated terminal/task status fails to report a ready dev server and may not attach the browser preview or problem detection reliably. Investigate the workspace VS Code config for the Vite dev server and align the problem matcher pattern with the actual output from 
pm run dev so the server is recognized as started, without altering project behavior beyond the editor configuration.

## Notes
