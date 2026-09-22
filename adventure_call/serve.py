"""Serve a store's workspace over loopback HTTP (tic-c336).

``adventure-call serve`` starts a throwaway web server for one
``.adventure-call/`` store: the same workspace the Vite dev server shows, from
the bundle :mod:`adventure_call.webassets` locates, with no Node, npm or second
terminal.  It exists for humans -- agents keep to the JSON query commands.

The HTTP contract mirrors the dev-only Vite plugin (``web/plugins/outData.ts``),
which is the only other server for this app:

* ``GET /data/codebase_graph.json`` and ``/data/symbol_registry.json`` stream the
  store's exports straight off disk -- the same two-name whitelist, so no request
  ever names a path of its own -- with ``Content-Length`` and
  ``Cache-Control: no-store``, because ``update()`` rewrites them wholesale;
* ``GET /data/meta.json`` is synthetic: the absolute analysed root, which is what
  makes the inspector's ``vscode://`` links work (tic-4b0a), plus the project id
  the page namespaces its persisted workspace state with (tic-168b);
* ``GET /data/events`` is a Server-Sent Events stream (tic-70f3): it pushes the
  same ``adventure-call:data-changed`` event the Vite plugin pushes over HMR, so a
  tab that is already open refetches after a re-analysis instead of keeping stale
  data until someone presses F5;
* everything else comes from the bundle; an unknown path with no file extension
  is a client-side route and answers with ``index.html``.

``serve --dev`` is the other half of the same command (tic-ac17): the store discovery,
the freshness rules and the teardown promise are the ones above, but the page is served
by the checkout's own ``npm run dev``, so HMR, React refresh and Vite's error overlay
are the ones a frontend change is iterated against.  It is a source-checkout feature by
construction -- a wheel ships a bundle, not the frontend sources -- and the dev server is
always stopped with the command, never left behind.

Limits worth knowing: one store per invocation, and a live tab is only told about a
change the *server* noticed (a browser that cannot reach ``/data/events`` -- a plain
static deployment -- keeps working, it just needs a manual reload).  The payload is
your source code -- ``symbol_registry.json`` embeds full function bodies -- which is
why the default is loopback on an ephemeral port and why serving anything else
warns; the process holds no cache of its own and never writes to the store except
through ``store.update()``.
"""

from __future__ import annotations

import hashlib
import http.server
import json
import logging
import os
import posixpath
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path
from typing import Any, Callable, Mapping, cast

from adventure_call import __version__, webassets
from adventure_call.store import Store, StoreError

logger = logging.getLogger("adventure_call")

DATA_PREFIX = "/data/"
INDEX_HTML = webassets.INDEX_HTML
#: The store files reachable through ``/data/`` -- outData.ts keeps the same list.
SERVED = ("codebase_graph.json", "symbol_registry.json")
META_NAME = "meta.json"
#: The live-update stream (tic-70f3).  Synthetic like ``meta.json``, so it is
#: answered before the file whitelist rather than 404ing as an unknown name.
EVENTS_NAME = "events"
#: The name of the change event, pushed by the Vite plugin and this server alike;
#: web/src/data/events.ts holds the one client-side copy of the wire vocabulary.
DATA_CHANGED_EVENT = "adventure-call:data-changed"
#: Seconds between request-driven staleness scans: the manifest walk reads every
#: source mtime, so it is cheap but not free, and an asset request must never pay
#: for it -- only ``/data/*`` requests check.
STALENESS_INTERVAL = 3.0
#: How often an open stream asks the gate for changes.  The gate throttles the
#: scan itself, so this only decides how soon after a scan a change reaches the
#: wire; it stays well under ``STALENESS_INTERVAL`` because a poll that is
#: throttled costs a clock read.
EVENT_POLL_INTERVAL = 1.0
#: Silence tolerated on an open stream before a comment is written: long enough to
#: be idle, short enough that a proxy or NAT does not drop the connection.
KEEPALIVE_INTERVAL = 15.0
#: Bind addresses that keep the registry on the machine.  Anything else is a
#: deliberate opt-in and says so, since the payload is the project's source.
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_COPY_CHUNK = 64 * 1024

#: Explicit, because the platform MIME database is not dependable for the types a
#: bundle lives or dies by: a ``.js`` served as text/plain is refused by the
#: browser's module loader.
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
}


class ServeError(Exception):
    """The server cannot start: no bundle, no parseable source, or a busy address."""


# -- what the client is told about the store -------------------------------------


