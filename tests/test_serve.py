"""``vcall serve``: the stdlib web server over a store (tic-c336).

Everything here goes through a real socket with ``http.client`` -- and, for the
event stream, with a raw socket -- because the routes, the 404 bodies, the
traversal refusal, the refresh-on-request behaviour and what arrives while a
connection stays open are things a unit call would not prove.  The bundle is a
stub in a tmp dir, so the contract is tested without ``web/dist`` existing and
without a frontend build.
"""

from __future__ import annotations

import contextlib
import http.client
import json
import logging
import os
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from adventure_call import cli, serve, webassets
from adventure_call.store import STORE_DIRNAME, Store, StoreError


# -- fixtures --------------------------------------------------------------------


@pytest.fixture
def project(tmp_path, sample_root, monkeypatch) -> Path:
    """A copy of the sample project, with the cwd inside it."""
    root = tmp_path / "proj"
    shutil.copytree(sample_root, root)
    monkeypatch.chdir(root)
    return root


@pytest.fixture
def store(project) -> Store:
    """An initialised store over the sample project."""
    assert cli.main(["init", str(project), "-q"]) == 0
    return Store(project / STORE_DIRNAME)


@pytest.fixture
def bundle(tmp_path, monkeypatch) -> Path:
    """A stand-in for ``web/dist``: index.html, one hashed script, one stylesheet."""
    dist = tmp_path / "bundle"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        '<div id="app"></div><script type="module" src="/assets/index-abc123.js"></script>',
        encoding="utf-8",
    )
    (dist / "assets" / "index-abc123.js").write_text("export const app = 1\n", encoding="utf-8")
    (dist / "assets" / "index-abc123.css").write_text("body {}\n", encoding="utf-8")
    monkeypatch.setattr(webassets, "dist_dir", lambda: dist)
    monkeypatch.setattr(webassets, "index_html", lambda: dist / "index.html")
    return dist


@contextlib.contextmanager
def running(store: Store, bundle: Path, gate: serve.RefreshGate | None = None, **options):
    """The server on a real, OS-chosen port, stopped on the way out.

    ``**options`` reaches :func:`serve.build_server`, which is how a stream test
    shortens the keepalive and poll intervals instead of waiting them out.
    """
    server = serve.build_server(store, bundle, gate, **options)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def live(store, bundle):
    with running(store, bundle) as server:
        yield server


@pytest.fixture
def one_shot(monkeypatch):
    """Let :func:`serve.run` return without serving.

    ``shutdown()`` waits on an event that only ``serve_forever`` sets, so a
    lifecycle test has to stub both or it deadlocks.
    """
    monkeypatch.setattr(serve._StoreHTTPServer, "serve_forever", lambda self, *a, **k: None)
    monkeypatch.setattr(serve._StoreHTTPServer, "shutdown", lambda self: None)


@contextlib.contextmanager
def log_lines(level: int = logging.INFO):
    """What this package logs, read off its own logger.

    Tests that drive the server directly never run ``cli.main``, so no handler is
    bound to pytest's captured stderr; the package logger is a stable place to
    listen instead.
    """
    captured: list[str] = []
    handler = logging.Handler()
    handler.emit = lambda record: captured.append(record.getMessage())  # type: ignore[method-assign]
    target = logging.getLogger("adventure_call")
    previous = target.level
    target.setLevel(level)
    target.addHandler(handler)
    try:
        yield captured
    finally:
        target.removeHandler(handler)
        target.setLevel(previous)


def fetch(server, path: str, method: str = "GET") -> tuple[int, dict[str, str], bytes]:
    """One request over a real socket: status, lower-cased headers, body bytes."""
    connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
    try:
        connection.request(method, path)
        response = connection.getresponse()
        headers = {name.lower(): value for name, value in response.getheaders()}
        return response.status, headers, response.read()
    finally:
        connection.close()


# -- /data/* ---------------------------------------------------------------------


def test_data_routes_stream_the_store_exports(live):
    for name in serve.SERVED:
        status, headers, body = fetch(live, f"/data/{name}")
        on_disk = (live.store.path / name).read_bytes()
        assert status == 200, name
        assert body == on_disk, name  # byte-identical: no re-serialisation
        assert headers["content-type"] == "application/json; charset=utf-8"
        assert headers["cache-control"] == "no-store"
        assert headers["content-length"] == str(len(on_disk))


def test_a_missing_export_404s_with_the_dev_servers_body(live):
    target = live.store.path / "symbol_registry.json"
    target.unlink()
    status, headers, body = fetch(live, "/data/symbol_registry.json")
    assert status == 404
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert json.loads(body) == {"error": "missing symbol_registry.json", "expected": str(target)}


