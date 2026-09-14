---
id: tic-13aa
title: 'file PATH: --match and --kind filters for the outline'
status: open
type: feature
tier: low
domain: io
epic: agent-cli
priority: 5
tags:
- cli
- query
- file
- vcall-feedback
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-14T14:21:56'
updated: '2026-09-14T14:21:56'
closed: null
---

## Description
Agent feedback (diku tic-2e31): 'vcall file expedition/world.py' produced >15KB of JSON and the agent post-filtered the outline with a python one-liner; asked for a methods-only / outline flag.

Add to Workspace.file and the CLI:
- --kind KINDS (comma-separated: class,function,method,variable,attribute) filters outline rows; a class row is kept when any of its matching members are kept, so indentation still reads.
- --match TEXT (case-insensitive substring on the outline label/name) filters rows the same way.
- --outline-only drops imported_by/imports/external (the import sections are often most of the rest).
Acceptance: tests on src/api.py (e.g. --kind method keeps Router + its methods only; --match login keeps handle_login); help text; AGENTS.md row updated in one short phrase.

## Notes
