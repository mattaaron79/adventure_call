---
id: tic-799e
title: 'Parser: list each function''s local variable names (listed, not graphed)'
status: closed
type: feature
tier: medium
domain: io
epic: call-flow
priority: 9
tags:
- parser
- variables
- inspector
assignee: zai.glm.001
depends_on:
- tic-2255
blocked_by: null
created: '2026-09-01T07:23:02'
updated: '2026-09-01T19:59:54'
closed: '2026-09-01T19:59:54'
---

## Description
Decided with the user 2026-09-01: function locals are worth SEEING but not worth making nodes. They are invisible outside the function by definition, so as graph nodes they would be pure noise; as a list inside the expanded container and the inspector they answer "what does this function actually handle".

_build_assignment (adventure_call/parser.py) currently returns None for anything inside a function body, which is the right call for SYMBOLS -- keep that. Add, separately, a plain `locals: list[str]` on the callable's SymbolDef: names bound anywhere in its own body, deduplicated, in source order. Sources of a binding worth including: assignment targets (including tuple/starred targets, which _build_assignment deliberately skips), `for` targets, `with ... as`, `except ... as`, walrus, and comprehension targets. Do NOT include params (already on SymbolDef.params) and do NOT descend into nested defs -- their locals are their own.

This is a name list, not a symbol table and not a type inference. tic-97ce is where local binding turns into resolution; this ticket must not pre-empt its design.

Bump SCHEMA_VERSION, mirror in web/src/data/types.ts. Watch the export size: names are short but there are a lot of them -- measure the delta on ../carnot and report it.

Verification: parser tests for each binding form, tuple unpacking, shadowing (deduplicated, one entry), a nested def whose locals stay out of the outer function's list, and a comprehension. Run the Python test suite.

## Notes
- 2026-09-01T19:51:18 zai.glm.001: Design settled: walk each function body stopping at nested defs/classes; collect assignment/for/with-as/except-as/walrus/comprehension targets via a recursive pattern-name helper; dedupe in source order onto SymbolDef.locals. Bumping SCHEMA_VERSION 6->7 and mirroring in web types.

- 2026-09-01T19:59:46 zai.glm.001: Implemented. SymbolDef.locals (list[str]) added in models.py; parser._local_names walks each callable body stopping at nested defs/classes/decorated wrappers, collecting assignment/for/with-as/except-as/walrus/comprehension targets via _pattern_names (tuple+starred handled; this grammar parses 'with x as (a,b)' as as_pattern_target->tuple). Dedup, source order, params excluded. Augmented assignment/global/nonlocal deliberately out (rebind, not introduce). SCHEMA_VERSION 6->7 in writer.py, mirrored in web/src/data/types.ts (GraphNode.locals?: string[]). Tests: 7 new parser tests, suite 220 passed; tsc -p tsconfig.app.json clean. Export delta on ../carnot: +191,784 bytes (graph 6,614,071->6,805,855, +2.90%; registry 10,022,990->10,214,774, +1.91%); 5,158 local names on 1,720 of 4,437 callables, longest list 24.