def test_data_traversal_is_refused(live):
    for path in ("/data/../manifest.json", "/data/%2e%2e/manifest.json", "/data/..%2fmanifest.json"):
        status, _, body = fetch(live, path)
        assert status == 404, path
        assert "no such data file" in json.loads(body)["error"]
        assert b"src/" not in body  # nothing of the manifest leaked


def test_meta_reports_the_absolute_analysed_root(live):
    status, headers, body = fetch(live, "/data/meta.json")
    assert status == 200
    assert headers["cache-control"] == "no-store"
    root = live.store.root.resolve().as_posix()
    assert json.loads(body) == {"root": root, "project": serve.project_id(root)}


def test_meta_names_the_project_of_the_store_it_serves(live):
    """The project the page namespaces its saved state by (tic-168b)."""
    _, _, body = fetch(live, "/data/meta.json")
    payload = json.loads(body)
    assert payload["project"]  # non-empty: a served store always names one
    assert payload["project"] == serve.project_id(payload["root"])

    # Stable across requests, because the browser keys localStorage by it and a
    # moving id would strand everything a session had saved.
    _, _, again = fetch(live, "/data/meta.json")
    assert json.loads(again)["project"] == payload["project"]


def test_two_stores_over_two_roots_answer_two_projects(bundle, tmp_path, sample_root):
    """Two served stores must not share one browser's saved state."""
    projects = {}
    for name in ("one", "two"):
        root = tmp_path / name
        shutil.copytree(sample_root, root)
        assert cli.main(["init", str(root), "-q"]) == 0
        with running(Store(root / STORE_DIRNAME), bundle) as server:
            _, _, body = fetch(server, "/data/meta.json")
        payload = json.loads(body)
        assert payload["root"] == root.resolve().as_posix()
        projects[name] = payload["project"]

    assert None not in projects.values()
    assert projects["one"] != projects["two"]


def test_project_id_is_derived_from_the_analysed_path():
    assert serve.project_id("/repo/projects/carnot") == "carnot-70249695"
    # Two same-named projects are still two projects: the whole path is hashed.
    assert serve.project_id("/repo/projects/deploy") != serve.project_id("/repo/other/deploy")
    # Nothing to hash -- an unreadable graph, an empty root -- names no project,
    # which leaves the client on its unnamespaced keys.
    assert serve.project_id(None) is None
    assert serve.project_id("") is None
    # A root with no directory name to slug still gets a stable id.
    assert serve.project_id("/") == "8a5edab2"


def test_meta_falls_back_to_the_store_root_and_never_raises(live):
    graph = live.store.path / "codebase_graph.json"
    root = live.store.root.resolve().as_posix()

    graph.write_text(json.dumps({"graph": {"root": "."}}), encoding="utf-8")
    _, _, body = fetch(live, "/data/meta.json")
    assert json.loads(body) == {"root": root, "project": serve.project_id(root)}

    graph.write_text("{not json", encoding="utf-8")
    _, _, body = fetch(live, "/data/meta.json")
    assert json.loads(body) == {"root": None, "project": None}

    graph.unlink()
    _, _, body = fetch(live, "/data/meta.json")
    assert json.loads(body) == {"root": None, "project": None}


# -- the bundle ------------------------------------------------------------------


def test_the_page_and_its_asset_are_served_with_the_right_types(live, bundle):
    status, headers, body = fetch(live, "/")
    assert status == 200
    assert headers["content-type"] == "text/html; charset=utf-8"
    assert body == (bundle / "index.html").read_bytes()

    status, headers, _ = fetch(live, "/assets/index-abc123.js")
    assert status == 200
    assert headers["content-type"] == "text/javascript; charset=utf-8"
    assert headers["cache-control"] == "no-store"

    status, headers, _ = fetch(live, "/assets/index-abc123.css")
    assert status == 200 and headers["content-type"] == "text/css; charset=utf-8"


def test_an_unknown_client_route_serves_the_app_and_an_unknown_asset_404s(live, bundle):
    status, headers, body = fetch(live, "/workspace/call-flow")
    assert status == 200
    assert headers["content-type"] == "text/html; charset=utf-8"
    assert body == (bundle / "index.html").read_bytes()

    status, headers, body = fetch(live, "/assets/nope-abc123.js")
    assert status == 404
    assert headers["content-type"] == "application/json; charset=utf-8"
    assert "not found" in json.loads(body)["error"]


