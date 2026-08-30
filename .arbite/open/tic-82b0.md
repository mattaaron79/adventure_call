---
id: tic-82b0
title: 'Parser: extract class attributes and module-level constants as symbols'
status: open
type: feature
tier: high
domain: io
epic: viz-workspace
priority: 2
tags:
- parser
- tree-sitter
- schema
assignee: null
depends_on: []
blocked_by: null
created: '2026-08-30T11:54:24'
updated: '2026-08-30T11:54:24'
closed: null
---

## Description
The expanded-file view needs class variables and module constants; the tree-sitter query captures only defs, imports and calls today. Independent of the frontend -- can run in parallel.

- adventure_call/queries/python.scm: add an assignment capture. Plain and annotated assignment share the (assignment left: (identifier)) shape, so one pattern covers both.
- adventure_call/parser.py (_build_symbols / _build_symbol): keep ONLY assignments whose enclosing block is a class body (kind 'attribute') or the module top level (kind 'variable'). Discard anything inside a function body. Record the annotation and a truncated RHS as the signature.
- adventure_call/models.py:12 -- widen SymbolKind to include 'variable' | 'attribute'.
- Audit resolver.py and graph.py: the new kinds must be indexed and appear in modules[*].symbol_ids, but must NEVER be treated as call targets. In particular the unique-name heuristic must not start resolving calls to a variable.
- Schema stays additive: schema_version remains 1, only new kind values appear.
- Update tests/, then regenerate /out.

OUT OF SCOPE (flag for a later ticket): self.x = ... instance attributes assigned in __init__.

EXIT: stats.node_kinds gains 'variable' and 'attribute'; existing tests still pass.

## Notes
