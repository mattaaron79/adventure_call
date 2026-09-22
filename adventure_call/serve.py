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
  makes the inspector's ``vscode://`` links work (tic-4b0a);
* everything else comes from the bundle; an unknown path with no file extension
  is a client-side route and answers with ``index.html``.

Limits worth knowing: one store per invocation, and no live update in a tab that
is already open (tic-70f3 adds Server-Sent Events on the same throttle this module
exposes).  The payload is your source code -- ``symbol_registry.json`` embeds full
function bodies -- which is why the default is loopback on an ephemeral port and
why serving anything else warns; the process holds no cache of its own and never
writes to the store except through ``store.update()``.
"""

from __future__ import annotations

import http.server
import json
import logging
import posixpath
import shutil
import signal
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path
from typing import Any, Callable, cast

from adventure_call import __version__, webassets
from adventure_call.store import Store, StoreError

logger = logging.getLogger("adventure_call")

DATA_PREFIX = "/data/"
INDEX_HTML = webassets.INDEX_HTML
#: The store files reachable through ``/data/`` -- outData.ts keeps the same list.
SERVED = ("codebase_graph.json", "symbol_registry.json")
META_NAME = "meta.json"
#: Seconds between request-driven staleness scans: the manifest walk reads every
#: source mtime, so it is cheap but not free, and an asset request must never pay
#: for it -- only ``/data/*`` requests check.
STALENESS_INTERVAL = 3.0
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
    """The ``/data/meta.json`` document, as the client's ``loadAbsoluteRoot`` reads it.

    Its own function on purpose: a later ticket adds a ``project`` field to this
    same document (tic-168b) without going near the request handler.
    """
    return {"root": analysed_root(store)}


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


class _StoreHTTPServer(http.server.ThreadingHTTPServer):
    """A threaded server for one store and one bundle.

    Requests are handled in daemon threads so Ctrl-C never waits on a slow client,
    and the address is reused so a restart is not refused after a crash.
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
    ) -> None:
        self.store = store
        self.dist = Path(dist).resolve()
        self.gate = gate
        self.access_log = access_log
        super().__init__(address, _RequestHandler)


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
) -> _StoreHTTPServer:
    """A server bound to ``host:port`` (port 0 lets the OS pick a free one).

    Separate from :func:`run` so tests -- and a later ticket (tic-70f3) -- can drive
    the handler without the process-level lifecycle.  A busy address raises
    ``OSError``, which :func:`run` turns into a readable message.
    """
    return _StoreHTTPServer(
        (host, port),
        store=store,
        dist=Path(dist),
        gate=gate or RefreshGate(store),
        access_log=access_log,
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
    if host not in LOOPBACK_HOSTS:
        logger.warning(
            "adventure-call: serving on %s, beyond loopback -- symbol_registry.json embeds the "
            "project's source code and paths",
            host,
        )
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
