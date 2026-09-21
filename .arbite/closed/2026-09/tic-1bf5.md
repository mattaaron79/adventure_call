---
id: tic-1bf5
title: 'install.sh: detect the snap environment from XDG paths, not just $SNAP'
status: closed
type: bug
tier: medium
domain: cli
epic: packaging
priority: 1
tags:
- install
- uv
- snap
- packaging
assignee: deepseek.v4flash.001
depends_on: []
blocked_by: null
created: '2026-09-21T00:04:13'
updated: '2026-09-21T01:12:09'
closed: '2026-09-21T01:12:09'
---

## Description
Symptom: after running scripts/update.sh from the snap VS Code terminal, 'vcall' works inside this project (the .venv copy is first on PATH) and everywhere else reports 'bash: /home/matt/snap/code/261/.local/share/../bin/vcall: No such file or directory'.

Diagnosis, from the live machine:
- The install landed in the snap revision dir: tool venv at /home/matt/snap/code/264/.local/share/uv/tools/adventure-call (created 23:59 tonight) with shims at /home/matt/snap/code/264/.local/bin/{vcall,adventure-call} pointing at it. SNAP=/snap/code/264 and XDG_DATA_HOME=/home/matt/snap/code/264/.local/share in that terminal.
- install.sh pins the real home only when SNAP is set. In the terminal that ran it SNAP was evidently unset while XDG_DATA_HOME was still snap-scoped, so the pinning branch was skipped and uv installed under the revision dir, which is exactly the ephemeral location the branch exists to avoid.
- The terminal's PATH names the OLD revision (/home/matt/snap/code/261/.local/share/../bin) followed by /home/matt/.local/bin, so the new install is invisible; the 261 shims were also removed by that install, which is what broke the command, and the shell has it cached.
- /home/matt/.local/bin/vcall still points at a 14 Sep build whose cli.py has no subcommands at all ('vcall tests' there prints 'no such path: tests').

Fix in scripts/install.sh:
1. Treat the environment as snap-like when SNAP is set OR any of XDG_DATA_HOME/XDG_CONFIG_HOME/HOME contains '/snap/' (SNAP is not reliably exported in a terminal that inherited the snap's XDG dirs).
2. Harden real_home: if the passwd lookup itself returns a snap-scoped home, fall back to ${HOME%%/snap/*}.
3. After installing, when the copy found on PATH is not the one just installed, say so, name it, and hint at 'hash -r' / a new shell instead of only warning when nothing is found.

Verification: run the pinning logic with 'env -u SNAP XDG_DATA_HOME=<snap-scoped share dir>' and check UV_TOOL_BIN_DIR resolves to /home/matt/.local/bin; then run scripts/install.sh for real and confirm 'vcall tests -h' works from /tmp and 'vcall tests' works in a project with a store.

## Notes
- 2026-09-21T00:05:05 deepseek.v4flash.001: Fixed and verified. scripts/install.sh now treats the environment as snap-like when SNAP is set OR any of XDG_DATA_HOME/XDG_CONFIG_HOME/HOME contains '/snap/' (the case that broke it: XDG_DATA_HOME was snap-scoped while SNAP was unset, so the pinning branch was skipped and uv installed under /home/matt/snap/code/264/), strips a snap-scoped home from the passwd answer as a fallback, and after installing warns when the copy reached through PATH is not the one just installed, naming it and suggesting 'hash -r'. Verified with a fake uv on PATH: 'env -u SNAP XDG_DATA_HOME=/home/matt/snap/code/264/.local/share bash scripts/install.sh' now reports 'snap environment detected (XDG_DATA_HOME=...); installing under /home/matt/.local' and exports UV_TOOL_BIN_DIR=/home/matt/.local/bin, while an ordinary environment leaves uv's defaults alone. Then ran the real install: 'uv tool install --force --reinstall' rebuilt /home/matt/.local/share/uv/tools/adventure-call, and from /tmp in a fresh shell 'command -v vcall' -> /home/matt/.local/bin/vcall, 'vcall --version' -> adventure-call 0.1.0, 'vcall tests -h' shows the new command, and from the project 'vcall tests --since HEAD~1' returns tests/test_cli.py, tests/test_query.py, tests/test_writer.py. README Deploy gained a paragraph on the snap case. QA note for the user: shells already open keep the dead path in their hash table, so 'hash -r' (or a new terminal) is still needed there; the leftover /home/matt/snap/code/{261,264}/.local installs are now harmless duplicates and can be deleted.

- 2026-09-21T00:05:09 deepseek.v4flash.001: Submitted for review: install.sh snap detection fixed; real install rebuilt under ~/.local and verified from /tmp

- 2026-09-21T01:12:09 system: Accepted.
