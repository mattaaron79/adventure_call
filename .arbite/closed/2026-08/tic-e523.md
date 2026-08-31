---
id: tic-e523
title: vscode:// deep link opens a blank tab; launch via JS without a blank tab
status: closed
type: bug
tier: low
domain: ui
epic: viz-workspace
priority: 2
tags:
- inspector
- vscode
- deep-link
- ui
assignee: code
depends_on: []
blocked_by: null
created: '2026-08-30T22:51:16'
updated: '2026-08-30T22:54:46'
closed: '2026-08-30T22:54:46'
---

## Description
User feedback: clicking a source-code location in the Inspector (web/src/ui/Inspector.tsx) opens the vscode://file/... deep link with target='_blank', which launches VS Code but also leaves a blank, inert browser tab behind. Launch the protocol link with JavaScript instead of a plain target=_blank anchor: intercept the click, preventDefault, and hand the URL to the OS protocol handler via a hidden iframe (or equivalent) so VS Code opens without a stray blank tab. Keep the href on the anchor for copy/context-menu affordance. Consider middle-click/ctrl-click behaviour too so they do not spawn a blank tab.

## Notes
- 2026-08-30T22:54:46 code: Replaced the target='_blank' anchor on the inspector path link with an intercepted click: launchVscodeLink() (ui/Inspector.tsx) routes the vscode:// scheme through a hidden iframe that is removed after the OS takes over, so VS Code opens with no blank browser tab left behind. The href stays on the anchor for copy/right-click. 2 new tests; 285 web tests pass; tsc -b clean.
