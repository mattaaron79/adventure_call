---
id: tic-de05
title: BreadcrumbToolbar infinite render loop blanks the SPA
status: closed
type: bug
tier: medium
domain: ui
epic: viz-workspace
priority: 1
tags:
- breadcrumb
- react
- render-loop
- ui
- canvas
assignee: code
depends_on: []
blocked_by: null
created: '2026-08-30T22:03:44'
updated: '2026-08-30T22:06:16'
closed: '2026-08-30T22:06:16'
---

## Description
Loading the SPA briefly shows the interface, then it goes blank with 'Uncaught Error: Maximum update depth exceeded' in BreadcrumbToolbar.tsx:54. The measurement useLayoutEffect depends on [crumbs, focusPath]; crumbs is a fresh array reference every render (elideBreadcrumbs always copies), so the effect re-runs every render, and setBox({ width, height }) passes a new object each time (never Object.is-equal), so every render schedules another -> infinite loop. Fix so the state update bails out when the measured size is unchanged, and stabilize the crumbs identity. Root cause reported from tic-b1ab's BreadcrumbToolbar.

## Notes
- 2026-08-30T22:05:56 code: Root cause: BreadcrumbToolbar built crumbs = elideBreadcrumbs(...) inline, a fresh array reference every render; the measurement useLayoutEffect keyed on [crumbs, focusPath] therefore re-ran after every render, and setBox({width,height}) passed a fresh object that is never Object.is-equal, so each render scheduled another -- the loop blew past React's update-depth limit and blanked the SPA. Fix: memoised crumbs on [focusPath] (canvas/BreadcrumbToolbar.tsx) so the effect only re-runs when the focus path changes, and made the size update bail out via a new sameSize() predicate in canvas/viewport.ts -- an unchanged measurement returns the previous state reference, letting React skip the render. Added 3 regression tests in viewport.test.ts for the sameSize contract. All 280 web tests pass; tsc -b clean.
