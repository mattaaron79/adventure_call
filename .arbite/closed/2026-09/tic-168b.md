---
id: tic-168b
title: 'Serve: namespace persisted browser state by project so two served stores do
  not share it'
status: closed
type: chore
tier: medium
domain: ui
epic: vcall-serve
priority: 4
tags:
- web
- state
- localstorage
- serve
assignee: deepseek.v4flash.007
depends_on:
- tic-c336
blocked_by: null
created: '2026-09-21T21:00:36'
updated: '2026-09-21T21:38:07'
closed: '2026-09-21T21:38:07'
---

## Description
Goal: a browser that has visited project A and then project B (served from the same origin, or the same Vite dev server pointed at another store) must not carry A's camera, dragged node positions, focus scope, presets or file excludes into B.

Why: every persisted key is global to the origin today, keyed only by mode:
  - web/src/state/persist.ts:39 STORAGE_PREFIX 'adventure-call:workspace:' and storageKey() (line 41); UI_STORAGE_KEY and EXCURSION_STORAGE_KEY live in the same file (around lines 177 and 228);
  - web/src/data/filters.ts:101 EXCLUDES_STORAGE_KEY;
  - web/src/modes/presets.ts:61 PRESETS_STORAGE_KEY;
  - web/src/ui/paramHelp.ts:15 HELP_PINNED_KEY.
Node ids are project-specific, so overrides mostly miss harmlessly -- but focusPath, viewport, and the excludes list do not: dragging 'src' excludes from one project into another silently hides files.

Approach:
  1. Give the page a project key before the workspace state is first hydrated. The dev server already exposes a bootstrap document at /data/meta.json (web/plugins/outData.ts:21-23, 105-112) and the serve implementation copies it (tic-c336); add a 'project' field there, derived from the analysed root (root_abs, else the resolved relative root) -- e.g. the first 8 hex of a hash of that path, or a slugified basename plus a short hash so it is recognisable in devtools. Both servers must produce it: outData.ts for Vite, serve.py for the bundle.
  2. In persist.ts, add a module-level 'setProjectKey(key)' (called once during bootstrap, after meta.json resolves) and build every key from it: 'adventure-call:<project>:workspace:<modeId>', ':<project>:ui', ':<project>:excursion', and the same for filters, presets and the help pin. With no project key (a static build with no meta, or meta unavailable) fall back to today's unsuffixed keys so nothing breaks or throws -- the existing "storage unavailable / junk" degradation paths (persist.ts:54-60, 103-141) must keep working unchanged.
  3. Hydration ordering: App.tsx loads the graph and meta in one useEffect (App.tsx:70-77); make sure the project key is set before the store reads per-mode state, or re-hydrate the modes once it arrives (store.ts already owns the 'modes' hydration path and the 'came back from localStorage' flag, store.ts:41-43 -- re-hydrating must still let the canvas decide between restoring a camera and framing the scene, which is what that flag is for). Whichever route is taken, an existing user must not lose their saved state on every load because the key arrived late.
  4. Do not migrate the old unsuffixed keys: note in a comment that they become unreachable, which is the intended cleanup. Do not delete them either -- the app never deletes user data it does not understand.

Tests (web/src/state/persist.test.ts and the sibling suites): two project keys do not see each other's mode state, excludes, presets or help pin; the no-meta fallback still reads and writes the legacy key; setProjectKey after a write does not corrupt what was written under the earlier key; junk handling is unchanged.

Observable via integration testing: run 'vcall serve' in this repo, set a distinctive camera and a filter in the call-graph mode, then serve a second project on another port in the same browser -- the second project opens at its own default view with its own file list; returning to the first port restores the first project's camera and filter. With /data/meta.json unavailable the app behaves exactly as before.

## Notes
- 2026-09-21T21:34:27 deepseek.v4flash.007: Starting: read tic-168b, tic-c336, tic-70f3, tic-ac17 and the four persistence modules. Route chosen for hydration ordering: set the project key in a bootstrap in web/src/main.tsx (await /data/meta.json, then dynamically import App) so the store's module-level hydration already runs under the project key -- no re-hydration, so 'restored' is right on the first render and no consumer (store modes/ui/excursion, App excludes, ModePicker presets/help pin) needs a second read. Legacy unsuffixed keys are left alone and become unread.

- 2026-09-21T21:38:01 deepseek.v4flash.007: Implemented. Python: serve.py gains project_id(root) (slug of the basename + first 8 hex of sha256(path)) and meta_payload() now answers {"root": ..., "project": ...}; root semantics unchanged, so the vscode:// links still resolve. web/plugins/outData.ts derives the same id (node:crypto) and exports metaDocument() so the synthetic document is testable without a Vite server. Client: persist.ts owns setProjectKey/getProjectKey/scopedKey (namespace inserted after 'adventure-call:', so 'adventure-call:<project>:workspace:<modeId>', ':ui', ':excursion'); filters.ts, modes/presets.ts and ui/paramHelp.ts route their keys through scopedKey; unnamespaced keys are neither migrated nor deleted (they simply stop being read) and are still the keys when no project is known, so static builds are byte-for-byte unchanged. Hydration ordering (the ticket's choice, recorded in a comment in main.tsx): a bootstrap awaits /data/meta.json, calls setProjectKey, and only then dynamically imports ./App -- so src/state/store.ts hydrates under the project key at first read, 'restored' is right on the very first render, and no consumer needs a second read (no re-hydration path exists at all). Tests: 1038 web tests pass (+21, incl. a new src/state/storeHydration.test.ts that replays the bootstrap order) and npx tsc -b is clean; pytest 411 passed (+3).

- 2026-09-21T21:38:07 deepseek.v4flash.007: Integration-testing notes (what a human, QA or another agent can observe). Serve two stores on two ports -- 'vcall serve --no-open --port 5311' in one project and the same in another (or --store <other>/.adventure-call) -- then 'curl -s 127.0.0.1:5311/data/meta.json' and 'curl -s 127.0.0.1:5312/data/meta.json'. Each answers the same absolute-root document as before (that is what the vscode:// icons use) plus a different project id: {"root":"/tmp/tic168b/proj_a","project":"proj-a-b62b8e80"} and {"root":"/media/matt/m2tb/projects/adventure_call","project":"adventure-call-9eec4663"}. In a browser: pan/zoom the call-graph and add a file exclude on port 5311, then open 5312 -- it opens on its own default view with its own file list, carrying nothing of the first project's camera, focus or excludes; returning to 5311 restores that project's own camera and excludes. Devtools > Application > Local Storage then shows adventure-call:adventure-call-9eec4663:workspace:call-graph, :ui, :excursion, :excludes, :presets, :ui:help-pinned, while the pre-tic-168b keys (adventure-call:workspace:*, adventure-call:ui, ...) are still present, byte-identical and simply no longer read. With /data/meta.json unavailable (a static deployment) the page behaves exactly as before and writes the unnamespaced keys.

- 2026-09-21T21:38:07 system: Submitted; closed (review disabled).
