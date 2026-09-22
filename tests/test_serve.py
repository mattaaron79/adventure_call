"""``vcall serve``: the stdlib web server over a store (tic-c336).

Everything here goes through a real socket with ``http.client``: the routes, the
404 bodies, the traversal refusal and the refresh-on-request behaviour are things
a unit call would not prove.  The bundle is a stub in a tmp dir, so the contract
is tested without ``web/dist`` existing and without a frontend build.
"""

from __future__ import annotations

import contextlib
import http.client
import json
import logging
import re
import shutil
import socket
import threading
import webbrowser
from pathlib import Path

import pytest

from adventure_call import cli, serve, webassets
from adventure_call.store import STORE_DIRNAME, Store


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
def running(store: Store, bundle: Path, gate: serve.RefreshGate | None = None):
    """The server on a real, OS-chosen port, stopped on the way out."""
    server = serve.build_server(store, bundle, gate)
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
    assert json.loads(body) == {"root": live.store.root.resolve().as_posix()}


def test_meta_falls_back_to_the_store_root_and_never_raises(live):
    graph = live.store.path / "codebase_graph.json"

    graph.write_text(json.dumps({"graph": {"root": "."}}), encoding="utf-8")
    _, _, body = fetch(live, "/data/meta.json")
    assert json.loads(body) == {"root": live.store.root.resolve().as_posix()}

    graph.write_text("{not json", encoding="utf-8")
    _, _, body = fetch(live, "/data/meta.json")
    assert json.loads(body) == {"root": None}

    graph.unlink()
    _, _, body = fetch(live, "/data/meta.json")
    assert json.loads(body) == {"root": None}


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