def meta_payload(store: Store) -> dict[str, Any]:
    """The ``/data/meta.json`` document, as the client's ``loadMeta`` reads it.

    ``root`` is the absolute analysed root the inspector's ``vscode://`` links are
    built from (tic-4b0a).  ``project`` (tic-168b) is the id the page namespaces
    every persisted preference by, so two stores served from one origin -- two
    ``vcall serve`` runs on two ports -- cannot read each other's camera, dragged
    positions, excludes or presets.
    """
    root = analysed_root(store)
    return {"root": root, "project": project_id(root)}


def project_id(root: str | None) -> str | None:
    """A stable, short id for an analysed root, or ``None`` when there is none.

    Derived from the path so one project always hashes to the same id and two
    projects never do: the directory name slugged for a human reading devtools,
    plus the first 8 hex of the path's SHA-256.  ``web/plugins/outData.ts`` derives
    it the same way for the Vite dev server, so a project reached both ways keeps
    one set of saved state.  ``None`` -- no root to hash -- leaves the client on its
    unnamespaced keys, which is exactly the pre-tic-168b behaviour.
    """
    if not root:
        return None
    digest = hashlib.sha256(root.encode("utf-8")).hexdigest()[:8]
    slug = re.sub(r"[^a-z0-9]+", "-", posixpath.basename(root.rstrip("/")).lower()).strip("-")[:32]
    return f"{slug}-{digest}" if slug else digest


