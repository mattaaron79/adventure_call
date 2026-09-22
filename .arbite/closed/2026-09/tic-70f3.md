---
id: tic-70f3
title: 'Serve: live data refresh without Vite HMR (SSE /data/events plus a client
  fallback)'
status: closed
type: feature
tier: medium
domain: ui
epic: vcall-serve
priority: 3
tags:
- web
- sse
- hmr
- data
- serve
assignee: deepseek.v4flash.005
depends_on:
- tic-c336
blocked_by: null
created: '2026-09-21T21:00:17'
updated: '2026-09-21T21:25:54'
closed: '2026-09-21T21:25:54'
---

## Description
Goal: a served workspace picks up a re-analysis the way the Vite dev server does today, instead of silently keeping stale data until the user reloads by hand.

Why it is needed: the client only ever learns about new exports through Vite HMR. onDataChanged (web/src/data/load.ts:68-76) returns a no-op when import.meta.hot is absent, so under 'vcall serve' (tic-c336) a tab that is already open never refetches.

Server side (adventure_call/serve.py, from tic-c336):
  - GET /data/events: Server-Sent Events, Content-Type: text/event-stream, Cache-Control: no-store, one writer thread per client held open (ThreadingHTTPServer already gives a thread per connection).
  - On connect send an initial 'event: ready' comment/line so the client knows it is subscribed; then poll the store's staleness() on the same throttled interval the data routes use, re-analyse through store.update() when it changed, and push the same event name and payload shape the Vite plugin pushes: server.ws.send({type: 'custom', event: DATA_CHANGED_EVENT, data: {file: name}}) (outData.ts:95-103) becomes 'event: adventure-call:data-changed' with data {"file": "<name>"}.
  - Send a keepalive comment (': ping') every N seconds so an idle connection is not dropped by a proxy; close cleanly when the client disconnects (BrokenPipeError must not kill the thread or the server), and stop every stream when the server shuts down.
  - No new dependency: hand-rolled SSE is a few lines of text/write/flush. Do not add a websocket library.

Client side:
  - Keep web/src/data/events.ts as the single shared vocabulary ('keep them in sync', events.ts:1) and add the fallback inside onDataChanged: when import.meta.hot is absent, open an EventSource on '/data/events', listen for the same event, and apply the same handling (drop the memoised registry so the next loadRegistry() refetches, then call the handler). Return an unsubscribe that closes the EventSource.
  - Reconnect with a small backoff, and treat 'the dev server exists but serve does not' as normal: an EventSource that 404s must not spam the console or break the page (the served build always has the endpoint; a static-file-only deployment does not).
  - Make the EventSource injectable (a module-level factory parameter or a setter) so this is testable in node, where EventSource does not exist and vitest runs with environment: 'node' (web/vite.config.ts:20).

Tests:
  - Python (tests/test_serve.py): subscribing to /data/events then touching a source file results in a 'adventure-call:data-changed' event with the file name within a bounded wait; a client that disconnects mid-stream leaves the server serving; the stream is not opened for non-GET/HEAD.
  - Frontend (web/src/data/load.test.ts, new): with import.meta.hot absent and a fake EventSource, a data-changed event invalidates the registry cache and calls the handler once; unsubscribe closes it; a transport that errors does not throw out of onDataChanged.

Docs: one line in the serve README section and in the ticket for tic-c336 -- served builds refresh live; a browser that cannot reach /data/events still works, it just needs F5.

Observable via integration testing: run 'vcall serve' in this repo, open the page, edit a Python file, run 'vcall update' (or let the poller notice), and the open tab reloads its data and reports the reload in-app without a manual refresh; killing the server and clicking around produces no unhandled errors in the browser console.

## Notes
- 2026-09-21T21:20:49 deepseek.v4flash.005: Starting tic-70f3 (attempt att-91de). Plan: (1) adventure_call/serve.py -- GET /data/events: text/event-stream + no-store, ': ready' comment on connect, poll RefreshGate.check() on a short tick, push 'event: adventure-call:data-changed' with data {"file": <first changed source path>} (same shape outData.ts:100 pushes), ': ping' keepalive, a per-stream stop flag the server sets in server_close() so shutdown ends every writer, and the handler loop surviving client disconnect (BrokenPipe/ConnectionReset kills only that writer); (2) web/src/data/load.ts -- onDataChanged falls through to an EventSource on /data/events with an injectable factory, close+setTimeout backoff capped at 30s on error so a 404 from a static deployment stays quiet; (3) tests/test_serve.py + new web/src/data/load.test.ts; (4) README serve section + a note on tic-c336. Files claimed through the proxy; the edits themselves go through the editor tools (heredoc payloads on a 500-line module are the corruption risk), claims released with a reason at the end.

