---
id: tic-b47a
title: 'Parser: record a control-flow breadcrumb for every call site'
status: open
type: feature
tier: high
domain: io
epic: call-flow
priority: 7
tags:
- parser
- tree-sitter
- control-flow
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-01T07:23:01'
updated: '2026-09-01T07:23:01'
closed: null
---

## Description
The extraction that turns a call GRAPH into a call FLOW: for each call site, what control-flow constructs it sits inside, relative to its enclosing definition.

_PythonExtractor._build_calls (adventure_call/parser.py) already walks up from a call node to find its enclosing definition via _enclosing_symbol. Extend that same walk to collect the chain of control-flow constructs it passes through on the way, and store it on CallSite (adventure_call/models.py) -- a compact ordered list such as ["if", "for", "try:except"], innermost last, stopping at the enclosing def so a nested function's breadcrumb is relative to ITS body and not the outer one.

Constructs worth distinguishing: if / elif / else, match-case, for / while (the call can fire N times), try-body vs except vs finally (error-path calls read completely differently from happy-path ones), with, boolean short-circuit (`and`/`or`/ternary/comprehension guard -- the call is conditional even though no statement guards it), and `if TYPE_CHECKING` (which is NOT runtime flow at all and must be separable). Derive `guard_depth` from the chain rather than storing it twice.

Naming discipline, decided with the user 2026-09-01 and load-bearing for the whole mode: guard_depth == 0 means UNGUARDED, not "unconditional" and not "always". An early return or raise above the call kills it, and the caller may itself be conditional, so "always" would be a lie the UI then repeats. Use the word `unguarded` in the field names, the docstrings and anything user-facing. tic-3a20 covers the honest "unavoidable" answer separately.

Costs and constraints: this is one extra upward walk per call site on nodes already visited, so it should not measurably change parse time -- measure and record it. The exported JSON grows by a short list per call site; check the size delta on ../carnot (currently 5.2MB graph / 9.5MB registry) and say whether it matters. Bump SCHEMA_VERSION and mirror the new fields in web/src/data/types.ts, which is hand-written from models.py and must stay in sync.

Verification: parser tests over fixtures covering each construct, nesting, a call in a nested def (breadcrumb relative to the inner def), a call in a comprehension guard, and a TYPE_CHECKING import block. Confirm a full ../carnot run still produces zero diagnostics. Run the Python test suite.

## Notes
