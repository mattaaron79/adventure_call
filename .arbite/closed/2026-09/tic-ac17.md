---
id: tic-ac17
title: 'vcall serve --dev: run the Vite dev server against a store (frontend iteration
  path)'
status: closed
type: feature
tier: medium
domain: cli
epic: vcall-serve
priority: 3
tags:
- cli
- serve
- vite
- dev
- ui
assignee: deepseek.v4flash.006
depends_on:
- tic-c336
blocked_by: null
created: '2026-09-21T21:00:25'
updated: '2026-09-21T21:31:55'
closed: '2026-09-21T21:31:55'
---

## Description
Goal: keep the current fast loop for working on the SPA itself -- HMR, React refresh, Vite errors -- while making it usable from any directory, without making Node a runtime requirement of the normal 'vcall serve' (tic-c336).

Surface: 'vcall serve --dev' (also '--dev --port N'). Anything else about the command is unchanged.

What it does: find the store exactly as tic-c336 does, then spawn 'npm run dev' in the checkout's web/ with the store's directory exported to the plugin, wait until the port accepts connections, open the browser, and forward the child's stdout/stderr so Vite's own messages appear. On Ctrl-C (and SIGTERM) terminate the child and exit 0 -- the child must never outlive the command, and a failure to spawn (no npm, no web/, no node_modules) is a clear error with the 'run npm ci in web/' hint, not a traceback.

Changes needed on the frontend side:
  - web/vite.config.ts:7 hardcodes outData({outDir: '../out'}); make the out dir overridable from the environment (e.g. VCALL_OUT_DIR, falling back to '../out') so the dev server can point at a store anywhere on disk. Keep the default so nothing changes for 'npm run dev' in the repo (which the F5 launch config uses).
  - web/vite.config.ts:11-14 pins port 5175 with strictPort: true; when an explicit port is requested (an env var or a --port for the child) it must not fight over 5175 -- either pass Vite's own '--port'/'--strictPort false' through, or keep 5175 for the default path and pass the chosen port through otherwise. Document whichever rule is chosen in a comment.
  - The web/ checkout is found relative to the package (Path(__file__).parent.parent / 'web'), so --dev only works from a source checkout. Say so in the error when it is missing; do not try to download a frontend.

Tests: the pure parts, not the child process -- argument/environment assembly for the spawn (store dir, port, npm executable), the "no checkout" and "no npm" error paths, and child termination on shutdown with a fake process object. A real 'npm run dev' must not run in the suite.

Docs: one line under the serve README section distinguishing the two modes (served bundle = normal use; --dev = frontend work).

Observable via integration testing: 'vcall serve --dev' from a subdirectory of this repo starts Vite against .adventure-call/, the browser opens on the dev server with HMR working and edits under web/src hot-reloading; Ctrl-C stops both the browser's server and Vite (no orphan node process left behind, check with 'pgrep -f vite'); running it from a machine with no web/ checkout or no npm prints the guidance and exits non-zero.

## Notes
- 2026-09-21T21:28:45 deepseek.v4flash.006: Starting tic-ac17 (attempt att-e82a). Plan: serve.py grows a dev-mode section -- dev_checkout()/npm_executable()/require_node_modules() as the three actionable error paths, dev_environment() handing VCALL_OUT_DIR/VCALL_PORT/VCALL_HOST to the plugin, spawn in its own session (start_new_session) so stop_child() can killpg the whole npm+Vite tree, wait_for_port() polling the child's exit code as well as the port, a daemon _RefreshPoller driving the same RefreshGate the served path drives per request, and run_dev() (SIGTERM->KeyboardInterrupt like run(), child stopped in finally). vite.config.ts reads the three env vars through a small plugins/devServer.ts helper (unit-tested by vitest) and keeps 5175+strictPort as the default: the CLI passes an explicit port and strictPort means it either binds or fails loudly, so neither 'npm run dev' nor the F5 launch config moves. Ports: --port N passes through, --port 0 (the default) picks a free port in Python so the banner names the real one.

- 2026-09-21T21:31:51 deepseek.v4flash.006: Implementation complete (attempt att-e82a). Tests: '.venv/bin/python -m pytest -q' -> 408 passed (388 before, 20 new in tests/test_serve.py); in web/, 'npm test' -> 1017 passed in 41 files (7 new in web/plugins/devServer.test.ts), 'npx tsc -b' clean (vite.config.ts and plugins/ are in the node project). No npm/npx process runs in the suite: every child-side test drives a FakeProcess and a patched _popen/_kill_group.

