---
id: tic-2caf
title: 'Inspector: "Imported By" section above "Imports"'
status: open
type: feature
tier: medium
domain: ui
epic: viz-modes-next
priority: 15
tags:
- inspector
- imports
- imported-by
assignee: null
depends_on:
- tic-0680
blocked_by: null
created: '2026-08-31T20:28:48'
updated: '2026-08-31T20:28:48'
closed: null
---

## Description
User request: imports in Files and symbols are a one-way relationship; the details card should also show who imports this file, as an "Imported By" section placed ABOVE "Imports". Confirmed with the user 2026-08-31: the inspector shows it for any selection (it is shared chrome across modes); the Files and symbols expanded containers stay as they are, and the import-graph container half is tic-ea9d.

WORK in web/src/ui/Inspector.tsx
1. Add buildImportedByRows(workspace, filePath): ImportRow[] beside the existing buildImportRows (~line 115), reading the reverse index tic-0680 adds to the Workspace (fileImporters). One row per importing file: key like "impby:" + importerPath, goto set to that importer path so the row renders a GotoIcon that flies the camera there, external false, count from the edge. Reuse the existing ImportRow interface rather than inventing a parallel one -- the rendering markup is then shared.
2. Render the section immediately above the existing Imports block (~line 342), with the same h3 + ul.inspector-list markup and the same row rendering, so no new CSS is needed. Omit it when there are no importers, exactly as Imports does.
3. The inspector resolves its file path from the selected node (normalizePath(node.file_path)) and already shows Imports for symbol selections as well as module selections -- match that behaviour rather than restricting to modules.

Verification: cd web && npm run test -- add cases to web/src/ui/Inspector.test.ts for buildImportedByRows (a file with several importers, a file nobody imports, a goto target set on every row). npm run build. npm run dev: select a widely-imported file (in either mode) and confirm Imported By lists its importers above Imports, that each row goto flies the camera to the right file, and that a leaf file nobody imports shows no section at all.

## Notes