def analysed_root(store: Store) -> str | None:
    """The absolute analysed root for ``vscode://`` deep links, or ``None``.

    ``root_abs`` is preferred: it was pinned at generation time against the cwd
    adventure-call ran in, so nothing has to be guessed.  A graph older than that
    field carries only a relative ``root``, which was relative to a cwd nobody
    recorded; the store always sits inside the project it analysed, so the store's
    own root is the honest answer there.  An unreadable or rootless graph answers
    ``None``, and the client degrades to plain text instead of a broken link.
    """
    try:
        document = json.loads((store.path / SERVED[0]).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    metadata = document.get("graph") if isinstance(document, dict) else None
    if not isinstance(metadata, dict):
        return None
    root_abs = metadata.get("root_abs")
    if isinstance(root_abs, str) and root_abs:
        return root_abs.replace("\\", "/")
    root = metadata.get("root")
    if isinstance(root, str) and root:
        return store.root.resolve().as_posix()
    return None


# -- staying current -------------------------------------------------------------


class RefreshGate:
    """Detect source changes and re-analyse, at most once every ``interval`` seconds.

    The scan is the one the query commands already do (:meth:`Store.staleness`, a
    walk over source mtimes), so a browser reload after an edit shows current data
    while an asset request never pays for the walk.  :meth:`check` is deliberately a
    separate, callable step rather than something buried in a request handler:
    tic-70f3 drives exactly this to feed ``/data/events``.
    """

    def __init__(
        self,
        store: Store,
        *,
        no_refresh: bool = False,
        interval: float = STALENESS_INTERVAL,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.store = store
        self.no_refresh = no_refresh
        self.interval = interval
        self._clock = clock
        self._last = float("-inf")  # the first check always runs
        # One scan at a time: a concurrent request waits here rather than paying
        # for a second walk over the same tree.
        self._lock = threading.Lock()

    def check(self, *, force: bool = False) -> dict[str, list[str]] | None:
        """Scan for changes and re-analyse when stale; ``None`` when throttled.

        Returns the change mapping when the scan ran, ``{}`` when the store is
        current, and ``None`` when this call was skipped by the throttle.  With
        ``no_refresh`` the change is warned about instead of analysed, so what is
        on disk is served as it is.  Raises ``StoreError`` when a re-analysis
        finds nothing parseable.
        """
        now = self._clock()
        with self._lock:
            if not force and now - self._last < self.interval:
                return None
            self._last = now
            changes = self.store.staleness()
            if not changes:
                return {}
            counts = ", ".join(f"{len(v)} {k}" for k, v in changes.items())
            if self.no_refresh:
                logger.warning("adventure-call: analysis is stale (%s); run 'adventure-call update'", counts)
                return changes
            logger.warning("adventure-call: sources changed (%s); re-analysing...", counts)
            if self.store.update() is None:
                raise StoreError(f"no parseable source files under {self.store.root}")
            return changes


# -- the server ------------------------------------------------------------------


class _EventStream:
    """One open ``/data/events`` writer, and the flag that ends it.

    The writer waits on this event rather than sleeping, so a shutdown ends the
    stream at once instead of at the next keepalive.
    """

    __slots__ = ("_stop",)

    def __init__(self) -> None:
        self._stop = threading.Event()

    def cancel(self) -> None:
        self._stop.set()

    @property
    def cancelled(self) -> bool:
        return self._stop.is_set()

    def wait(self, timeout: float) -> bool:
        """True once cancelled -- the writer's loop then ends."""
        return self._stop.wait(timeout)


class _StoreHTTPServer(http.server.ThreadingHTTPServer):
    """A threaded server for one store and one bundle.

    Requests are handled in daemon threads so Ctrl-C never waits on a slow client,
    and the address is reused so a restart is not refused after a crash.  An event
    stream is a request that never finishes on its own, so the open ones are tracked
    here and cancelled by :meth:`server_close` (tic-70f3).
    """

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        *,
        store: Store,
        dist: Path,
        gate: RefreshGate,
        access_log: bool = False,
        keepalive: float = KEEPALIVE_INTERVAL,
        poll: float = EVENT_POLL_INTERVAL,
    ) -> None:
        self.store = store
        self.dist = Path(dist).resolve()
        self.gate = gate
        self.access_log = access_log
        self.keepalive = keepalive
        self.poll = poll
        self._streams: set[_EventStream] = set()
        self._streams_lock = threading.Lock()
        self._closing = False
        super().__init__(address, _RequestHandler)

    # -- live-update streams (tic-70f3) -------------------------------------------

    def open_stream(self) -> _EventStream:
        """Register the stream the calling thread is about to write.

        A stream that arrives during shutdown is cancelled immediately, so a
        request accepted just before the close cannot hold the process open.
        """
        stream = _EventStream()
        with self._streams_lock:
            if self._closing:
                stream.cancel()
            else:
                self._streams.add(stream)
        return stream

    def close_stream(self, stream: _EventStream) -> None:
        with self._streams_lock:
            self._streams.discard(stream)

    def stream_count(self) -> int:
        """How many streams are open -- what a shutdown test observes."""
        with self._streams_lock:
            return len(self._streams)

    def shutdown_streams(self) -> None:
        """Cancel every open stream; idempotent, since :meth:`server_close` runs it."""
        with self._streams_lock:
            streams, self._streams = list(self._streams), set()
            self._closing = True
        for stream in streams:
            stream.cancel()

    def server_close(self) -> None:
        self.shutdown_streams()  # a stream has no request left to finish on its own
        super().server_close()


class _RequestHandler(http.server.BaseHTTPRequestHandler):
    """One request: a store export, the meta document, or a file from the bundle."""

    server_version = f"adventure-call/{__version__}"
    #: A page pulls a dozen assets, so keep-alive matters; HTTP/1.1 requires the
    #: ``Content-Length`` every response here sets.
    protocol_version = "HTTP/1.1"

    @property
    def _workspace(self) -> _StoreHTTPServer:
        return cast(_StoreHTTPServer, self.server)

    def do_GET(self) -> None:  # noqa: N802 - http.server's spelling
        self._respond(with_body=True)

    def do_HEAD(self) -> None:  # noqa: N802 - http.server's spelling
        self._respond(with_body=False)

    def _respond(self, *, with_body: bool) -> None:
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path.startswith(DATA_PREFIX):
                self._serve_data(path[len(DATA_PREFIX):], with_body=with_body)
            else:
                self._serve_static(path, with_body=with_body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client went away mid-response; there is nobody to tell
        except StoreError as exc:
            self._send_json(500, {"error": str(exc)}, with_body=with_body)

    # -- /data/* ------------------------------------------------------------------

    def _serve_data(self, name: str, *, with_body: bool) -> None:
        name = urllib.parse.unquote(name)
        if name == EVENTS_NAME:
            self._stream_events(with_body=with_body)
            return
        # Any request may be the first one after an edit, so refresh here -- and
        # only here; an asset request never pays for a manifest walk.
        self._workspace.gate.check()
        if name == META_NAME:
            self._send_json(200, meta_payload(self._workspace.store), with_body=with_body)
            return
        if name not in SERVED:
            # Covers every traversal attempt ('..', '%2e%2e'): only the two names
            # above ever name a path, so a refused request is indistinguishable
            # from a typo and confirms nothing about the disk.
            self._send_json(404, {"error": f"no such data file: {name}"}, with_body=with_body)
            return
        target = self._workspace.store.path / name
        try:
            size = target.stat().st_size
        except OSError:
            self._send_json(
                404,
                {"error": f"missing {name}", "expected": str(target)},
                with_body=with_body,
            )
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(size))
        self.end_headers()
        if with_body:
            self._stream(target)

    # -- /data/events (tic-70f3) ---------------------------------------------------

    def _stream_events(self, *, with_body: bool) -> None:
        """Hold this connection open as a Server-Sent Events stream.

        The stream drives the same throttled :meth:`RefreshGate.check` the data
        routes do, so a subscriber and a reload never disagree about freshness, and
        it announces the same event and payload shape the Vite plugin pushes over
        HMR (``{file: name}``, outData.ts:100).  A HEAD gets the headers and no
        stream: there is no connection to hold open for a bodyless request.
        """
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        # An open-ended body cannot be pooled for another request; this header ends
        # the socket (and so the subscription) as soon as the loop below returns.
        self.send_header("Connection", "close")
        self.end_headers()
        if not with_body:
            return
        # Named for the sake of a shutdown test and a thread dump: a leaked writer
        # is otherwise an anonymous thread.
        threading.current_thread().name = f"adventure-call events {self.client_address[0]}"
        stream = self._workspace.open_stream()
        try:
            self._write_block(": ready\n\n")
            self._event_loop(stream)
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            # The client vanished, or the server closed this socket under the
            # writer: end this stream only -- the others, and the server, live on.
            logger.debug("adventure-call: event stream ended", exc_info=True)
        finally:
            self._workspace.close_stream(stream)

    def _event_loop(self, stream: _EventStream) -> None:
        """Poll for changes until the client goes away or the server shuts down."""
        workspace = self._workspace
        warned = False
        last_write = time.monotonic()
        while not stream.cancelled:
            try:
                changes = workspace.gate.check()
            except StoreError as exc:
                # Nothing parseable on disk: the served data did *not* change, so no
                # event is announced.  Warned once -- the scan repeats every tick.
                if not warned:
                    logger.warning("adventure-call: cannot refresh: %s", exc)
                    warned = True
                changes = None
            else:
                warned = False
            name = ""
            # With --no-refresh the store on disk was left alone, so a refetch would
            # return the same bytes: the gate's warning is the whole answer.
            if changes and not workspace.gate.no_refresh:
                name = first_changed_file(changes)
            if name:
                payload = json.dumps({"file": name}, separators=(",", ":"))
                self._write_block(f"event: {DATA_CHANGED_EVENT}\ndata: {payload}\n\n")
                last_write = time.monotonic()
            elif time.monotonic() - last_write >= workspace.keepalive:
                self._write_block(": ping\n\n")
                last_write = time.monotonic()
            if stream.wait(workspace.poll):
                return  # shutting down

    def _write_block(self, text: str) -> None:
        """One SSE block, flushed -- a buffered event is an event nobody sees."""
        self.wfile.write(text.encode("utf-8"))
        self.wfile.flush()

    # -- the bundle ---------------------------------------------------------------

    def _serve_static(self, path: str, *, with_body: bool) -> None:
        relative = urllib.parse.unquote(path)
        bundle = self._workspace.dist
        candidate = _resolve_under(bundle, relative)
        if candidate is None:
            # An escape ('..', an absolute path, a symlink out of the bundle):
            # refused rather than reported, since confirming it exists is the leak.
            self._send_json(404, {"error": "not found"}, with_body=with_body)
            return
        if candidate.is_dir():
            candidate = candidate / INDEX_HTML
        if candidate.is_file():
            self._send_file(candidate, with_body=with_body)
            return
        if not candidate.suffix and (bundle / INDEX_HTML).is_file():
            # A client-side route ('/workspace/...'): the app's router owns it.
            self._send_file(bundle / INDEX_HTML, with_body=with_body)
            return
        self._send_json(404, {"error": f"not found: {relative}"}, with_body=with_body)

    # -- responses ----------------------------------------------------------------

    def _send_file(self, path: Path, *, with_body: bool) -> None:
        try:
            size = path.stat().st_size
        except OSError:
            self._send_json(404, {"error": "not found"}, with_body=with_body)
            return
        self.send_response(200)
        self.send_header("Content-Type", _content_type(path))
        # The bundle is a snapshot and the client refetches with no-store, so a
        # reload must never be answered from a cached copy.
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(size))
        self.end_headers()
        if with_body:
            self._stream(path)

    def _send_json(self, status: int, payload: dict[str, Any], *, with_body: bool) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if with_body:
            self.wfile.write(body)

    def _stream(self, path: Path) -> None:
        with path.open("rb") as handle:
            shutil.copyfileobj(handle, self.wfile, _COPY_CHUNK)

    def log_message(self, fmt: str, *args: Any) -> None:
        """Access logging is opt-in (``-v``): stderr is for diagnostics by default."""
        if self._workspace.access_log:
            logger.info("%s %s", self.address_string(), fmt % args)


