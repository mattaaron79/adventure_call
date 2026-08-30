---
id: tic-ed52
title: 'Scaffold web/ SPA: Vite+React+TS+Konva, F5 debug, live /out data server'
status: closed
type: feature
tier: medium
domain: ui
epic: viz-workspace
priority: 1
tags:
- frontend
- scaffold
- vite
- devserver
assignee: claude.opus
depends_on: []
blocked_by: null
created: '2026-08-30T11:53:44'
updated: '2026-08-30T12:00:51'
closed: '2026-08-30T12:00:51'
---

## Description
Stand up the SPA shell in web/ and the dev harness.

- web/ with Vite + React + TypeScript + konva/react-konva + zustand. Scripts: dev, build, preview, test (vitest).
- web/plugins/outData.ts (dev-only Vite plugin): middleware mapping /data/codebase_graph.json and /data/symbol_registry.json to <repoRoot>/out/. Register those files on Vite's existing server.watcher; on change send server.ws.send({type:'custom', event:'out-data:changed'}). Client subscribes via import.meta.hot.on and refetches. No extra deps, no second server process.
- .vscode/tasks.json: background task running 'npm run dev' in web/ with a problem matcher that resolves once Vite prints its URL.
- .vscode/launch.json: Chrome/Edge launch at http://localhost:5173 with preLaunchTask pointing at the dev task, sourcemaps on.
- Add web/node_modules and web/dist to .gitignore.

EXIT: F5 in VS Code builds, serves, opens the browser with the debugger attached, and the page shows node/edge counts read live from /out.

## Notes
- 2026-08-30T12:00:51 claude.opus: Verified end to end: tsc -b clean; vite build succeeds (446 kB / 138 kB gzip, sourcemaps on); npm audit 0 vulnerabilities after bumping vite to ^6.4.3 and vitest to ^4.1.11 to clear the bundled-esbuild advisories. Dev server serves /data/codebase_graph.json (3,666,622 B) and /data/symbol_registry.json (6,894,834 B) with Cache-Control: no-store; client parsed 2486 nodes / 2724 edges / 191 files, root ../carnot. Path allowlist holds -- encoded and raw traversal attempts fall through to the SPA index, never to a file. touch out/codebase_graph.json makes the watcher log 'out-data changed' and push the HMR event. Headless Chrome --dump-dom confirms React renders the sidebar with live stats and the Konva stage mounts and self-sizes via ResizeObserver. DEVIATION: src/data/types.ts (full schema mirror) landed here rather than in tic-3399 because the sidebar needed typed stats; tic-3399 still owns load/derive/filters.
