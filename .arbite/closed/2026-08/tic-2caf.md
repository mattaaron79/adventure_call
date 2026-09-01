---
id: tic-2caf
title: 'Inspector: "Imported By" section above "Imports"'
status: closed
type: feature
tier: medium
domain: ui
epic: viz-modes-next
priority: 15
tags:
- inspector
- imports
- imported-by
assignee: claude.opus.004
depends_on:
- tic-0680
blocked_by: null
created: '2026-08-31T20:28:48'
updated: '2026-08-31T22:21:55'
closed: '2026-08-31T22:21:55'
---

## Description
User request: imports in Files and symbols are a one-way relationship; the details card should also show who imports this file, as an "Imported By" section placed ABOVE "Imports". Confirmed with the user 2026-08-31: the inspector shows it for any selection (it is shared chrome across modes); the Files and symbols expanded containers stay as they are, and the import-graph container half is tic-ea9d.

WORK in web/src/ui/Inspector.tsx
1. Add buildImportedByRows(workspace, filePath): ImportRow[] beside the existing buildImportRows (~line 115), reading the reverse index tic-0680 adds to the Workspace (fileImporters). One row per importing file: key like "impby:" + importerPath, goto set to that importer path so the row renders a GotoIcon that flies the camera there, external false, count from the edge. Reuse the existing ImportRow interface rather than inventing a parallel one -- the rendering markup is then shared.
2. Render the section immediately above the existing Imports block (~line 342), with the same h3 + ul.inspector-list markup and the same row rendering, so no new CSS is needed. Omit it when there are no importers, exactly as Imports does.
3. The inspector resolves its file path from the selected node (normalizePath(node.file_path)) and already shows Imports for symbol selections as well as module selections -- match that behaviour rather than restricting to modules.

Verification: cd web && npm run test -- add cases to web/src/ui/Inspector.test.ts for buildImportedByRows (a file with several importers, a file nobody imports, a goto target set on every row). npm run build. npm run dev: select a widely-imported file (in either mode) and confirm Imported By lists its importers above Imports, that each row goto flies the camera to the right file, and that a leaf file nobody imports shows no section at all.

## Notes
- 2026-08-31T22:21:54 claude.opus.004: Implemented. buildImportedByRows(workspace, filePath) sits beside buildImportRows in web/src/ui/Inspector.tsx and reads tic-0680's fileImporters reverse index, so answering 'who imports this' is a map lookup rather than a scan of every edge. One row per importing FILE, not per symbol: the forward Imports section names symbols because that is what an import statement binds, but the incoming relationship is a fact about files -- one importer pulling three symbols is one dependency, not three, and the edge count still rides on the row so a repeated import is visible without inflating the list. Rows are never marked external, because an external module is something this codebase imports and never something that imports it. The label mirrors the Imports rows (name · module via index.moduleByFile, raw path as the fallback) so the two sections read as siblings. REFACTOR I made rather than duplicating: the Imports block's markup was lifted into a small local ImportSection component now used for both directions, so the two lists cannot drift apart and there is still no new CSS -- same h3, same ul.inspector-list.inspector-imports, same per-row goto icon and count. Both sections render nothing at all when empty, which is how Imports always behaved. Placement is above Imports per the user's request; the section shows for symbol selections as well as module ones, since the card already resolves everything through normalizePath(node.file_path). VERIFICATION: 422 -> 431 tests (9 new: 6 on the builder covering fan-in, count, empty-for-a-leaf, never-external, the raw-path fallback and the module-shaped label; 3 rendering the real component through renderToStaticMarkup to assert Imported By precedes Imports on a file that has both directions, that each importer renders with its goto affordance, and that a file nobody imports omits the section while keeping its own Imports). Asserting the ORDER needed a file with both incoming and outgoing edges, which the shared fixture did not have, so that one test builds a local workspace with an extra outgoing edge rather than mutating the fixture other suites depend on. tsc -b and production build clean.
