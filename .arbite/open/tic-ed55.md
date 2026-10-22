---
id: tic-ed55
title: '--ephemeral: keep the store in a temp dir instead of the project'
status: open
type: feature
tier: medium
domain: cli
epic: null
priority: 2
tags: []
assignee: null
depends_on:
- tic-543c
blocked_by: null
created: '2026-10-22T11:43:24'
updated: '2026-10-22T11:43:28'
closed: null
---

## Description
Let a project be analysed and queried without creating PROJECT/.vcall/. With --ephemeral (init/update/queries/serve), the store lives under a per-user temp cache ($XDG_RUNTIME_DIR, else the system temp dir) keyed by the project root's absolute path, so repeat queries reuse the cached analysis and staleness check, but nothing survives a reboot and the project tree is never written. Store must therefore record its project root rather than deriving it from path.parent.

## Notes
