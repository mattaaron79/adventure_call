---
id: tic-543c
title: Rename the store directory .adventure-call/ to .vcall/
status: closed
type: refactor
tier: medium
domain: cli
epic: null
priority: 1
tags: []
assignee: claude.opus-5.001
depends_on: []
blocked_by: null
created: '2026-10-22T11:43:23'
updated: '2026-10-22T11:44:22'
closed: '2026-10-22T11:44:22'
---

## Description
Change STORE_DIRNAME from '.adventure-call' to '.vcall' everywhere the store folder is named (store.py, cli/agents_doc/serve help text, web devServer plugin + tests, README, AGENTS.md template), and move this repo's own tracked store. No migration of existing stores: the user accepts that old projects break (they re-run 'vcall init'). Out of scope: the package/command name 'adventure-call' and the browser localStorage key prefix.

## Notes
- 2026-10-22T11:44:22 claude.opus-5.001: STORE_DIRNAME is now '.vcall' (store.py); every doc/help string naming the folder updated (README, agents_doc, cli, serve, tests, web devServer.test). This repo's tracked store moved with git mv to .vcall/ and its AGENTS.md regenerated. No migration: an old .adventure-call/ is simply not found. Package/command name and localStorage keys unchanged. pytest: 411 passed; vitest plugins/devServer.test.ts: 7 passed. Env note: the checkout's .venv and web/node_modules/.bin symlinks are broken on this filesystem (/mnt/storage), so tests ran in a scratch uv venv (UV_PROJECT_ENVIRONMENT) and vitest via node node_modules/vitest/vitest.mjs.

- 2026-10-22T11:44:22 claude.opus-5.001: Observable via integration testing: 'vcall init' in a project now creates PROJECT/.vcall/ (config.json, AGENTS.md, .gitignore, the analysis JSON); queries and 'vcall serve' find the nearest .vcall/ walking up from the cwd; a project that still only has .adventure-call/ behaves as if it had no store (exit 3, 'no .vcall/ found ... run adventure-call init'), so re-run init there and delete the old folder by hand.

- 2026-10-22T11:44:22 system: Submitted; closed (review disabled).
