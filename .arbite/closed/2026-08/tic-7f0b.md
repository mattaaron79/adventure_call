---
id: tic-7f0b
title: 'Fix: vscode:// links point at the wrong directory; record the absolute root
  at generation'
status: closed
type: bug
tier: medium
domain: io
epic: viz-workspace
priority: 2
tags:
- parser
- writer
- schema
- vscode
- devserver
assignee: code
depends_on: []
blocked_by: null
created: '2026-08-30T20:57:41'
updated: '2026-08-30T21:24:48'
closed: '2026-08-30T21:24:48'
---

## Description
The inspector's source link opens the wrong path. Confirmed against the current export:

  graph.graph.root            = '../carnot'   (relative to the CWD adventure-call ran in)
  plugin resolves it against  = Y:/projects/adventure_call/out
  produces                    = Y:/projects/adventure_call/carnot   <-- does not exist
  the real root is            = Y:/projects/carnot

web/plugins/outData.ts resolves the stored root against the OUT DIRECTORY, but the root was written relative to the generation cwd, which is one level up. Nothing in the export records that cwd, so no amount of client-side or dev-server guessing can recover it. As the user suspected, the fix belongs at generation time.

WORK
1. adventure_call/writer.py -- write the ABSOLUTE, resolved analysed root into both exports alongside the existing relative 'root'. Add it as a new field (e.g. 'root_abs') rather than changing the meaning of 'root', which existing consumers and the tests rely on. Use a POSIX-style absolute path for consistency with every other path in the exports, and keep the drive letter on Windows. Update adventure_call/writer.py's stats/metadata tests to cover it.
2. This is additive, so schema_version stays 1. Regenerate /out.
3. web/plugins/outData.ts -- prefer 'root_abs' when present; fall back to today's resolve-against-out-dir only when it is absent, so an older export still does something rather than nothing. web/src/data/types.ts gains the optional field.
4. web/src/ui/Inspector.tsx already degrades to plain text when no absolute root is available -- keep that path working, and keep the existing link-building unit tests in web/src/ui/Inspector.test.ts.

EXIT: clicking the path in the inspector opens the correct file at the correct line in VS Code; an export written before this change still loads and simply shows a non-link path.

## Notes
- 2026-08-30T21:24:45 code: Implemented root_abs at generation in writer.py (schema stays v1): both exports now carry absolute resolved POSIX root alongside relative root. outData.ts prefers root_abs and falls back to resolve-against-out-dir for old exports. Added writer tests (graph+registry root_abs, relative-root resolution, empty-root) and plugins/outData.test.ts (prefer/fallback/null). Backend: 114 passed. Web: 250 passed (19 files, incl. new outData tests). Regenerated /out against ..\carnot -> root_abs=Y:/projects/carnot (was resolving to wrong Y:/projects/adventure_call/carnot).
