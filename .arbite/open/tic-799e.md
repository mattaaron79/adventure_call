---
id: tic-799e
title: 'Parser: list each function''s local variable names (listed, not graphed)'
status: open
type: feature
tier: medium
domain: io
epic: call-flow
priority: 9
tags:
- parser
- variables
- inspector
assignee: null
depends_on:
- tic-2255
blocked_by: null
created: '2026-09-01T07:23:02'
updated: '2026-09-01T07:26:55'
closed: null
---

## Description
Decided with the user 2026-09-01: function locals are worth SEEING but not worth making nodes. They are invisible outside the function by definition, so as graph nodes they would be pure noise; as a list inside the expanded container and the inspector they answer "what does this function actually handle".

_build_assignment (adventure_call/parser.py) currently returns None for anything inside a function body, which is the right call for SYMBOLS -- keep that. Add, separately, a plain `locals: list[str]` on the callable's SymbolDef: names bound anywhere in its own body, deduplicated, in source order. Sources of a binding worth including: assignment targets (including tuple/starred targets, which _build_assignment deliberately skips), `for` targets, `with ... as`, `except ... as`, walrus, and comprehension targets. Do NOT include params (already on SymbolDef.params) and do NOT descend into nested defs -- their locals are their own.

This is a name list, not a symbol table and not a type inference. tic-97ce is where local binding turns into resolution; this ticket must not pre-empt its design.

Bump SCHEMA_VERSION, mirror in web/src/data/types.ts. Watch the export size: names are short but there are a lot of them -- measure the delta on ../carnot and report it.

Verification: parser tests for each binding form, tuple unpacking, shadowing (deduplicated, one entry), a nested def whose locals stay out of the outer function's list, and a comprehension. Run the Python test suite.

## Notes