def first_changed_file(changes: dict[str, list[str]]) -> str:
    """The one name to put on the wire: the first path the scan reported.

    :meth:`Store.staleness` groups paths by what happened to them (``modified``,
    ``added``, ``deleted``) and the client only reports "data changed", so one name
    is enough.  A modification -- the common case -- is preferred over an addition
    or a deletion, and ``""`` means the mapping held no path at all.
    """
    for kind in ("modified", "added", "deleted"):
        paths = changes.get(kind)
        if paths:
            return str(paths[0])
    for paths in changes.values():
        if paths:
            return str(paths[0])
    return ""


def _content_type(path: Path) -> str:
    return _CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")


def _resolve_under(bundle: Path, path: str) -> Path | None:
    """``path`` resolved inside ``bundle``, or ``None`` when it leaves the bundle.

    ``resolve()`` follows symlinks, so a link pointing outside is refused too; a
    request for ``/`` is the bundle itself.
    """
    relative = posixpath.normpath(path).lstrip("/")
    if relative in ("", "."):
        return bundle
    try:
        resolved = (bundle / relative).resolve()
    except OSError:
        return None
    return resolved if resolved == bundle or bundle in resolved.parents else None


# -- lifecycle -------------------------------------------------------------------


def build_server(
    store: Store,
    dist: Path | str,
    gate: RefreshGate | None = None,
    *,
    host: str = "127.0.0.1",
    port: int = 0,
    access_log: bool = False,
    keepalive: float = KEEPALIVE_INTERVAL,
    poll: float = EVENT_POLL_INTERVAL,
) -> _StoreHTTPServer:
    """A server bound to ``host:port`` (port 0 lets the OS pick a free one).

    Separate from :func:`run` so tests can drive the handler without the
    process-level lifecycle.  ``keepalive`` and ``poll`` are exposed the same way,
    because a test that waited out the real 15-second ping would be a slow test.
    A busy address raises ``OSError``, which :func:`run` turns into a readable
    message.
    """
    return _StoreHTTPServer(
        (host, port),
        store=store,
        dist=Path(dist),
        gate=gate or RefreshGate(store),
        access_log=access_log,
        keepalive=keepalive,
        poll=poll,
    )


