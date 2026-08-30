---
id: tic-88dd
title: 'Parser: extract self.x instance attributes assigned in __init__'
status: closed
type: feature
tier: high
domain: io
epic: viz-workspace
priority: 3
tags:
- parser
- tree-sitter
- schema
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-08-30T12:33:19'
updated: '2026-08-30T12:50:59'
closed: '2026-08-30T12:50:59'
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
- 2026-08-30T12:50:48 claude.opus.001: Done. queries/python.scm: second assignment pattern for (attribute object:(identifier) @assign.receiver attribute:(identifier) @assign.name); one-level only, so self.a.b is still out. parser._build_assignment branches on assign.receiver and calls the new _instance_attribute_owner(), which requires receiver in {self,cls} and the nearest enclosing def to be a function under a class -- a free function with a 'self' param yields nothing. Symbol hangs off the class (mod.Class.x, parent mod.Class), kind 'attribute', signature keeps the receiver ('self.x = 3') so instance and class-body attributes stay distinguishable without a new SymbolKind. Duplicates: _build_symbols now tracks taken ids across the assignment pass, so first binding in source order wins over later methods and over a same-named class attribute -- same rule as resolver._build_indexes. Resolver contract holds unchanged: 'attribute' is not in _CALLABLE_KINDS so it is indexed but never a call target. Tests: rewrote test_locals_and_instance_attributes_are_not_symbols (it asserted the old behaviour) and added 4 parser tests + 1 resolver test; 111 pass.