Python (adventure_call/serve.py, new '-- the dev server (tic-ac17)' section): dev_checkout() finds web/ next to the package and names the path when there is none; npm_executable() refuses a machine with no npm; require_node_modules() says 'run npm ci in <web>'. dev_environment() puts VCALL_OUT_DIR (the absolute store dir, the child's cwd being web/), VCALL_PORT and VCALL_HOST into the inherited environment, and dev_command() is exactly [npm, 'run', 'dev'] -- nothing that varies per run is argv, so a change to web/package.json is picked up for free. spawn_dev_server() uses start_new_session=True (npm runs Vite as its own child, so signalling npm alone can leave Vite holding the port), stdin=/dev/null, and inherits stdout/stderr so Vite's interactive output is verbatim and unbuffered. wait_for_port() polls the child's exit code as well as the port, so a dead child is a message with its exit code rather than a 20s hang. stop_child() is SIGTERM -> wait(grace) -> SIGKILL, sent with os.killpg to the whole group, and is idempotent because both the failed-start path and the shutdown path call it. run_dev() re-analyses before spawning, drives the same RefreshGate from a daemon _RefreshPoller (no Python request exists in dev mode, so the served path's per-request check has no caller), prints the URL, opens the browser, and in finally stops the child, stops the poller and restores SIGTERM. Ports: --port N is passed through, --port 0 (the default) resolves a free port here so the printed URL is the real one. No HTTP contract, no query command and no served-path behaviour changed; the SIGTERM->KeyboardInterrupt helper and the beyond-loopback warning were reused (the warning extracted into _warn_beyond_loopback so both paths say the same thing).

Frontend (web/plugins/devServer.ts + vite.config.ts): resolveOutDir/resolvePort/resolveHost read VCALL_OUT_DIR/VCALL_PORT/VCALL_HOST, unset or blank meaning the committed default. The port rule, recorded in the config comment: 5175 + strictPort stays the default so plain 'npm run dev' and the F5 launch config do not move; an explicit VCALL_PORT replaces the port and strictPort stays ON, so the requested port either binds or Vite fails loudly -- silently drifting to another port would make the URL the CLI printed a lie.

cli.py: --dev on the serve parser (help and description say what it needs), and cmd_serve builds one options dict and calls serve.run_dev or serve.run, so both modes share discovery, freshness and exit codes; ServeError is still EXIT_ERROR. README: an example line plus a short paragraph distinguishing the served bundle (normal use) from --dev (frontend work).

Real end-to-end evidence (two bounded runs from the repo root, shell-launched subprocess, SIGTERM teardown): run 1 -- '.venv/bin/python -m adventure_call serve --dev --no-open --port 5199' printed 'serving /media/matt/m2tb/projects/adventure_call/.adventure-call at http://127.0.0.1:5199 (vite dev; Ctrl-C to stop)', Vite's own banner showed 'VITE v6.4.3 ready in 162 ms' and 'Local: http://127.0.0.1:5199/' (so VCALL_PORT was honoured); 'curl /data/meta.json' answered {"root":"/media/matt/m2tb/projects/adventure_call"} (the store's graph root_abs, so the plugin was reading the store), 'curl /data/codebase_graph.json | sha256sum' matched 'sha256sum .adventure-call/codebase_graph.json' exactly (b12e8af84851fe0d...), /data/symbol_registry.json and /@vite/client answered 200, and '/' returned Vite's dev HTML with /@react-refresh and /@vite/client tags, i.e. the HMR client. Run 2 (port 5198): after readiness, 'touch adventure_call/serve.py' produced 'adventure-call: sources changed (1 modified); re-analysing...' (the poller, on the real store) and then Vite logged 'out-data changed: codebase_graph.json' / 'symbol_registry.json' (the plugin's watcher saw the exports rewritten, which is the event the tab refetches on), and the store's codebase_graph.json mtime moved 1790051459 -> 1790051483. 'kill -TERM' on the python process gave exit 0 and the log ended with 'stopped'. Cleanup after both runs: 'pgrep -af node_modules/.bin/vite', 'pgrep -af vite', 'pgrep -af adventure_call serve' matched nothing but the checking shell's own command line, and 'ss -ltn' showed nothing on 5198 or 5199 -- no orphan Vite, no leftover listener. Environment note: nothing environment-specific had to be worked around -- 'npm run dev' worked through the npm shim, no need for node_modules/.bin/vite.

No integration-testing surprises for a human/QA: run 'vcall serve --dev' from anywhere inside this repo and the browser opens on Vite's dev server (HMR, React refresh, error overlay) reading the nearest .adventure-call/ store; edit a Python file and the store is re-analysed within a few seconds and the tab refetches over HMR; Ctrl-C (or SIGTERM) stops both the command and Vite, with nothing left listening. From a machine with no web/ checkout, no npm or no node_modules the command prints the 'run npm ci in web/' guidance and exits non-zero instead of raising.

- 2026-09-21T21:31:55 system: Submitted; closed (review disabled).
