---
id: tic-9ff4
title: 'Fix: src-layout module ids don''t match import paths, so in-project calls
  resolve as external'
status: open
type: bug
tier: medium
domain: io
epic: null
priority: 2
tags:
- resolver
- module-ids
- src-layout
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-01T07:21:52'
updated: '2026-09-01T07:21:52'
closed: null
---

## Description
Module ids are derived from file paths, so `src/carnot/kernel/types.py` becomes `src.carnot.kernel.types`, but the source imports it as `carnot.kernel.types`. SymbolResolver cannot match the two, so it classifies in-project symbols as external and drops the call.

Measured against the current ./out export of ../carnot: 823 unresolved calls whose `reason` literally reads `external: carnot.*` -- e.g. `external: carnot.kernel.types.ToolResult` (148), `external: carnot.agent.session.Session` (64), `external: carnot.agent.loop.Agent` (62), `external: carnot.kernel.types.ToolCall` (53). Confirmed the targets exist in the registry under the `src.` prefix (`src.carnot.kernel.types.ToolResult` is present); nothing is genuinely external about them.

Every src-layout project hits this, and it silently costs ~10% of the non-builtin call graph. Fix in adventure_call/resolver.py (see `_absolute_module` / `_build_indexes`): infer the import root prefix rather than assuming the analysed root is the import root. Two candidate signals, in order -- read the project's package configuration (pyproject `[tool.setuptools.packages.find] where`, `[tool.hatch.build] packages`, or poetry `packages`), and failing that detect the conventional `src/` layout by looking for a single directory child of the root that contains packages but is not itself a package (no `__init__.py`). Register each module under both its path-derived id and its import-visible name so existing ids stay stable and nothing downstream has to change.

Verification: re-run against ../carnot and confirm `external: carnot.*` reasons drop to zero and calls_resolved rises by roughly the 823 sites counted above; add a parser/resolver test with a fixture project in src layout asserting a cross-module call resolves; confirm a flat-layout fixture still resolves exactly as before (no regression). Run the Python test suite.

## Notes
