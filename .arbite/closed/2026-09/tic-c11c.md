---
id: tic-c11c
title: 'vcall serve: build the web bundle into the wheel so serving needs no Node'
status: closed
type: chore
tier: medium
domain: io
epic: vcall-serve
priority: 1
tags:
- packaging
- wheel
- web
- vite
- serve
- build
assignee: deepseek.v4flash.003
depends_on: []
blocked_by: null
created: '2026-09-21T21:00:00'
updated: '2026-09-21T21:11:52'
closed: '2026-09-21T21:11:52'
---

## Description
Goal: ship the built frontend inside the installed package, so 'vcall serve' (tic next) works on a machine with no Node, no npm, no checkout and no Vite.

Decision already taken with the user: option A -- a prebuilt bundle -- not the Vite dev server. No runtime Node dependency may be introduced here; a developer-facing '--dev' path is a separate ticket.

Current state, why this is needed:
- web/ builds with 'npm run build' (tsc -b && vite build, web/package.json:8) into web/dist, which is gitignored (.gitignore:24) and absent from the wheel: hatchling ships only the adventure_call package (pyproject.toml:26-27).
- Everything the app fetches is already produced by the store, so only the assets are missing: see the next ticket.

Pieces:
1. New adventure_call/webassets.py: 'dist_dir() -> Path | None' and 'index_html() -> Path | None'. Resolution order, first entry holding an index.html wins:
   a. the packaged directory beside the module (adventure_call/web/), for a uv/pip tool install;
   b. <repo>/web/dist, i.e. Path(__file__).parent.parent / 'web' / 'dist', which is what an editable install (scripts/install.sh --editable maps adventure_call onto the checkout) and a contributor who just ran npm run build both have;
   c. otherwise None -- the caller then prints an actionable error instead of serving 404s for every asset.
2. Packaging: get the built bundle into the distribution. Either copy web/dist -> adventure_call/web/ as a build step (hatchling's packages = ["adventure_call"] then picks it up, and an editable install sees it too -- which makes the resolution order above mostly belt-and-braces) or use [tool.hatch.build.targets.wheel.force-include] with '"web/dist" = "adventure_call/web"'. Whichever is chosen must be verified to put adventure_call/web/index.html plus the hashed assets in the wheel and to keep importlib.resources working; keep generated assets out of git (a .gitignore entry for adventure_call/web/ if copying).
3. Build step in the installers: scripts/install.sh and scripts/install.ps1 (and update.sh/update.ps1) run 'npm ci && npm run build' in web/ when npm is on PATH. When npm is missing, warn clearly (the bundle is what 'vcall serve' needs) and let the install succeed rather than fail. Add --no-web to skip, and skip the rebuild when web/dist is newer than the newest file under web/src so a re-run of install.sh stays quick. Keep the shell and PowerShell pairs in step.
4. Docs: the README Deploy section (README.md:24-42) says what Node is for at install time and what a Node-less install still gets.

Tests:
- tests/test_webassets.py: resolution order against tmp dirs (packaged wins over checkout, checkout used when the package dir is empty, None when neither has index.html), that the returned path is a directory, and that nothing is written.
- Packaging: assert the hatch configuration carries the mapping, plus a documented manual check ('uv build && unzip -l dist/*.whl | grep web/index.html'), since a full wheel build in the pytest suite needs hatch and npm and should not gate the suite.

Known limits to record in code comments: the bundle is a snapshot of the frontend at install time, so a frontend change needs a reinstall (or a plain 'npm run build' for an editable install); vite.config.ts:16 emits sourcemaps, so decide whether the .map files ship (they roughly double the bundle -- keeping them is fine, but say so); the bundle must be served as one unit because asset names are hashed.

Observable via integration testing: on a machine with Node, 'scripts/install.sh' builds the bundle and 'python -c "from adventure_call import webassets; print(webassets.dist_dir())"' prints a directory holding index.html; 'uv build' followed by listing the wheel shows adventure_call/web/index.html and its assets, so the install is self-contained; on a machine without Node the install still succeeds and prints the warning instead of failing.

## Notes
- 2026-09-21T21:00:41 deepseek.v4flash.002: Enabler for tic-c336 (vcall serve): the serve command needs a bundle it can read from the installed distribution. See tic-c336 for the HTTP contract the bundle is served under.

- 2026-09-21T21:06:21 deepseek.v4flash.003: Starting tic-c11c (attempt att-9771). Plan: (1) adventure_call/webassets.py with dist_dir()/index_html() resolving packaged adventure_call/web -> checkout web/dist -> None, with monkeypatchable private helpers as the test seam; (2) shipping the bundle via hatchling force-include web/dist -> adventure_call/web (no copy step, nothing generated in git, and I will verify hatchling tolerates/needs the source path before relying on it); (3) npm build step + --no-web + mtime skip + Node-less warning in install.sh/install.ps1 (update.sh/update.ps1 pass through); (4) tests/test_webassets.py incl. the hatch mapping assertion and the documented manual wheel check; (5) README Deploy section. No serve/HTTP code -- that is tic-c336.

- 2026-09-21T21:11:51 deepseek.v4flash.003: Tests pass: '.venv/bin/python -m pytest -q' -> 354 passed (11 new in tests/test_webassets.py). Evidence for the two acceptance points: (1) 'uv build' wheel now carries the bundle -- 'python -m zipfile -l dist/*.whl | grep web/' shows adventure_call/web/index.html plus the 5 hashed assets (index-Cs_BBo8W.js/.map, index-wzdbkj82.css, elk-worker.min-BENGc9gn.js/.map); a real 'uv tool install' into a sandbox tool dir put them in site-packages, and a wheel built with web/dist absent still builds (0 web entries). (2) '.venv/bin/python -c "from adventure_call import webassets; print(webassets.dist_dir())"' -> /media/matt/m2tb/projects/adventure_call/web/dist; the same call from the installed copy (cwd outside the checkout) -> site-packages/adventure_call/web, both holding index.html; from an --editable install -> <repo>/web/dist. Installer paths exercised with a sandboxed UV_TOOL_DIR: --no-web skips the step, an up-to-date web/dist skips the rebuild, touching web/src/main.tsx triggers 'npm run build' (vite built in 7.18s), and with npm off PATH the install still succeeds (exit 0) after printing the warning. Packaging deviation: force-include errors on a missing source, so the bundle is mapped with only-include + sources + artifacts (artifacts is required because web/dist is gitignored), and the sdist carries web/dist too so a wheel built from it by plain 'uv build' keeps the bundle.

- 2026-09-21T21:11:51 deepseek.v4flash.003: Integration testing after this lands: (a) run 'scripts/install.sh' on a machine with Node -- it prints '==> npm run build (...)' (or the up-to-date line on a re-run) and the installed command afterwards has a real web bundle: 'python -c "from adventure_call import webassets; print(webassets.dist_dir())"' answers a directory containing index.html, including from a shell whose cwd is nowhere near the checkout; (b) 'uv build && python -m zipfile -l dist/*.whl | grep web/' lists adventure_call/web/index.html and its hashed assets, so the distribution is self-contained; (c) 'scripts/install.sh --no-web' and a run with npm off PATH both still exit 0, the latter after printing the 'npm not found' warning, and the CLI keeps working with no bundle (webassets.dist_dir() answers None, which is what the serve ticket turns into an actionable error). Update.ps1/update.sh accept the same --no-web/-NoWeb passthrough. Nothing in this change serves HTTP or adds a CLI subcommand -- that remains tic-c336.

- 2026-09-21T21:11:52 system: Submitted; closed (review disabled).
