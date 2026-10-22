---
id: tic-ed55
title: '--ephemeral: keep the store in a temp dir instead of the project'
status: closed
type: feature
tier: medium
domain: cli
epic: null
priority: 2
tags: []
assignee: claude.opus-5.001
depends_on:
- tic-543c
blocked_by: null
created: '2026-10-22T11:43:24'
updated: '2026-10-22T11:47:33'
closed: '2026-10-22T11:47:33'
---

## Description
Let a project be analysed and queried without creating PROJECT/.vcall/. With --ephemeral (init/update/queries/serve), the store lives under a per-user temp cache ($XDG_RUNTIME_DIR, else the system temp dir) keyed by the project root's absolute path, so repeat queries reuse the cached analysis and staleness check, but nothing survives a reboot and the project tree is never written. Store must therefore record its project root rather than deriving it from path.parent.

## Notes
- 2026-10-22T11:47:33 claude.opus-5.001: Store(path, root=None): root is explicit, else config.json's 'root', else path.parent. Store.for_ephemeral(root) -> tempfile.gettempdir()/vcall-<user>/<rootname>-<sha256(root)[:12]>, base dir mode 0700 (the registry embeds source); Store.find_ephemeral() walks up from the cwd like find(). CLI: --ephemeral on every query, init, update and serve; queries/update/serve analyse on first use with default options (cli._ephemeral_store), default root = git work tree else cwd as for init; --store + --ephemeral is an error (exit 3 for queries). Missing-store hint now mentions --ephemeral. README, top-level help and AGENTS.md template updated. 5 new tests in tests/test_cli.py; pytest 416 passed. Live: 'serve proj --ephemeral --no-open' analysed into the temp store, /data/meta.json answered the real project root, codebase_graph.json 200, SIGTERM -> 'stopped', port freed. Design choice: system temp dir (respects TMPDIR) rather than XDG_RUNTIME_DIR, so it is cross-platform and survives logout; on Fedora/most Linux /tmp is tmpfs so it is gone at reboot, on macOS TMPDIR is cleaned by the OS after a few days idle.

- 2026-10-22T11:47:33 claude.opus-5.001: Observable via integration testing: in any project with no .vcall/, 'vcall overview --ephemeral' prints 'adventure-call: analysing <root> into $TMPDIR/vcall-$USER/<name>-<hash>...' on stderr and then the usual JSON; the project tree gains no files. Re-running any query with --ephemeral (from the root or a subdirectory) is instant and silent; editing a source makes the next one print 're-analysing...'. 'vcall init --ephemeral' / 'update --ephemeral' print a summary with 'store' and 'root'; 'vcall serve --ephemeral' serves that store. Without --ephemeral the error for a missing store now suggests it. After a reboot (tmpfs /tmp) the first --ephemeral query analyses again.

- 2026-10-22T11:47:33 system: Submitted; closed (review disabled).