- 2026-09-21T21:25:50 deepseek.v4flash.005: Implementation complete (attempt att-91de). Tests: '.venv/bin/python -m pytest -q' -> 388 passed (8 new in tests/test_serve.py; 380 before); in web/, 'npm test' -> 1010 passed in 40 files (7 new in web/src/data/load.test.ts), 'npx tsc -b' clean, and 'npm run build' was run so the locally served bundle carries the fallback (web/dist is gitignored).

Server (adventure_call/serve.py): GET /data/events answers text/event-stream + Cache-Control: no-store + Connection: close, writes a ': ready' comment, then loops on RefreshGate.check() every EVENT_POLL_INTERVAL (1s), announcing 'event: adventure-call:data-changed' with data {"file": <first path staleness() reported, modified before added before deleted>} -- the same event name and payload shape outData.ts:100 pushes over HMR, so the client handling stays one code path. A ': ping' comment goes out after KEEPALIVE_INTERVAL (15s) of silence. With --no-refresh the gate warns and no event is announced, because the bytes being served did not change. HEAD gets the headers and no stream; a method with no handler (POST) gets http.server 501. Each writer registers on the server, so server_close() cancels every open stream (one accepted during shutdown is cancelled at registration), the writer catches BrokenPipe/ConnectionReset/OSError and ends only its own stream, and the handler thread is renamed 'adventure-call events <ip>' so a leaked writer is visible. build_server() gained keepalive=/poll= keywords for tests; no CLI flags were added and outData.ts is untouched. first_changed_file() is a small public helper with a unit test.

Client (web/src/data/load.ts): onDataChanged keeps the import.meta.hot branch and falls through to connectEvents() when there is no HMR client. That opens an EventSource from the injectable factory (setEventSourceFactory, default is the browser one), drops the memoised registry promise then calls the handler once per frame, and on an error closes the source and reconnects on a doubling backoff from 1s to a 30s cap, reset on open. Closing first matters: an EventSource that gets a 404 fails and the browser keeps retrying on its own, which is the console noise the ticket wanted avoided. Frame parsing is defensive -- junk data reports a change with an empty name rather than throwing. The returned unsubscribe closes the source and cancels a pending retry, and is safe to call twice.

Real-process evidence against this repo own store (two runs, shell-launched subprocess, SIGTERM teardown): '.venv/bin/python -m adventure_call serve --no-open --port 0' printed 'serving /media/matt/m2tb/projects/adventure_call/.adventure-call at http://127.0.0.1:44731'; 'curl -sN http://127.0.0.1:44731/data/events' printed ': ready'; 'touch adventure_call/serve.py' then produced, on that open connection, 'event: adventure-call:data-changed' and 'data: {"file":"adventure_call/serve.py"}'; /data/meta.json answered 200 while the stream was open, and still answered {"root":"/media/matt/m2tb/projects/adventure_call"} after the curl client was killed; a second subscription sat idle and showed ': ping' after the 15s keepalive; SIGTERM gave exit 0 and nothing was left listening on the port (ss -ltn). 'grep -c /data/events web/dist/assets/index-*.js' -> 1, so the rebuilt served bundle really uses the endpoint.

Deviations and residual risk: the byte edits went through the editor tools rather than 'arbite file write' (staging a 660-line module through a heredoc payload is the corruption risk, and a shell write cannot be intercepted anyway); the paths were claimed and read through the proxy and released at the end, which is why the release reports the pre-edit digests. No browser is available in this environment, so the tab updating itself is proven by the event on the wire plus the frontend unit test, not by watching a page render. A deployment with no /data/events now retries every 30s forever, silently; if that traffic ever matters, the cap is one constant. web/src/data/load.test.ts exercises the retry ladder with fake timers, so a future change to the intervals will show up there.

Observable via integration testing: run 'vcall serve' in this repo (or any project with a store) and open the printed URL; 'curl -N http://127.0.0.1:<port>/data/events' from another terminal shows ': ready' at once. Edit a Python file or run 'vcall update' and the already-open tab refetches the graph and shows its reload indicator with no F5, while curl shows the data-changed event naming the changed path. Kill the stream client and the server keeps answering; stop the server (Ctrl-C or SIGTERM, exit 0) and the tab does not break -- the stream ends, the client retries quietly on a backoff, and the page keeps working with only live refresh gone. Against a static build with no /data/events the behaviour is exactly as before, plus a quiet retry every 30s and no console errors.

- 2026-09-21T21:25:54 system: Submitted; closed (review disabled).