def test_static_traversal_and_symlinks_out_of_the_bundle_are_refused(live, bundle, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("do not serve me\n", encoding="utf-8")
    try:
        (bundle / "assets" / "leak.txt").symlink_to(secret)
    except OSError:  # pragma: no cover - Windows without the symlink privilege
        pass
    for path in ("/../secret.txt", "/assets/../../secret.txt", "/assets/leak.txt", "/assets/%2e%2e/secret.txt"):
        status, _, body = fetch(live, path)
        assert status == 404, path
        assert b"do not serve me" not in body


def test_head_sends_the_headers_and_no_body(live):
    status, headers, body = fetch(live, "/", method="HEAD")
    assert status == 200
    assert body == b""
    assert int(headers["content-length"]) > 0


# -- freshness -------------------------------------------------------------------


def test_a_stale_store_is_re_analysed_before_the_first_response(live, store):
    (store.root / "src" / "extra.py").write_text("def brand_new():\n    return 1\n", encoding="utf-8")
    assert store.staleness()

    status, _, body = fetch(live, "/data/codebase_graph.json")
    assert status == 200
    assert b"src.extra" in body  # the response is the new analysis, not the old file
    assert store.staleness() == {}


def test_no_refresh_warns_and_leaves_the_store_alone(store, bundle):
    with log_lines() as lines:
        with running(store, bundle, serve.RefreshGate(store, no_refresh=True)) as server:
            manifest = store.path / "manifest.json"
            before = manifest.stat().st_mtime_ns
            (store.root / "src" / "extra.py").write_text("def brand_new():\n    return 1\n", encoding="utf-8")

            status, _, body = fetch(server, "/data/codebase_graph.json")
            assert status == 200
            assert manifest.stat().st_mtime_ns == before
            assert store.staleness()
            assert b"src.extra" not in body

    assert any("analysis is stale" in line for line in lines)


def test_the_request_throttle_scans_once_per_interval():
    store = _FakeStore()
    now = [100.0]
    gate = serve.RefreshGate(store, interval=3.0, clock=lambda: now[0])

    assert gate.check() == {}
    now[0] += 1.0
    assert gate.check() is None  # inside the interval: no scan at all
    assert store.scans == 1

    now[0] += 3.0
    assert gate.check() == {}
    assert store.scans == 2


def test_the_gate_re_analyses_a_stale_store_and_can_be_forced():
    store = _FakeStore(changes={"modified": ["src/x.py"]})
    gate = serve.RefreshGate(store, clock=lambda: 0.0)
    assert gate.check() == {"modified": ["src/x.py"]}
    assert store.updates == 1


def test_the_gate_warns_instead_of_writing_with_no_refresh():
    store = _FakeStore(changes={"modified": ["src/x.py"]})
    gate = serve.RefreshGate(store, no_refresh=True, clock=lambda: 0.0)
    assert gate.check(force=True) == {"modified": ["src/x.py"]}
    assert store.updates == 0


class _FakeStore:
    """The two ``Store`` methods the gate uses, and how often it used them."""

    def __init__(self, changes: dict[str, list[str]] | None = None) -> None:
        self.path = Path("/nowhere/.adventure-call")
        self.root = Path("/nowhere")
        self.changes = changes or {}
        self.scans = 0
        self.updates = 0

    def staleness(self) -> dict[str, list[str]]:
        self.scans += 1
        return self.changes

    def update(self) -> object | None:
        self.updates += 1
        return object()


# -- the command -----------------------------------------------------------------


def test_serve_outside_a_store_exits_3_with_the_init_hint(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert cli.main(["serve", "--no-open"]) == 3
    assert "adventure-call init" in capsys.readouterr().err


def test_a_root_without_a_store_exits_3_naming_that_root(tmp_path, bundle, capsys):
    empty = tmp_path / "empty"
    empty.mkdir()
    assert cli.main(["serve", str(empty), "--no-open"]) == 3
    err = capsys.readouterr().err
    assert str(empty) in err and "adventure-call init" in err


def test_serve_finds_the_store_from_a_subdirectory(store, bundle, one_shot, monkeypatch, capsys):
    monkeypatch.chdir(store.root / "src")
    assert cli.main(["serve", "--no-open"]) == 0
    assert str(store.path) in capsys.readouterr().out


def test_serve_takes_the_root_positional(store, project, bundle, one_shot, capsys):
    assert cli.main(["serve", str(project), "--no-open", "-q"]) == 0
    assert str(store.path) in capsys.readouterr().out


def test_a_busy_port_is_a_clear_error(store, bundle, capsys):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    try:
        port = listener.getsockname()[1]
        code = cli.main(["serve", "--store", str(store.path), "--port", str(port), "--no-open"])
    finally:
        listener.close()
    assert code == 1
    assert "cannot bind" in capsys.readouterr().err


def test_a_missing_bundle_is_an_actionable_error(store, monkeypatch, capsys):
    monkeypatch.setattr(webassets, "dist_dir", lambda: None)
    monkeypatch.setattr(webassets, "index_html", lambda: None)
    assert cli.main(["serve", "--store", str(store.path), "--no-open"]) == 1
    assert "npm run build" in capsys.readouterr().err


def test_the_serving_line_is_the_only_thing_on_stdout(store, bundle, one_shot, capsys):
    assert cli.main(["serve", "--store", str(store.path), "--no-open"]) == 0
    captured = capsys.readouterr()
    match = re.fullmatch(r"serving (\S+) at http://127\.0\.0\.1:(\d+) \(Ctrl-C to stop\)\n", captured.out)
    assert match, captured.out
    assert match.group(1) == str(store.path)
    assert int(match.group(2)) > 0  # port 0 was resolved to a real one
    assert "stopped" in captured.err


def test_no_open_never_touches_the_browser(store, bundle, one_shot, monkeypatch):
    monkeypatch.setattr(serve.webbrowser, "open", lambda url: pytest.fail("--no-open opened a browser"))
    assert cli.main(["serve", "--store", str(store.path), "--no-open"]) == 0


def test_the_browser_opens_on_the_printed_url(store, bundle, one_shot, monkeypatch, capsys):
    opened: list[str] = []
    monkeypatch.setattr(serve.webbrowser, "open", lambda url: opened.append(url) or True)
    assert cli.main(["serve", "--store", str(store.path), "-q"]) == 0
    printed = re.search(r"at (\S+) \(Ctrl-C", capsys.readouterr().out)
    assert printed is not None and opened == [printed.group(1)]


def test_a_browser_that_refuses_to_open_is_not_fatal(store, bundle, one_shot, monkeypatch):
    def refuse(url):
        raise webbrowser.Error("no browser here")

    monkeypatch.setattr(serve.webbrowser, "open", refuse)
    assert cli.main(["serve", "--store", str(store.path)]) == 0


def test_serving_beyond_loopback_warns(store, bundle, one_shot, capsys):
    assert cli.main(["serve", "--store", str(store.path), "--host", "0.0.0.0", "--no-open"]) == 0
    assert "beyond loopback" in capsys.readouterr().err


def test_the_access_log_is_off_until_verbose(store, bundle):
    with log_lines() as lines:
        with running(store, bundle, serve.RefreshGate(store)) as server:
            fetch(server, "/data/meta.json")
    assert not any("GET /data/meta.json" in line for line in lines)  # off by default

    with log_lines() as lines:
        with running(store, bundle, serve.RefreshGate(store)) as server:
            server.access_log = True
            fetch(server, "/data/meta.json")
    assert any("GET /data/meta.json" in line for line in lines)


# -- /data/events (tic-70f3) ------------------------------------------------------


class EventReader:
    """Lines off an open SSE connection, with deadlines instead of hangs.

    A raw socket on purpose: what matters is what arrives *while* the connection
    stays open, and ``http.client``'s buffered reader is awkward once a read has
    timed out.  ``select`` decides when a read may block at all.
    """

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.status = ""
        self.lines: list[str] = []
        self._buffer = b""

    def handshake(self, *, timeout: float = 10.0) -> dict[str, str]:
        """The status line and the headers of the streaming response."""
        self.status = self.read_line(timeout=timeout)
        headers: dict[str, str] = {}
        while True:
            line = self.read_line(timeout=timeout)
            if not line:
                return headers
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip()

    def read_line(self, *, timeout: float = 10.0) -> str:
        """One line, or an ``AssertionError`` naming what did arrive instead."""
        deadline = time.monotonic() + timeout
        while b"\n" not in self._buffer:
            if not select.select([self.sock], [], [], max(deadline - time.monotonic(), 0.0))[0]:
                raise AssertionError(f"no line within {timeout}s; got {self.lines}")
            chunk = self.sock.recv(4096)
            if not chunk:
                raise AssertionError(f"the stream closed early; got {self.lines}")
            self._buffer += chunk
        line, _, self._buffer = self._buffer.partition(b"\n")
        text = line.decode("utf-8").rstrip("\r")
        self.lines.append(text)
        return text

    def read_until(self, predicate: Callable[[str], bool], *, timeout: float = 10.0) -> str:
        """The first line matching ``predicate``; fails once ``timeout`` is up."""
        deadline = time.monotonic() + timeout
        while True:
            line = self.read_line(timeout=max(deadline - time.monotonic(), 0.0))
            if predicate(line):
                return line

    def wait_for_close(self, *, timeout: float = 5.0) -> None:
        """Read until the server ends the stream, by EOF or by a reset."""
        deadline = time.monotonic() + timeout
        while True:
            if not select.select([self.sock], [], [], max(deadline - time.monotonic(), 0.0))[0]:
                raise AssertionError(f"the stream stayed open; got {self.lines}")
            try:
                chunk = self.sock.recv(4096)
            except ConnectionResetError:
                return
            if not chunk:
                return


@contextlib.contextmanager
def event_stream(server, path: str = "/data/events"):
    """A raw ``GET`` on ``path``, held open for the caller and closed on the way out."""
    port = server.server_address[1]
    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    sock.sendall(
        f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
        "Accept: text/event-stream\r\n\r\n".encode("ascii")
    )
    try:
        yield EventReader(sock)
    finally:
        sock.close()


def wait_until(predicate: Callable[[], bool], *, timeout: float = 5.0, what: str = "it") -> None:
    """Poll ``predicate`` until it holds, then fail loudly -- never sleep blindly."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(f"{what} never happened within {timeout}s")


def test_the_event_names_the_first_changed_file():
    assert serve.first_changed_file({"modified": ["src/a.py"], "added": ["src/b.py"]}) == "src/a.py"
    assert serve.first_changed_file({"added": ["src/b.py"]}) == "src/b.py"
    assert serve.first_changed_file({"deleted": ["src/c.py"]}) == "src/c.py"
    assert serve.first_changed_file({}) == ""


def test_the_stream_announces_a_touched_source_file(store, bundle):
    gate = serve.RefreshGate(store, interval=0.05)
    with running(store, bundle, gate, poll=0.05, keepalive=0.05) as server:
        with event_stream(server) as events:
            headers = events.handshake()
            assert events.status.startswith("HTTP/1.1 200")
            assert headers["content-type"] == "text/event-stream"
            assert headers["cache-control"] == "no-store"
            assert events.read_until(lambda line: line == ": ready", timeout=5) == ": ready"

            (store.root / "src" / "extra.py").write_text(
                "def brand_new():\n    return 1\n", encoding="utf-8"
            )

            event = events.read_until(lambda line: line.startswith("event:"), timeout=15)
            assert event == f"event: {serve.DATA_CHANGED_EVENT}"
            data = events.read_until(lambda line: line.startswith("data:"), timeout=5)
            assert json.loads(data.removeprefix("data: ")) == {"file": "src/extra.py"}
            assert store.staleness() == {}  # the stream re-analysed, it did not just say so


def test_a_client_that_disappears_ends_only_its_own_stream(store, bundle):
    gate = serve.RefreshGate(store, interval=0.05)
    with running(store, bundle, gate, poll=0.02, keepalive=0.02) as server:
        with event_stream(server) as events:
            events.handshake()
            events.read_until(lambda line: line == ": ready", timeout=5)
            assert server.stream_count() == 1
        # The socket is closed here; the writer notices at its next ping.
        wait_until(lambda: server.stream_count() == 0, what="the dead stream to be dropped")

        status, _, body = fetch(server, "/data/meta.json")
        assert status == 200
        assert json.loads(body)["root"] == store.root.resolve().as_posix()

        # ...and a new subscriber is still welcomed.
        with event_stream(server) as again:
            again.handshake()
            assert again.read_until(lambda line: line == ": ready", timeout=5) == ": ready"


def test_the_stream_keeps_an_idle_connection_alive(store, bundle):
    with running(store, bundle, serve.RefreshGate(store), poll=0.02, keepalive=0.1) as server:
        with event_stream(server) as events:
            events.handshake()
            assert events.read_until(lambda line: line == ": ping", timeout=5) == ": ping"


def test_no_refresh_warns_instead_of_announcing(store, bundle):
    gate = serve.RefreshGate(store, no_refresh=True, interval=0.05)
    with log_lines() as lines:
        with running(store, bundle, gate, poll=0.05, keepalive=0.1) as server:
            with event_stream(server) as events:
                events.handshake()
                events.read_until(lambda line: line == ": ready", timeout=5)
                (store.root / "src" / "extra.py").write_text(
                    "def brand_new():\n    return 1\n", encoding="utf-8"
                )
                # Two keepalives' worth of ticks: the gate has scanned by now.
                events.read_until(lambda line: line == ": ping", timeout=5)
                events.read_until(lambda line: line == ": ping", timeout=5)
                # The served bytes did not change, so nothing may ask for a refetch.
                assert not any(line.startswith("event: ") for line in events.lines)
    assert any("analysis is stale" in line for line in lines)


def test_head_gets_the_stream_headers_without_opening_one(store, bundle):
    with running(store, bundle, serve.RefreshGate(store), poll=0.02, keepalive=0.02) as server:
        status, headers, body = fetch(server, "/data/events", method="HEAD")
        assert status == 200
        assert headers["content-type"] == "text/event-stream"
        assert body == b""
        assert server.stream_count() == 0  # no subscriber, nothing to hold open


def test_a_stream_is_not_opened_for_a_non_get_request(store, bundle):
    with running(store, bundle, serve.RefreshGate(store), poll=0.02, keepalive=0.02) as server:
        status, _, _ = fetch(server, "/data/events", method="POST")
        assert status == 501  # http.server's answer to a method it has no handler for
        assert server.stream_count() == 0


def test_shutting_the_server_down_ends_every_open_stream(store, bundle):
    server = serve.build_server(
        store, bundle, serve.RefreshGate(store), poll=0.02, keepalive=0.02
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with event_stream(server) as events:
            events.handshake()
            events.read_until(lambda line: line == ": ready", timeout=5)
            assert server.stream_count() == 1

            server.shutdown()
            server.server_close()

            wait_until(lambda: server.stream_count() == 0, what="the writers to be cancelled")
            events.wait_for_close(timeout=5)
        thread.join(timeout=5)
        assert not thread.is_alive()
    finally:
        server.server_close()
    # No writer thread is left behind: a stream outliving the server is a leak.
    wait_until(
        lambda: not [t for t in threading.enumerate() if t.name.startswith("adventure-call events")],
        what="the event writer threads to finish",
    )


# -- serve --dev (tic-ac17) -------------------------------------------------------


class FakeProcess:
    """A stand-in for the spawned dev server: a scripted ``poll``, ``wait`` and Ctrl-C.

    The pid is one no process can have, so a ``_kill_group`` a test forgot to
    replace still cannot reach a real one, and ``send_signal`` fails loudly if the
    non-POSIX fallback is ever taken against this fake.
    """

    def __init__(
        self,
        *,
        code: int | None = None,
        wait_timeouts: int = 0,
        interrupts: int = 0,
        pid: int = 2**31 - 1,
    ) -> None:
        self.pid = pid
        self.code = code
        self.returncode = code
        self.waits: list[float | None] = []
        self._wait_timeouts = wait_timeouts
        self._interrupts = interrupts

    def poll(self) -> int | None:
        return self.code

    def wait(self, timeout: float | None = None) -> int:
        self.waits.append(timeout)
        if self._interrupts:
            self._interrupts -= 1
            raise KeyboardInterrupt
        if self._wait_timeouts:
            self._wait_timeouts -= 1
            raise subprocess.TimeoutExpired("vite", timeout or 0)
        return self.code or 0

    def send_signal(self, sig: int) -> None:
        raise AssertionError("the fake child must be signalled through its group")


class FakeGate:
    """The one method :class:`serve._RefreshPoller` drives; no throttle to wait on."""

    def __init__(self, error: Exception | None = None) -> None:
        self.calls = 0
        self.error = error

    def check(self, *, force: bool = False) -> None:
        self.calls += 1
        if self.error is not None:
            raise self.error


@pytest.fixture
def checkout(tmp_path) -> Path:
    """A stand-in source checkout: ``web/`` with its dependencies installed."""
    web = tmp_path / "checkout" / "web"
    (web / "node_modules").mkdir(parents=True)
    (web / "package.json").write_text('{"scripts": {"dev": "vite"}}', encoding="utf-8")
    return web


def test_the_dev_environment_hands_the_store_and_port_to_the_plugin(store, monkeypatch):
    monkeypatch.setenv("VCALL_MARKER", "kept")
    env = serve.dev_environment(store, port=5180)
    assert env["VCALL_OUT_DIR"] == str(store.path)
    assert Path(env["VCALL_OUT_DIR"]).is_absolute()  # the child's cwd is web/
    assert env["VCALL_PORT"] == "5180"
    assert env["VCALL_MARKER"] == "kept"  # the caller's environment is inherited
    assert "VCALL_HOST" not in env  # Vite's own bind default stands
    assert serve.dev_environment(store, port=1, host="0.0.0.0")["VCALL_HOST"] == "0.0.0.0"
    assert "VCALL_OUT_DIR" not in os.environ  # nothing is exported into this process


def test_the_dev_command_is_the_checkouts_own_script(monkeypatch):
    monkeypatch.setattr(serve.shutil, "which", lambda name: "/opt/node/bin/npm")
    assert serve.dev_command() == ["/opt/node/bin/npm", "run", "dev"]


def test_dev_mode_needs_a_frontend_checkout(tmp_path):
    with pytest.raises(serve.ServeError) as caught:
        serve.dev_checkout(tmp_path)
    message = str(caught.value)
    assert "source checkout" in message and "web" in message


def test_dev_mode_needs_npm_on_path(monkeypatch):
    monkeypatch.setattr(serve.shutil, "which", lambda name: None)
    with pytest.raises(serve.ServeError) as caught:
        serve.npm_executable()
    assert "npm ci" in str(caught.value)  # the actionable half of the message


def test_dev_mode_needs_the_checkouts_installed_dependencies(checkout):
    assert serve.dev_checkout(checkout.parent) == checkout
    shutil.rmtree(checkout / "node_modules")
    with pytest.raises(serve.ServeError) as caught:
        serve.require_node_modules(checkout)
    assert "npm ci" in str(caught.value)
    (checkout / "node_modules").mkdir()
    serve.require_node_modules(checkout)  # installed: nothing raised


def test_the_child_is_spawned_in_its_own_group_with_the_environment(store, tmp_path, monkeypatch):
    monkeypatch.setattr(serve.shutil, "which", lambda name: "/opt/node/bin/npm")
    seen: dict[str, Any] = {}

    def fake_popen(argv, **kwargs):
        seen["argv"] = argv
        seen.update(kwargs)
        return FakeProcess()

    monkeypatch.setattr(serve, "_popen", fake_popen)
    web = tmp_path / "web"
    web.mkdir()
    env = serve.dev_environment(store, port=5180, host="127.0.0.1")
    process = serve.spawn_dev_server(web, env)
    assert isinstance(process, FakeProcess)
    assert seen["argv"] == ["/opt/node/bin/npm", "run", "dev"]
    assert seen["cwd"] == str(web)
    assert seen["env"] == env and seen["env"] is not env  # copied, never shared
    assert seen["start_new_session"] is True  # teardown signals the whole tree
    assert seen["stdin"] is subprocess.DEVNULL


def test_a_stopping_child_is_signalled_once_and_waited_for():
    process = FakeProcess()
    signals: list[int] = []
    serve.stop_child(process, grace=1.0, kill=lambda p, sig: signals.append(sig))
    assert signals == [signal.SIGTERM]
    assert process.waits == [1.0]


def test_a_child_that_ignores_sigterm_is_killed():
    process = FakeProcess(wait_timeouts=1)
    signals: list[int] = []
    serve.stop_child(process, grace=0.1, kill=lambda p, sig: signals.append(sig))
    assert signals == [signal.SIGTERM, signal.SIGKILL]
    assert process.waits == [0.1, 0.1]


def test_a_child_that_already_exited_is_left_alone():
    signals: list[int] = []
    serve.stop_child(None, kill=lambda p, sig: signals.append(sig))
    serve.stop_child(FakeProcess(code=0), kill=lambda p, sig: signals.append(sig))
    assert signals == []


def test_the_kill_seam_reaches_a_real_process_group():
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True
    )
    try:
        serve._kill_group(child, signal.SIGTERM)
        assert child.wait(timeout=5) == -signal.SIGTERM  # the group took the signal
    finally:
        if child.poll() is None:  # pragma: no cover - the assertion above failed
            serve._kill_group(child, signal.SIGKILL)
            child.wait(timeout=5)


def test_the_wait_ends_when_the_port_answers():
    probes: list[tuple[str, int]] = []

    def probe(host: str, port: int) -> bool:
        probes.append((host, port))
        return len(probes) == 3  # a cold Vite: two refusals, then a listener

    serve.wait_for_port(
        "127.0.0.1", 5199, process=FakeProcess(), timeout=1.0, interval=0.001, probe=probe
    )
    assert probes == [("127.0.0.1", 5199)] * 3


def test_a_child_that_died_before_the_port_opened_is_reported_with_its_code():
    with pytest.raises(serve.ServeError) as caught:
        serve.wait_for_port(
            "127.0.0.1",
            5199,
            process=FakeProcess(code=3),
            timeout=1.0,
            interval=0.001,
            probe=lambda host, port: False,
        )
    assert "code 3" in str(caught.value)


def test_a_port_that_never_opens_times_out():
    started = time.monotonic()
    with pytest.raises(serve.ServeError) as caught:
        serve.wait_for_port(
            "127.0.0.1",
            5199,
            process=FakeProcess(),
            timeout=0.05,
            interval=0.005,
            probe=lambda host, port: False,
        )
    assert "did not start listening" in str(caught.value)
    assert time.monotonic() - started < 5  # it gave up, it did not hang


def test_dev_mode_tears_the_child_down_when_the_start_fails(store, checkout, monkeypatch):
    process = FakeProcess()  # alive, but its port never opens
    monkeypatch.setattr(serve, "_popen", lambda argv, **kwargs: process)
    signals: list[int] = []
    monkeypatch.setattr(serve, "_kill_group", lambda p, sig: signals.append(sig))
    with pytest.raises(serve.ServeError) as caught:
        serve.run_dev(
            store,
            root=checkout.parent,
            port=5199,
            open_browser=False,
            start_timeout=0.05,
            probe=lambda host, port: False,
        )
    assert "did not start listening" in str(caught.value)
    assert signals == [signal.SIGTERM]  # the child did not outlive the failure
    assert process.waits == [serve.DEV_STOP_GRACE]


def test_dev_mode_returns_the_url_and_stops_the_child_on_interrupt(
    store, checkout, monkeypatch, capsys
):
    process = FakeProcess(interrupts=1)  # Ctrl-C while the child is awaited
    monkeypatch.setattr(serve, "_popen", lambda argv, **kwargs: process)
    signals: list[int] = []
    monkeypatch.setattr(serve, "_kill_group", lambda p, sig: signals.append(sig))
    opened: list[str] = []
    monkeypatch.setattr(serve, "open_in_browser", opened.append)
    url = serve.run_dev(
        store, root=checkout.parent, port=5199, start_timeout=1.0, probe=lambda host, port: True
    )
    assert url == "http://127.0.0.1:5199"
    assert opened == [url]
    assert signals == [signal.SIGTERM]
    assert "serving" in capsys.readouterr().out
    assert not [t for t in threading.enumerate() if t.name == "adventure-call refresh"]


def test_the_dev_poller_keeps_the_store_current_until_it_is_stopped():
    gate = FakeGate()
    poller = serve._RefreshPoller(gate, interval=0.01)
    poller.start()
    try:
        wait_until(lambda: gate.calls >= 2, what="the store to be re-checked")
    finally:
        poller.stop()
    assert not poller.running()


def test_the_dev_poller_warns_once_about_a_store_it_cannot_refresh():
    gate = FakeGate(StoreError("no parseable source files"))
    with log_lines(logging.WARNING) as lines:
        poller = serve._RefreshPoller(gate, interval=0.01)
        poller.start()
        try:
            wait_until(lambda: gate.calls >= 3, what="three ticks to pass")
        finally:
            poller.stop()
    assert sum(1 for line in lines if "cannot refresh" in line) == 1  # warned, kept going


def test_the_address_helpers_make_a_dialable_url():
    assert serve.dial_host("0.0.0.0") == "127.0.0.1"
    assert serve.dial_host("127.0.0.1") == "127.0.0.1"
    assert serve.display_url("127.0.0.1", 5180) == "http://127.0.0.1:5180"
    assert serve.display_url("::1", 5180) == "http://[::1]:5180"
    port = serve.free_port()  # the OS hands one out, and it is bindable straight away
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", port))


def test_the_cli_maps_dev_onto_the_dev_server(store, monkeypatch):
    calls: list[tuple[Store, dict[str, Any]]] = []

    def fake_run_dev(target, **options):
        calls.append((target, options))
        return "http://127.0.0.1:5199"

    monkeypatch.setattr(serve, "run_dev", fake_run_dev)
    assert cli.main(["serve", "--dev", "--no-open", "--port", "5199", "--no-refresh"]) == 0
    assert len(calls) == 1
    target, options = calls[0]
    assert target.path == store.path  # the store discovery is the served path's
    assert options == {
        "host": "127.0.0.1",
        "port": 5199,
        "no_refresh": True,
        "open_browser": False,
        "verbose": False,
    }


def test_a_dev_mode_failure_is_a_message_and_a_non_zero_exit(store, monkeypatch):
    def fail(target, **options):
        raise serve.ServeError("npm was not found on PATH: run 'npm ci' in the web/ checkout")

    monkeypatch.setattr(serve, "run_dev", fail)
    assert cli.main(["serve", "--dev", "--no-open"]) == 1
