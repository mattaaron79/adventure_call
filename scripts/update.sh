#!/usr/bin/env bash
# Update adventure-call: git pull this checkout, then reinstall the global command.
# Accepts the same options as install.sh (--editable, --js, --python X).
set -euo pipefail
exec "$(dirname "${BASH_SOURCE[0]}")/install.sh" --pull "$@"