def open_in_browser(url: str) -> bool:
    """Best-effort ``webbrowser.open``: a headless machine is not a failure."""
    try:
        return webbrowser.open(url)
    except Exception:  # noqa: BLE001 - webbrowser raises its own errors and, in the wild, OSError
        logger.debug("adventure-call: could not open a browser for %s", url, exc_info=True)
        return False


def run(
    store: Store,
    *,
    host: str = "127.0.0.1",
    port: int = 0,
    no_refresh: bool = False,
    open_browser: bool = True,
    verbose: bool = False,
    dist: Path | str | None = None,
    gate: RefreshGate | None = None,
) -> str:
    """Serve ``store`` until interrupted; returns the URL that was printed.

    Raises :class:`ServeError` when it cannot start, leaving the exit code to the
    caller.  The one line on stdout is written here, once the OS has chosen a port,
    so what a human or a test reads is the URL actually being served.
    """
    bundle = Path(dist).resolve() if dist is not None else webassets.dist_dir()
    if bundle is None:
        raise ServeError(
            "no web bundle found; build it with 'npm run build' in web/ "
            "(a wheel install ships one, a checkout without Node does not)"
        )
    gate = gate or RefreshGate(store, no_refresh=no_refresh)
    _warn_beyond_loopback(host)
    try:
        server = build_server(store, bundle, gate, host=host, port=port, access_log=verbose)
    except OSError as exc:
        raise ServeError(f"cannot bind {host}:{port}: {exc}") from exc
    try:
        # The store is made current before the first response, exactly as a query
        # command would; later requests re-check on the throttle instead.
        gate.check(force=True)
    except StoreError as exc:
        server.server_close()
        raise ServeError(str(exc)) from exc

    url = f"http://{host}:{server.server_address[1]}"
    print(f"serving {store.path} at {url} (Ctrl-C to stop)", flush=True)
    if open_browser:
        open_in_browser(url)
    previous = _catch_sigterm()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        _restore_sigterm(previous)
    logger.info("stopped")
    return url


