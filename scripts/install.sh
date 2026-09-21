#!/usr/bin/env bash
# Install or update adventure-call as a global command (Linux, macOS).
#
# Installs this checkout with `uv tool` (or pipx if uv is missing), so
# `adventure-call` (alias `vcall`) works from any directory. Re-running it
# is how you update: it reinstalls from the checkout's current state.
#
#   scripts/install.sh              install/update from this checkout
#   scripts/install.sh --pull       git pull first (scripts/update.sh does this)
#   scripts/install.sh --editable   live install: checkout edits apply immediately
#   scripts/install.sh --js         include the optional JavaScript/TypeScript grammars
#   scripts/install.sh --python 3.12
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
editable=0
pull=0
extras=""
python=""

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print } /^set /{ exit }' "${BASH_SOURCE[0]}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -e|--editable) editable=1 ;;
    --pull) pull=1 ;;
    --js) extras="[js]" ;;
    --python) shift; python="${1:?--python needs a version}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ "$pull" = 1 ]; then
  echo "==> git pull ($repo)"
  git -C "$repo" pull --ff-only
fi

# A snap-packaged terminal (e.g. VS Code installed as a snap) points
# XDG_DATA_HOME at ~/snap/<app>/<revision>/, and uv/pipx would install there:
# off the normal shell's PATH, and gone when the snap refreshes. Pin the
# standard locations under the real home unless the caller chose their own.
# SNAP itself is not reliably exported to a terminal that inherited the snap's
# XDG directories, so the paths are checked as well.
snap_env=0
for candidate in "${SNAP:-}" "${XDG_DATA_HOME:-}" "${XDG_CONFIG_HOME:-}" "${HOME:-}"; do
  case "$candidate" in *"/snap/"*) snap_env=1 ;; esac
done
if [ "$snap_env" = 1 ]; then
  real_home="$(getent passwd "$(id -un)" | cut -d: -f6)"
  real_home="${real_home:-$HOME}"
  # The account lookup can itself answer with a snap-scoped home; unpick it.
  case "$real_home" in *"/snap/"*) real_home="${HOME%%/snap/*}" ;; esac
  export UV_TOOL_DIR="${UV_TOOL_DIR:-$real_home/.local/share/uv/tools}"
  export UV_TOOL_BIN_DIR="${UV_TOOL_BIN_DIR:-$real_home/.local/bin}"
  export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$real_home/.local/share/uv/python}"
  export UV_PYTHON_BIN_DIR="${UV_PYTHON_BIN_DIR:-$real_home/.local/bin}"
  export PIPX_HOME="${PIPX_HOME:-$real_home/.local/share/pipx}"
  export PIPX_BIN_DIR="${PIPX_BIN_DIR:-$real_home/.local/bin}"
  echo "==> snap environment detected (${SNAP:-XDG_DATA_HOME=$XDG_DATA_HOME}); installing under $real_home/.local"
fi

spec="$repo$extras"
if command -v uv >/dev/null 2>&1; then
  args=(tool install --force --reinstall)
  [ "$editable" = 1 ] && args+=(--editable)
  [ -n "$python" ] && args+=(--python "$python")
  echo "==> uv ${args[*]} $spec"
  uv "${args[@]}" "$spec"
elif command -v pipx >/dev/null 2>&1; then
  args=(install --force)
  [ "$editable" = 1 ] && args+=(--editable)
  [ -n "$python" ] && args+=(--python "python$python")
  echo "==> pipx ${args[*]} $spec"
  pipx "${args[@]}" "$spec"
else
  echo "error: neither uv nor pipx found. Install uv first:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

installed="$(command -v adventure-call || true)"
if [ -z "$installed" ]; then
  echo "warning: adventure-call is not on PATH yet." >&2
  echo "  run 'uv tool update-shell' (or 'pipx ensurepath') and open a new shell." >&2
else
  echo "==> $(adventure-call --version) at $installed"
  # A stale shim in another bin directory (an older install in a snap revision
  # dir, say) can sit earlier on PATH and silently hide this one.
  if [ -n "${UV_TOOL_BIN_DIR:-}" ] && [ -z "${VIRTUAL_ENV:-}" ] \
     && [ "$installed" != "$UV_TOOL_BIN_DIR/adventure-call" ]; then
    echo "warning: PATH reaches $installed, not the copy just installed" >&2
    echo "  ($UV_TOOL_BIN_DIR/adventure-call): something earlier on PATH is shadowing it." >&2
    echo "  Remove that copy, or put $UV_TOOL_BIN_DIR earlier on PATH; in a shell that" >&2
    echo "  already ran it, 'hash -r' also clears a cached path that has gone away." >&2
  fi
fi
