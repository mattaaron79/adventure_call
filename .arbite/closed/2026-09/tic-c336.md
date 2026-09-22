---
id: tic-c336
title: 'vcall serve: stdlib web server over a .adventure-call store, ephemeral loopback
  port'
status: closed
type: feature
tier: medium
domain: cli
epic: vcall-serve
priority: 2
tags:
- cli
- serve
- web
- store
- http
- agents
assignee: deepseek.v4flash.004
depends_on:
- tic-c11c
blocked_by: null
created: '2026-09-21T21:00:10'
updated: '2026-09-21T21:25:53'
closed: '2026-09-21T21:18:20'
---

## Description
Goal: from any directory inside a project that has a .adventure-call/ store, 'vcall serve' starts a temporary local website showing the same workspace the Vite dev server shows today, then goes away on Ctrl-C. No Node, no npm, no second terminal.

Depends on tic-c11c for the built bundle (option A: a prebuilt bundle shipped in the wheel).

Surface:
  adventure-call serve [ROOT] [--store DIR] [--port N] [--host H] [--no-open] [--no-refresh] [-v]
'vcall' is the same entry point (pyproject.toml:22-24), so 'vcall serve' is the form to document. Add 'serve' to _COMMANDS (cli.py:411) so the legacy path form (cli.py:417-436) cannot read it as 'analyze serve', and add a line to _TOP_DESCRIPTION (cli.py:54).

Store discovery:
  - no arguments: Store.find() (store.py:143) walks up from the cwd, exactly like git, which is what makes it work from any subdirectory of the project.
  - --store DIR: reuse _find_store() (cli.py:555), which already accepts either the store or the project root holding one.
  - ROOT positional: serve ROOT/.adventure-call; missing store -> the "run 'adventure-call init'" StoreError text and EXIT_NO_STORE (3, cli.py:35).