def _catch_sigterm() -> Any:
    """Make SIGTERM follow the same path as Ctrl-C, where that is cheap to do."""
    if not hasattr(signal, "SIGTERM") or threading.current_thread() is not threading.main_thread():
        return None

    def _interrupt(signum: int, frame: Any) -> None:
        raise KeyboardInterrupt

    try:
        return signal.signal(signal.SIGTERM, _interrupt)
    except (ValueError, OSError):  # pragma: no cover - a process without handlers
        return None


def _restore_sigterm(previous: Any) -> None:
    if previous is None:
        return
    try:
        signal.signal(signal.SIGTERM, previous)
    except (ValueError, OSError):  # pragma: no cover
        pass


def _warn_beyond_loopback(host: str) -> None:
    """Say so when the payload is about to be reachable beyond this machine."""
    if host not in LOOPBACK_HOSTS:
        logger.warning(
            "adventure-call: serving on %s, beyond loopback -- symbol_registry.json embeds the "
            "project's source code and paths",
            host,
        )


# -- the dev server (tic-ac17) ---------------------------------------------------


#: How long Vite gets to accept connections before ``--dev`` gives up.  A cold
#: Vite start is seconds, not minutes, and the child's own output is streaming the
#: whole while -- so a timeout is reported with a pointer to it, not waited out.
DEV_START_TIMEOUT = 20.0
#: How often the readiness probe dials the port while Vite starts.
DEV_PROBE_INTERVAL = 0.1
#: How long the child is given to exit after SIGTERM before it is SIGKILLed.
DEV_STOP_GRACE = 5.0
#: The checkout's own dev script, run through npm: the command here is the one a
#: developer runs by hand, so a change to ``web/package.json`` is picked up for
#: free instead of being mirrored in this module.
DEV_SCRIPT = ("run", "dev")

#: The seam the dev-mode tests spawn a fake child through.  Assigning the stdlib
#: attribute instead would be visible to every other test in the process.
_popen = subprocess.Popen


def checkout_root() -> Path:
    """The directory holding ``adventure_call/`` -- a checkout's root."""
    return Path(__file__).resolve().parent.parent


def dev_checkout(root: Path | None = None) -> Path:
    """The ``web/`` frontend checkout to run, or a readable :class:`ServeError`.

    Found relative to this module rather than from the cwd, because ``--dev``
    needs the *sources*: a wheel install ships a built bundle and no ``web/``, and
    downloading a frontend is not something this command will ever do.  So this is
    the check that says the machine cannot run ``--dev`` at all, and it names the
    path it looked at.
    """
    web = (checkout_root() if root is None else Path(root)) / "web"
    if not (web / "package.json").is_file():
        raise ServeError(
            f"no frontend checkout at {web}: --dev runs the Vite dev server from a source "
            "checkout of adventure-call, and an installed wheel has no web/ to run "
            "(use plain 'adventure-call serve' there)"
        )
    return web


def npm_executable() -> str:
    """The npm to spawn, or a readable :class:`ServeError` when it is missing."""
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if npm is None:
        raise ServeError(
            "npm was not found on PATH: --dev needs Node.js and npm to run the Vite dev "
            "server (install Node.js, then run 'npm ci' in the web/ checkout)"
        )
    return npm


def require_node_modules(web: Path) -> None:
    """Refuse a checkout whose dependencies were never installed."""
    if not (web / "node_modules").is_dir():
        raise ServeError(f"{web}/node_modules is missing -- run 'npm ci' in {web} first")


def dev_environment(store: Store, *, port: int, host: str | None = None) -> dict[str, str]:
    """The environment the dev server is spawned with (tic-ac17).

    Two things vary per run and neither belongs in the checkout's committed
    ``vite.config.ts``: where the exports Vite serves live (``VCALL_OUT_DIR``, the
    store directory, absolute because the child's cwd is ``web/``) and which port
    to bind (``VCALL_PORT``, because this side has already resolved one and must
    print the port the page is really on).  ``VCALL_HOST`` is set only when an
    address was asked for, so Vite's own default stands otherwise.  Everything
    else is the caller's environment unchanged, which is what keeps PATH, npm
    configuration and colours behaving as they do in a terminal.
    """
    env = dict(os.environ)
    env["VCALL_OUT_DIR"] = str(store.path)
    env["VCALL_PORT"] = str(port)
    if host:
        env["VCALL_HOST"] = host
    return env


