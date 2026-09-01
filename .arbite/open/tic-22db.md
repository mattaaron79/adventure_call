---
id: tic-22db
title: Entry points, including decorator-derived roots
status: open
type: feature
tier: medium
domain: ui
epic: call-flow
priority: 4
tags:
- call-graph
- entry-points
- decorators
assignee: null
depends_on:
- tic-a8a6
blocked_by: null
created: '2026-09-01T07:23:45'
updated: '2026-09-01T07:23:45'
closed: null
---

## Description
An entry point is where execution enters the codebase, and it is the root the call-flow mode hangs off. In-degree zero over CALLS is the naive definition and it LIES: web routes, CLI commands, event handlers, fixtures and properties are all called by a framework, not by project code, so they look like orphans while actually being the real roots.

Fix that with the decorators already in the export. Sample from ../carnot: `@pytest.fixture` (43), `@property` (42), `@classmethod` (6), `@staticmethod` (2), `@on(Button.Pressed, "#allow")`, `@work(thread=True, exclusive=True)`, `@metric(...)`. Match on the decorator's dotted head, ignoring call arguments, so `@on(Input.Submitted, "#prompt")` and `@on(TabbedContent.TabActivated)` both classify as the same role.

Deliver, in the derive layer next to tic-a8a6's call graph: a per-symbol classification into a small role vocabulary -- something like `entry` (in-degree zero, no decorator explanation), `framework-entry` (decorator says a framework calls it, with the role named: route / command / fixture / handler / task / property), `internal` (has in-project callers), and `orphan` (no callers, no callees, no decorator role -- possibly dead, possibly only called dynamically). Say `possibly` in the UI copy; 902 computed callees mean dead-code claims are not safe.

Make the decorator -> role map DATA, not code, and put it somewhere a user can extend without a rebuild -- every codebase has its own decorators, and a hardcoded list is stale the moment it meets a second project.

Verification: unit tests over synthetic graphs for each role, decorator matching with and without arguments, dotted decorators, and an unknown decorator falling through to plain in-degree logic. Against the real export, report how many apparent orphans the decorator map rescues -- that number is the ticket's whole justification. npm run test, tsc -b.

## Notes