Freshness: reuse the _open_workspace() shape (cli.py:566-578): store.staleness() (store.py:218), and when sources changed re-run store.update() with the existing "sources changed (...); re-analysing..." warning on stderr; --no-refresh warns instead and serves what is on disk. Re-check at most once every few seconds on each /data/* request too, so a plain browser refresh after editing the project always shows current data (the manifest scan is a walk over source mtimes -- throttle it and note the throttle; do not re-analyse on every asset request).

HTTP contract (mirror web/plugins/outData.ts, which is the only existing server):
  - GET /data/codebase_graph.json and /data/symbol_registry.json: streamed straight out of the store directory, same SERVED whitelist idea (outData.ts:17), Cache-Control: no-store, Content-Length set; a missing file answers 404 with {"error": "missing codebase_graph.json", "expected": "<abs path>"} as outData.ts:120-124 does.
  - GET /data/meta.json: synthetic, not a file; {"root": <absolute analysed root>} exactly as resolveAbsoluteRoot (outData.ts:32-40) derives it. Prefer the graph's root_abs (writer.py:93); fall back to the store root as a POSIX path when an older graph has only the relative root; null when unreadable. This is what makes the inspector's vscode:// links work (tic-4b0a, tic-7f0b) -- a serve build must not regress to plain text.
  - everything else: static files from webassets.dist_dir(); an unknown path with no file extension falls back to index.html (SPA), an unknown asset 404s. Resolve every path under the dist root and refuse anything that escapes it ('..', absolute paths, symlinks out).
  - no Python-side caching of the exports: they are rewritten wholesale by update().

Lifecycle and ergonomics:
  - bind 127.0.0.1 on port 0 by default so the OS picks a free port, which also keeps two served projects apart (different port = different origin for localStorage); --port N pins one, and a busy port is a clear error with EXIT_ERROR rather than a traceback.
  - --host defaults to 127.0.0.1 and any other bind address prints a warning: symbol_registry.json embeds full function bodies (writer.py:120, includes_source) plus project paths, so serving it beyond loopback is opt-in.
  - print one line, e.g. 'serving <store path> at http://127.0.0.1:<port> (Ctrl-C to stop)', then webbrowser.open(url) unless --no-open; a failed open (headless, no browser) must not be fatal.
  - ThreadingHTTPServer.serve_forever() on the main thread; KeyboardInterrupt -> shutdown, close, plain 'stopped' line, exit 0. Handle SIGTERM cheaply if it costs nothing.
  - access logging off by default (stderr is for diagnostics), -v turns it on; reuse _configure_logging (cli.py:742). The server never writes to the store except through store.update().

Docs: a README section next to the Agent CLI block (README.md:47-65), the top-level help line, and a row in the agent guide (adventure_call/agents_doc.py) saying the command exists for humans and that agents should stay on the JSON queries.

Files: adventure_call/serve.py (new -- handler class, store resolution, request throttle, lifecycle), adventure_call/cli.py (parser block, dispatch, _COMMANDS, help text), README.md, adventure_call/agents_doc.py, tests/test_serve.py (new), tests/test_cli.py.

Tests (build a store over tests/fixtures/sample_project the way tests/test_cli.py already does, monkeypatch webassets.dist_dir to a tmp dir holding a stub index.html, run the server in a thread against a real socket with http.client):
  - the three data routes answer 200 with the expected JSON shape; the graph route is byte-identical to the store file.
  - meta.json reports the fixture root and is null-safe when the graph has no root_abs.
  - a missing store file 404s with the JSON body; /data/../manifest.json and %2e%2e traversal are refused; an unknown asset 404s while an unknown extension-less path serves index.html.
  - a stale store is re-analysed before the first response, and with --no-refresh it is not (assert the manifest mtime is unchanged).
  - no store -> exit 3 and the init hint; --port with an occupied socket -> exit 1; --no-open never touches webbrowser (monkeypatch it).
  - the handler is at least smoke-tested for HEAD/range-free simple GET only -- do not over-engineer.

Known limits to document: no live updates in a browser tab that is already open (that is tic next, the SSE ticket); one store per invocation; the payload is your source code, so loopback and short-lived is the point.

Observable via integration testing: 'cd' into any subdirectory of a project with an .adventure-call/ store (including this repo) and run 'vcall serve' -- a browser opens on the workspace, all modes behave as under Vite, the inspector's vscode:// icons open the real files because /data/meta.json reports the store root, editing a source file and pressing F5 shows the re-analysis, Ctrl-C exits 0 leaving the store unchanged, and running it outside any store exits 3 with the init hint.

## Notes
- 2026-09-21T21:00:41 deepseek.v4flash.002: Cut as the root of epic vcall-serve (option A: prebuilt bundle, no runtime Node). Follow-ups filed on top of this ticket: tic-70f3 (live data refresh via SSE /data/events, since onDataChanged is a no-op without Vite HMR), tic-ac17 (vcall serve --dev spawns the Vite dev server against a store, for frontend iteration), tic-168b (namespace persisted browser state by project). Bundle ticket underneath: tic-c11c.

- 2026-09-21T21:17:54 deepseek.v4flash.004: Starting tic-c336 (attempt att-9e1e). Approach: a new adventure_call/serve.py holding the whole HTTP surface -- a ThreadingHTTPServer subclass carrying (store, dist, gate), a BaseHTTPRequestHandler that mirrors web/plugins/outData.ts (/data/* whitelisted to codebase_graph.json + symbol_registry.json with Cache-Control: no-store, Content-Length and the {"error": "missing NAME", "expected": ABS} 404 body; /data/meta.json synthetic via a standalone meta_payload()/analysed_root() pair that prefers the graph's root_abs and falls back to the store root for pre-tic-7f0b graphs), static files resolved under webassets.dist_dir() with a resolve()-based containment check that also refuses symlinks out, an extension-less miss falling back to index.html, and a RefreshGate class encapsulating the throttled staleness check (staleness() -> the existing 'sources changed (...); re-analysing...' warning -> store.update(), at most once every 3s, force=True before the first response) so tic-70f3 can drive SSE on exactly that check. Lifecycle in run(): bundle lookup, non-loopback warning, bind (port 0 default), one-line url on stdout, best-effort webbrowser.open, serve_forever on the main thread, KeyboardInterrupt/SIGTERM -> shutdown + close + exit 0. cli.py gets the serve subparser, _serve_store()/cmd_serve(), 'serve' in _COMMANDS and the top-level help, and access logging stays opt-in behind -v (INFO level for serve so 'stopped' is visible on stderr; log_message gated on server.access_log). ServeError carries start-up failures so cli owns the exit codes.

- 2026-09-21T21:18:12 deepseek.v4flash.004: Tests pass: '.venv/bin/python -m pytest -q' -> 380 passed (was 354; 26 new in tests/test_serve.py, all over a real socket via http.client). Notes on shapes worth recording: tests/test_serve.py stubs webassets.dist_dir with a tmp bundle (index.html + a hashed .js + a .css), drives the server in a thread through the new serve.build_server() seam, and reaches the logging assertions through a small package-logger handler because a test that never calls cli.main has nothing bound to pytest's captured stderr.

Real-process evidence (subprocess, this repo's own store, --no-open --port 0): run 1 with --no-refresh printed 'serving /media/.../adventure_call/.adventure-call at http://127.0.0.1:43515 (Ctrl-C to stop)', warned 'analysis is stale (2 modified, 4 added); run adventure-call update', answered /data/meta.json with the absolute root, and after SIGINT exited 0 leaving every .json under .adventure-call/ with an unchanged mtime_ns (the store is genuinely untouched with --no-refresh). Run 2 without --no-refresh re-analysed first ('sources changed (2 modified, 4 added); re-analysing...'), then: '/' -> 200 text/html (the real 413-byte web/dist/index.html), its hashed asset /assets/index-Cs_BBo8W.js -> 200 'text/javascript; charset=utf-8' 579826 bytes, /data/codebase_graph.json -> 200 byte-identical to .adventure-call/codebase_graph.json (3586455 bytes) and /data/symbol_registry.json likewise (5426845 bytes), both with Cache-Control: no-store, /data/meta.json -> {"root":"/media/matt/m2tb/projects/adventure_call"} (the repo's absolute root, so the inspector vscode:// links resolve). SIGINT exited 0 and a connect to the port afterwards raised ConnectionRefusedError: nothing is left listening.

Design deviations from the ticket text, both deliberate: (1) exit codes stay in cli.py, so serve.run() raises the new ServeError for a missing bundle / unparseable store / busy address and cmd_serve maps it to EXIT_ERROR, and EXIT_NO_STORE for the store lookup -- serve.py therefore imports nothing from cli (no cycle) and the codes live in one place; (2) the access log is gated on a server flag rather than the log level, because _configure_logging now treats serve as interactive (INFO, so 'stopped' is visible on stderr) and a level gate would have printed access lines by default. Also of note: the first refresh during the smoke run regenerated the tracked .adventure-call/AGENTS.md with the new serve row, which is committed with the change.

No frontend file was touched and web/plugins/outData.ts is unchanged; the bundle is served as-is. Residual: no headless browser was available here, so the browser-side rendering was not exercised -- what is proven is the HTTP contract and that the served index.html and its hashed asset come from web/dist with the right content types.

- 2026-09-21T21:18:17 deepseek.v4flash.004: What a human or QA can observe by integration testing: 'cd' into any directory inside a project that has a .adventure-call/ store (this repo at its root or in adventure_call/, tests/, web/...) and run 'vcall serve' (or 'adventure-call serve', or 'python -m adventure_call serve') -- stderr says nothing alarming and stdout prints exactly one line, 'serving <abs store path> at http://127.0.0.1:<port> (Ctrl-C to stop)', and a browser opens on that URL with the workspace rendering as it does under Vite (all modes, sidebar, canvas). Clicking the inspector's vscode:// icons opens the real files, which is the observable proof that /data/meta.json reports the analysed root; 'curl http://127.0.0.1:<port>/data/meta.json' shows the same JSON. Edit a source file in another window and press F5 in the browser: stderr prints 'sources changed (...); re-analysing...' and the page shows the new data (the first refresh after a long edit-free pause can take a few seconds; a reload inside the 3s throttle window just serves the current analysis). Ctrl-C prints 'stopped' on stderr and exits 0 -- 'echo $?' in the shell gives 0, a second 'vcall serve' gets a fresh port, and nothing keeps listening. 'vcall serve --no-open --port 5173' binds exactly that port (a busy one prints "cannot bind 127.0.0.1:5173: [Errno 98] Address already in use" and exits 1 rather than a traceback); '--no-refresh' warns 'analysis is stale (...)' and serves what is on disk unchanged; '--host 0.0.0.0' warns that it is beyond loopback; '-v' adds an access log line per request to stderr, and without it stderr stays quiet; 'vcall serve' outside any store exits 3 with "run 'adventure-call init' at the project root". Nothing about this changes the query commands: their stdout is still one line of JSON.

- 2026-09-21T21:18:20 system: Submitted; closed (review disabled).

- 2026-09-21T21:18:38 deepseek.v4flash.004: Landed as 01ce4cf ('vcall serve: stdlib web server over a store, ephemeral loopback port (tic-c336)') on main: adventure_call/serve.py, tests/test_serve.py, adventure_call/cli.py, adventure_call/agents_doc.py, README.md, .arbite/closed/2026-09/tic-c336.md and the regenerated tracked .adventure-call/AGENTS.md (one added serve row). tests/test_cli.py needed no edit: its parametrised test_help_for_every_command iterates _COMMANDS, so it asserts 'serve -h' already. Post-commit SIGTERM check against this repo: printed the serving line, re-analysed 2 modified sources, exited 0 on SIGTERM with 'stopped' on stderr, and a connect to the port afterwards raised ConnectionRefusedError.

- 2026-09-21T21:25:53 deepseek.v4flash.005: tic-70f3 closed the one limit this ticket recorded: 'no live update in a tab that is already open'. serve.py now also serves GET /data/events as Server-Sent Events, on the RefreshGate.check() throttle this module exposes, pushing the same adventure-call:data-changed event the Vite plugin pushes ({file: <changed source path>}) plus a ': ping' keepalive and a ': ready' comment on connect; every writer is cancelled in server_close(). The client fallback lives in web/src/data/load.ts (onDataChanged) and the served bundle was rebuilt, so a served tab now refreshes itself and only needs F5 when /data/events is unreachable (a static deployment). README's serve section says so. No change to the /data/* routes, their headers or the byte-for-byte streaming.