def dev_command() -> list[str]:
    """The argv for the dev server: the checkout's own ``npm run dev``.

    Everything that varies per run travels in the environment (see
    :func:`dev_environment`) rather than as extra argv, so the process spawned is
    exactly the one a developer spawns and there is no second place to keep the
    frontend's script name in step.
    """
    return [npm_executable(), *DEV_SCRIPT]


def spawn_dev_server(web: Path, env: Mapping[str, str]) -> Any:
    """Start the checkout's dev server in its own process group, onto this terminal.

    ``start_new_session`` is what makes the "never left behind" promise keepable:
    ``npm run dev`` runs Vite as a child of its own, so signalling npm alone can
    leave Vite holding the port.  A separate group is a tree :func:`stop_child` can
    tear down in one syscall.  stdout and stderr are inherited rather than piped --
    Vite rewrites its own progress lines, so a pipe would turn interactive output
    into buffered blocks, and there is nothing of ours to interleave with it --
    while stdin goes to ``/dev/null``, since the child is not in the terminal's
    foreground group and must never block on a read.
    """
    return _popen(
        dev_command(),
        cwd=str(web),
        env=dict(env),
        start_new_session=True,
        stdin=subprocess.DEVNULL,
    )


def free_port(host: str = "127.0.0.1") -> int:
    """A port the OS says is free, for a run that did not pin one.

    The banner has to name the port the page is on, and "move to the next free
    port" is exactly what :data:`strictPort` turns off, so this side picks one the
    same way ``--port 0`` would and hands it over.  The port is free when it is
    probed, not when Vite binds it; that race is Vite's own "port is already in
    use" error, reported in its output like any other start failure.
    """
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as probe:
        probe.bind((host, 0))
        return int(probe.getsockname()[1])


def dial_host(host: str) -> str:
    """The address to dial (and to open in a browser) for a bind address."""
    if host in ("", "0.0.0.0"):
        return "127.0.0.1"
    return "::1" if host in ("::", "[::]") else host


def display_url(host: str, port: int) -> str:
    """``http://host:port`` as a browser needs it -- bracketed when it is IPv6."""
    shown = dial_host(host)
    return f"http://[{shown}]:{port}" if ":" in shown else f"http://{shown}:{port}"


def dev_port_open(host: str, port: int, *, timeout: float = 0.25) -> bool:
    """True once something accepts a TCP connection on ``host:port``."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def wait_for_port(
    host: str,
    port: int,
    *,
    process: Any = None,
    timeout: float = DEV_START_TIMEOUT,
    interval: float = DEV_PROBE_INTERVAL,
    probe: Callable[..., bool] = dev_port_open,
) -> None:
    """Wait until the dev server accepts connections; raise ``ServeError`` if it never does.

    A port that answers is the only readiness signal worth trusting: Vite prints
    its banner before it is necessarily listening, and a config error means it
    never will be.  ``process`` is polled on the same loop, so a child that died
    is reported at once with its exit code instead of after the whole timeout --
    which is what makes a failed start an error message rather than a hang.
    """
    deadline = time.monotonic() + timeout
    while True:
        if process is not None and process.poll() is not None:
            raise ServeError(
                f"the Vite dev server exited (code {process.returncode}) before "
                f"{display_url(host, port)} accepted connections; its output is above"
            )
        if probe(host, port):
            return
        if time.monotonic() >= deadline:
            raise ServeError(
                f"the Vite dev server did not start listening on {display_url(host, port)} "
                f"within {timeout:.0f}s; its output is above"
            )
        time.sleep(interval)


def _kill_group(process: Any, sig: int) -> None:
    """Signal the child's whole process group -- npm *and* the Vite under it."""
    try:
        os.killpg(process.pid, sig)
    except (AttributeError, OSError):
        # A platform without process groups, or a fake process in a test with no
        # real pid: fall back to signalling the child alone, best effort.
        try:
            process.send_signal(sig)
        except (AttributeError, OSError, ValueError):
            logger.debug("adventure-call: could not signal the dev server", exc_info=True)


