---
id: tic-7a5e
title: 'Mode 3: the rooted local view -- one function''s call flow, upstream and down'
status: in_progress
type: feature
tier: high
domain: ui
epic: call-flow
priority: 5
tags:
- mode
- call-flow
- focus
assignee: claude.opus.001
depends_on:
- tic-d8a8
blocked_by: null
created: '2026-09-01T07:24:42'
updated: '2026-09-01T12:43:31'
closed: null
---

## Description
The mode's focused state, and the thing the whole feature is for: pick a function, see what it can set in motion and what can reach it.

`focusPath` here names a SYMBOL ID. That is a third meaning for the same per-mode field -- fs-tree reads it as a directory, import-graph as a file (tic-d7d7's Local View), and App.tsx's resolveGotoScope already documents that divergence and guards against handing one mode another's kind of path. Extend that guard; do not let a directory path reach this mode.

Conceptually this is get_room_context from the README -- callers on one side, callees on the other -- generalised from one hop to N and given a picture.

Params: direction (downstream / upstream / both), depth limit, and whether recursive clusters render condensed or expanded. Direction matters more than it sounds: "what does this trigger" and "who can reach this" are different questions asked at different moments, and showing both at once is usually too much.

Clicking any node in the view re-roots on it. That is the mode's own navigation and needs nothing from tic-e738 -- it is a plain focusPath change, the same gesture import-graph's Local View already supports.

Depth needs a real default chosen against real data, not a guess: measure how many nodes depth 1/2/3/4 pulls in for a few representative ../carnot functions (a leaf utility, a mid-layer helper, a top orchestrator) and record the numbers in the notes before picking. A default that explodes on orchestrators makes the mode feel broken.

Verification: browser-verify all three directions against a known ../carnot function with both callers and callees; verify a recursive cluster expands and collapses; verify re-rooting by click; verify depth capping. npm run test, tsc -b.

## Notes
