"""Where the web bundle is found (tic-c11c), and that the wheel carries it.

Building a wheel is deliberately not part of this suite: it needs hatchling, npm
and a network fetch, none of which should gate ``pytest``. The packaging half is
therefore asserted as configuration here, with the real build checked by hand:

    npm run build            # in web/, if the bundle is not present yet
    uv build
    python -m zipfile -l dist/*.whl | grep 'web/index.html'

A wheel built from a checkout with no ``web/dist`` is valid and simply carries no
bundle -- the configuration maps ``web/dist`` in only when it exists, so a
Node-less install still builds (hatchling's ``force-include`` would fail the
build on the absent path, which is why it is not used).
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from adventure_call import webassets

REPO_ROOT = Path(__file__).resolve().parent.parent
CHECKOUT_BUNDLE = "/".join(webassets.CHECKOUT_SUBDIRS)
PACKAGED_BUNDLE = f"{webassets.PACKAGE}/{webassets.PACKAGED_SUBDIR}"


def _bundle(root: Path, marker: str) -> Path:
    """Lay out a minimal bundle: an index.html plus one hashed asset."""
    directory = root / "web" / "dist"
    (directory / "assets").mkdir(parents=True, exist_ok=True)
    (directory / "index.html").write_text(f"<div id={marker}></div>", encoding="utf-8")
    (directory / "assets" / "index-abc123.js").write_text("export {}\n", encoding="utf-8")
    return directory


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """Every path under ``root``, with the size and mtime that a write would move."""
    return {
        str(path.relative_to(root)): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(root.rglob("*"))
    }


def test_packaged_bundle_wins_over_the_checkout(tmp_path, monkeypatch):
    packaged = _bundle(tmp_path / "installed", "packaged")
    checkout = _bundle(tmp_path / "checkout", "checkout")
    monkeypatch.setattr(webassets, "_packaged_dir", lambda: packaged)
    monkeypatch.setattr(webassets, "_checkout_dir", lambda: checkout)

    assert webassets.dist_dir() == packaged
    assert webassets.index_html() == packaged / "index.html"


def test_checkout_bundle_is_used_when_the_package_dir_is_empty(tmp_path, monkeypatch):
    packaged = tmp_path / "installed" / "web" / "dist"
    packaged.mkdir(parents=True)
    (packaged / "assets").mkdir()
    checkout = _bundle(tmp_path / "checkout", "checkout")
    monkeypatch.setattr(webassets, "_packaged_dir", lambda: packaged)
    monkeypatch.setattr(webassets, "_checkout_dir", lambda: checkout)

    assert webassets.dist_dir() == checkout


def test_absent_packaged_dir_never_wins(tmp_path, monkeypatch):
    checkout = _bundle(tmp_path / "checkout", "checkout")
    monkeypatch.setattr(webassets, "_packaged_dir", lambda: tmp_path / "nope")
    monkeypatch.setattr(webassets, "_checkout_dir", lambda: checkout)

    assert webassets.dist_dir() == checkout


def test_no_bundle_anywhere_reports_none(tmp_path, monkeypatch):
    monkeypatch.setattr(webassets, "_packaged_dir", lambda: tmp_path / "empty-web")
    monkeypatch.setattr(webassets, "_checkout_dir", lambda: tmp_path / "empty-checkout")

    assert webassets.dist_dir() is None
    assert webassets.index_html() is None


def test_returned_directory_holds_the_entry_point(tmp_path, monkeypatch):
    checkout = _bundle(tmp_path / "checkout", "checkout")
    monkeypatch.setattr(webassets, "_packaged_dir", lambda: None)
    monkeypatch.setattr(webassets, "_checkout_dir", lambda: checkout)

    directory = webassets.dist_dir()

    assert directory is not None
    assert directory.is_dir()
    assert (directory / "index.html").is_file()
    assert (directory / "assets" / "index-abc123.js").is_file()


def test_lookup_writes_nothing(tmp_path, monkeypatch):
    checkout = _bundle(tmp_path / "checkout", "checkout")
    empty = tmp_path / "installed" / "web" / "dist"
    empty.mkdir(parents=True)
    monkeypatch.setattr(webassets, "_packaged_dir", lambda: empty)
    monkeypatch.setattr(webassets, "_checkout_dir", lambda: checkout)
    before = _snapshot(tmp_path)

    webassets.dist_dir()
    webassets.index_html()

    assert _snapshot(tmp_path) == before


def test_the_checkout_lookup_points_at_the_repo_web_dist():
    assert webassets._checkout_dir() == REPO_ROOT / "web" / "dist"


def _build_target(name: str) -> dict:
    data = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return data["tool"]["hatch"]["build"]["targets"][name]


def _wheel_config() -> dict:
    return _build_target("wheel")


def test_wheel_config_maps_the_built_bundle_into_the_package():
    wheel = _wheel_config()

    assert CHECKOUT_BUNDLE in wheel["only-include"]
    # gitignored, so the VCS-ignore override has to name it as well.
    assert CHECKOUT_BUNDLE in wheel["artifacts"]
    assert wheel["sources"][CHECKOUT_BUNDLE] == PACKAGED_BUNDLE
    assert PACKAGED_BUNDLE == "adventure_call/web"


def test_wheel_config_survives_a_missing_bundle():
    """``force-include`` fails the whole build when ``web/dist`` is absent."""
    wheel = _wheel_config()

    assert "force-include" not in wheel
    assert "force-include" not in wheel.get("sources", {})


def test_packaged_lookup_lives_beside_the_module():
    """The runtime lookup and the wheel mapping name the same subdirectory."""
    packaged = webassets._packaged_dir()

    assert packaged is None or packaged.parent.name == webassets.PACKAGE
    assert packaged is None or packaged.name == webassets.PACKAGED_SUBDIR


def test_sdist_carries_the_bundle_so_a_wheel_built_from_it_does_too():
    """`uv build` builds the wheel from the sdist: the bundle must survive that."""
    assert CHECKOUT_BUNDLE in _build_target("sdist")["artifacts"]
