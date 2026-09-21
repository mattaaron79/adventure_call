---
id: tic-cfca
title: 'Add ''vcall tests'': which test files might be affected by a change'
status: closed
type: feature
tier: medium
domain: cli
epic: query-cli
priority: 2
tags:
- cli
- query
- tests
- git
- agents
assignee: deepseek.v4flash.001
depends_on: []
blocked_by: null
created: '2026-09-20T23:45:20'
updated: '2026-09-21T01:12:13'
closed: '2026-09-21T01:12:13'
---

## Description
Goal: a new query command that answers 'which tests should I run for this change' as a short list, to stop every ticket from paying for the whole suite.

Requested by the user, verbatim intent: type 'vcall tests' on its own and get the full list of test files that might be affected; new (untracked) test files must show up too, because the agent writes tests before running this.

Surface:
  vcall tests [FILE...] [--since REV] [--git] [--depth N] [--budget N] [--plain]

Defaults (bare 'vcall tests'):
  - inputs come from git: working tree changes (staged + unstaged via 'git diff HEAD --name-only', plus untracked via 'git ls-files --others --exclude-standard'), which is what makes a freshly written test file appear.
  - --since REV adds committed changes on the branch ('git diff --name-only -M --diff-filter=ACMR REV...HEAD', merge-base three-dot) and still includes the working tree.
  - explicit FILE args replace the working-tree scan; --git adds the working tree on top of them.
  - outside a git repo with no FILE args: exit 1 with a clear message.

Mapping (reuses the existing relation, no new analysis):
  - non-test input -> closure over Workspace.importers_of, keep is_test_path hits (this is what impact FILE already does for one file).
  - test input -> scheduled at hop 0 and NOT expanded (so a changed test file cannot drag in every test that imports a shared helper). This is the honest reading of 'excluding test files' from the request.
  - path normalisation via Workspace.normalise_path (handles git paths relative to the repo toplevel even when the store root is a subdirectory); a ref that resolves to a symbol inside a file is accepted too.
  - unknown/deleted/excluded/non-Python inputs land in 'skipped' and warn; if no input maps to an analysed file at all, exit 2.
  - --depth 0 (default) = unbounded; --budget defaults to CLOSURE_BUDGET; 'truncated' must be surfaced, since a silently short list is what makes people stop trusting the command.

Output: {"tests":[...],"total":N} plus "skipped" and "truncated" when non-empty, and an empty tests array plus a note when there are no changed files; --plain prints one path per line for 'xargs pytest'.

Files: adventure_call/query.py (Workspace.tests_for), adventure_call/cli.py (git helper, cmd_tests, parser, _COMMANDS), adventure_call/agents_doc.py (guide row + recipe), tests/test_query.py, tests/test_cli.py.

Known limits to document: over-approximates through hub modules (--depth is the knob); misses tests that reach code only via subprocess or dynamic import; conftest.py is itself a test path by is_test_path, so running the list may include it, which pytest loads anyway.

## Notes
- 2026-09-20T23:50:06 deepseek.v4flash.001: Implemented per the ticket: Workspace.tests_for() in query.py; cmd_tests plus _git_paths/_git_changed in cli.py; parser entry, _COMMANDS, guide row (agents_doc.py) and a README line; 15 new tests. Suite: 343 passed. Bare 'vcall tests' on this repo yields tests/test_cli.py, tests/test_query.py, tests/test_writer.py (test_writer really does import adventure_call.cli) and root-relative skipped entries for README.md, .adventure-call/AGENTS.md and .arbite/in_progress/tic-cfca.md. Two findings from the smoke test: (1) the analysis walks through .claude/worktrees/*/ checkouts, so their test files showed up as importers of the changed modules - tests_for now drops any test inside a nested checkout (a .git entry in an ancestor directory), which is also why _git_changed keeps untracked files but not nested-repo contents; (2) a re-exported name ('from x import y' where y is imported, not defined, in x) yields no IMPORTS edge, so a test reaching a changed module only through a re-export can be missed - filed separately as a raw ticket.

- 2026-09-20T23:50:21 deepseek.v4flash.001: Ready for review. QA: '.venv/bin/python -m pytest -q' -> 343 passed. Integration test (this repo, store at .adventure-call/): bare 'vcall tests' prints compact JSON {"tests":[...]} for the uncommitted change set (staged + unstaged + untracked from git); '--since REV' adds the branch's committed changes (merge-base diff); explicit FILE args replace the git scan and '--git' adds it back; '--plain' prints one path per line for 'xargs -r pytest -q'; '--depth N' bounds import hops; exit 2 with 'no given file is in this analysis' when none of the given inputs resolves, exit 1 outside a git work tree with no FILE args, exit 3 unchanged when no store is found. A new (untracked) test file is returned as itself; a changed conftest.py selects every collected test under its directory; only test_*.py / *_test.py are listed, so an empty list means no collected test imports the change rather than that the change is safe. No existing command's output changes.

- 2026-09-20T23:50:21 deepseek.v4flash.001: Submitted for review: new 'tests' query command; 343 tests pass

- 2026-09-21T01:12:13 system: Accepted.
