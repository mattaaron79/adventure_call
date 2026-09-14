#!/usr/bin/env bash
# Install or update adventure-call as a global command (Linux, macOS).
#
# Installs this checkout with `uv tool` (or pipx if uv is missing), so
# `adventure-call` / `adventure_call` work from any directory. Re-running it
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

if command -v adventure-call >/dev/null 2>&1; then
  echo "==> $(adventure-call --version) at $(command -v adventure-call)"
else
  echo "warning: adventure-call is not on PATH yet." >&2
  echo "  run 'uv tool update-shell' (or 'pipx ensurepath') and open a new shell." >&2
fi
