---
id: tic-88dd
title: 'Parser: extract self.x instance attributes assigned in __init__'
status: open
type: feature
tier: high
domain: io
epic: viz-workspace
priority: 3
tags:
- parser
- tree-sitter
- schema
assignee: null
depends_on: []
blocked_by: null
created: '2026-08-30T12:33:19'
updated: '2026-08-30T12:33:19'
closed: null
---

## Description
Flagged out of scope by tic-82b0, which added module-level 'variable' and class-body 'attribute' symbols.

Instance attributes are still invisible: 'self.x = ...' inside a method has an (attribute) on the left of the assignment, not an (identifier), so queries/python.scm does not capture it and parser._build_assignment would reject it anyway.

- queries/python.scm: add a pattern for (assignment left: (attribute object: (identifier) attribute: (identifier))).
- parser.py (_build_assignment): keep only the ones whose receiver is self/cls and whose enclosing def is a method; hang the symbol off the owning CLASS (symbol_id 'mod.Class.x'), not off __init__.
- Decide what happens when the same name is assigned in several methods, and when a class attribute and an instance attribute share a name -- one symbol, first assignment wins, is probably right and matches the existing duplicate-id rule in resolver._build_indexes.
- Reuse the existing 'attribute' kind; no new SymbolKind, schema stays additive at version 1.
- The resolver contract from tic-82b0 must hold: indexed, never a call target.

EXIT: 'self.x = ...' in __init__ shows up as mod.Class.x with kind 'attribute'; existing tests still pass.

## Notes