def stop_child(
    process: Any,
    *,
    grace: float = DEV_STOP_GRACE,
    kill: Callable[[Any, int], None] | None = None,
) -> None:
    """Terminate the dev server and everything it started; never leave Vite behind.

    SIGTERM first, so Vite closes its port and npm's own handler runs, then
    SIGKILL after ``grace`` seconds: a test run, a Ctrl-C and the next invocation
    all have to be able to start again, and the one unacceptable outcome is a
    child that outlives the command.  Idempotent, because the failed-start path and
    the shutdown path both call it.  ``kill`` is the signalling seam the tests
    replace -- resolved here rather than as a default, so patching the module's
    helper is enough.
    """
    signal_group = kill if kill is not None else _kill_group
    if process is None or process.poll() is not None:
        return
    signal_group(process, signal.SIGTERM)
    try:
        process.wait(timeout=grace)
        return
    except subprocess.TimeoutExpired:
        logger.warning("adventure-call: the dev server ignored SIGTERM; killing it")
    signal_group(process, signal.SIGKILL)
    try:
        process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        logger.warning("adventure-call: the dev server (pid %s) is still running", process.pid)


class _RefreshPoller:
    """Keep the store current while Vite serves it (tic-ac17).

    The served-bundle path re-checks the store from each ``/data/*`` request
    through :meth:`RefreshGate.check`; with ``--dev`` no Python request ever
    arrives, because Vite answers -- so the same throttled check is driven from a
    daemon thread instead.  A re-analysis rewrites the exports, which is what the
    ``outData`` plugin watches, so the change still reaches the browser over HMR.
    A store with nothing parseable is warned about once and does not kill the
    loop: the page keeps serving what is on disk, exactly as the event stream does.
    """

    def __init__(self, gate: RefreshGate, *, interval: float = STALENESS_INTERVAL) -> None:
        self.gate = gate
        self.interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="adventure-call refresh", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self, *, timeout: float = 5.0) -> None:
        """End the loop and wait for the thread, so a shutdown never races a scan."""
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=timeout)

    def running(self) -> bool:
        return self._thread.is_alive()

    def _run(self) -> None:
        warned = False
        while not self._stop.wait(self.interval):
            try:
                self.gate.check()
            except StoreError as exc:
                if not warned:
                    logger.warning("adventure-call: cannot refresh: %s", exc)
                    warned = True
            else:
                warned = False


def run_dev(
    store: Store,
    *,
    host: str = "127.0.0.1",
    port: int = 0,
    no_refresh: bool = False,
    open_browser: bool = True,
    verbose: bool = False,
    root: Path | None = None,
    start_timeout: float = DEV_START_TIMEOUT,
    probe: Callable[..., bool] = dev_port_open,
) -> str:
    """Run the checkout's Vite dev server against ``store`` until interrupted (tic-ac17).

    The other half of ``serve``: the store is discovered, made current and then
    kept current the same way, the port and browser behave the same way, and the
    child is torn down on Ctrl-C, SIGTERM and every failure path alike.  What
    differs is who serves the page -- ``npm run dev`` in the checkout's ``web/``,
    so HMR, React refresh and Vite's own error overlay are the ones a frontend
    change is iterated against.  Returns the URL that was printed; raises
    :class:`ServeError` when it cannot start.
    """
    web = dev_checkout(root)
    require_node_modules(web)
    chosen = port if port else free_port(host)
    gate = RefreshGate(store, no_refresh=no_refresh)
    try:
        # The exports Vite is about to read are made current before it starts,
        # exactly as the served path does before its first response.
        gate.check(force=True)
    except StoreError as exc:
        raise ServeError(str(exc)) from exc
    env = dev_environment(store, port=chosen, host=host)
    _warn_beyond_loopback(host)
    if verbose:
        logger.info("adventure-call: %s (cwd %s)", " ".join(dev_command()), web)
    poller = _RefreshPoller(gate)
    process = spawn_dev_server(web, env)
    poller.start()
    previous = _catch_sigterm()
    url = display_url(host, chosen)
    try:
        wait_for_port(dial_host(host), chosen, process=process, timeout=start_timeout, probe=probe)
        print(f"serving {store.path} at {url} (vite dev; Ctrl-C to stop)", flush=True)
        if open_browser:
            open_in_browser(url)
        # Vite exiting on its own -- a config error, a port it lost after the
        # probe -- is a failed command, not a normal shutdown.
        code = process.wait()
        raise ServeError(f"the Vite dev server exited (code {code}); see its output above")
    except KeyboardInterrupt:
        pass
    finally:
        stop_child(process)
        poller.stop()
        _restore_sigterm(previous)
    logger.info("stopped")
    return url
