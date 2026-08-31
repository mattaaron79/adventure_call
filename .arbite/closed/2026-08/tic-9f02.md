---
id: tic-9f02
title: 'Breadcrumb toolbar: fix top overlap, add subtle ''/'' separators, swap ''/''
  and ''..'' order'
status: closed
type: bug
tier: low
domain: ui
epic: viz-workspace
priority: 1
tags:
- breadcrumb
- toolbar
- canvas
- ui
assignee: code
depends_on: []
blocked_by: null
created: '2026-08-30T22:51:16'
updated: '2026-08-30T22:53:14'
closed: '2026-08-30T22:53:14'
---

## Description
Three breadcrumb-toolbar polish items from user feedback (all in web/src/canvas/BreadcrumbToolbar.tsx / breadcrumbs.ts):

## Notes
- 2026-08-30T22:53:14 code: Fixed top overlap: the above-branch placed the toolbar top at topY-GAP, so its bottom hung into the folder by height-GAP; extracted toolbarScreenY() into breadcrumbs.ts which subtracts the toolbar height so its bottom clears the folder boundary (matching the below placement). Swapped '..' and '/' nav button order (.. first). Added subtle '/' separators between crumb buttons (.crumb-sep). 3 new unit tests; 283 web tests pass; tsc -b clean.
