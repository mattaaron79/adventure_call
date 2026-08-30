---
id: tic-82b0
title: 'Parser: extract class attributes and module-level constants as symbols'
status: closed
type: feature
tier: high
domain: io
epic: viz-workspace
priority: 2
tags:
- parser
- tree-sitter
- schema
assignee: claude
depends_on: []
blocked_by: null
created: '2026-08-30T11:54:24'
updated: '2026-08-30T12:33:42'
closed: '2026-08-30T12:33:42'
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
- 2026-08-30T12:33:42 claude.opus: Done. queries/python.scm gained one (assignment left: (identifier)) pattern covering plain, annotated and bare-annotation forms. parser._build_assignment keeps module-level ('variable') and class-body ('attribute') bindings and drops function locals; signature is 'name: annotation = RHS' with the RHS whitespace-flattened and truncated to 80 chars, and stub mirrors it. Calls are still attributed only to definitions, so 'X = compute()' at module level keeps caller_id None. Resolver: non-callable kinds are indexed in .symbols but kept out of by_name / module_members / class_members, so a constant can never make a function name ambiguous; _lookup_local and _walk_dotted require a callable, and the outcome() funnel in _resolve_call rejects any callee that is not function/method/class. Import bindings still point at constants, so IMPORTS edges to them are drawn. Regenerated /out against ../carnot: node_kinds now attribute 750, class 216, function 1439, method 646, module 193, variable 151. CALLS edges (2402) and calls_resolved (2929, 491 heuristic) are identical to the previous run, so no call resolution changed; IMPORTS went 322 to 337 because imports of constants now land on a real node. schema_version stays 1. Tests 91 to 107. Follow-up for self.x instance attributes filed as tic-88dd.
