"""Locate the built web bundle (``web/dist``) that the web UI is served from.

The bundle ships inside the wheel as ``adventure_call/web`` (the ``sources``
mapping in pyproject.toml), so an installed copy needs no Node, npm, checkout or
Vite; an editable install or a plain checkout is served from ``web/dist``.
When neither holds an ``index.html`` both lookups answer ``None``, so the caller
can say the bundle is missing instead of serving 404s for every asset.

Limits, because they matter to the caller (tic-c11c):

- the bundle is a snapshot of the frontend taken at build/install time, so a
  frontend change needs ``npm run build`` and, for a non-editable install, a
  reinstall;
- ``vite.config.ts`` enables sourcemaps, so the ``.map`` files ship too (they
  roughly double the bundle); kept deliberately for debuggable installs;
- asset names are content-hashed, so the bundle must be served as one unit --
  ``index.html`` and its assets always come from the same directory.
"""

from __future__ import annotations

from importlib import resources
from pathlib import Path

PACKAGE = "adventure_call"
#: Where the wheel mapping puts the bundle: ``web/dist`` -> ``adventure_call/web``.
PACKAGED_SUBDIR = "web"
#: The checkout layout, relative to the repository root.
CHECKOUT_SUBDIRS = ("web", "dist")
#: The bundle's entry point, and the marker that a directory holds a bundle.
INDEX_HTML = "index.html"


def _packaged_dir() -> Path | None:
    """``adventure_call/web`` beside the module, for a wheel install."""
    try:
        found = resources.files(PACKAGE) / PACKAGED_SUBDIR
    except (ModuleNotFoundError, TypeError):
        return None
    try:
        return Path(found)
    except TypeError:
        # A zip-imported package has no filesystem path to serve files from.
        return None


def _checkout_dir() -> Path | None:
    """``<repo>/web/dist`` -- what an editable install or a checkout has."""
    return Path(__file__).resolve().parent.parent.joinpath(*CHECKOUT_SUBDIRS)


def dist_dir() -> Path | None:
    """The directory holding the built bundle, or ``None`` when none is built."""
    for candidate in (_packaged_dir(), _checkout_dir()):
        if candidate is not None and (candidate / INDEX_HTML).is_file():
            return candidate
    return None


def index_html() -> Path | None:
    """The bundle's entry point, or ``None``; always inside :func:`dist_dir`."""
    directory = dist_dir()
    return None if directory is None else directory / INDEX_HTML
