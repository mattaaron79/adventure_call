---
id: tic-970c
title: 'Resolver: unique-name fallback turns x.get()/strip() etc. into bogus project
  calls'
status: open
type: bug
tier: high
domain: io
epic: agent-cli
priority: 1
tags:
- resolver
- heuristic
- vcall-feedback
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-14T14:21:55'
updated: '2026-09-14T14:21:55'
closed: null
---

## Description
Agent feedback (diku, 2026-09-14, tic-6949 there): 'vcall symbol all_wizards_from_env' listed a spurious callee expedition.backdrop.get from a str().strip().casefold() chain. Verified: 'vcall symbol expedition.backdrop.get' in ../diku shows fan_in 75, nearly all heuristic ('?'), i.e. unresolved receiver.get(...) calls (mostly dict.get) matched by SymbolResolver._fallback_by_name (adventure_call/resolver.py ~L938) because backdrop.get is the only project symbol named 'get'. The pollution spreads: it tops overview.most_called, inflates reach_up/impact, and pushes effects onto every caller.

Fix in the resolver, not the query layer:
- An ATTRIBUTE call (it has a receiver: _fallback_by_name(..., receiver=root)) must not heuristic-resolve to a module-level function; x.get() can only plausibly be a method (or a nested class attribute), never pkg.mod.get, which would resolve exactly through the module binding if it were that.
- Skip the fallback entirely for names that are methods of builtin types (dict/list/set/str/bytes/tuple, plus common io/object protocol names): get, items, keys, values, pop, update, setdefault, append, extend, insert, remove, clear, copy, add, discard, strip, split, join, replace, format, startswith, endswith, lower, upper, casefold, encode, decode, read, write, close, ... Derive the list from dir() of those builtins at import time rather than hand-maintaining it. Record these as unresolved with a reason like "builtin method name 'get'".

Acceptance:
- Unit tests in tests/test_resolver.py: a project with a single module-level def get() plus d.get('k') / s.strip() calls produces no CALLS edge to get; a unique method name still heuristic-resolves when not a builtin method name.
- Re-run on ../diku (copy or store) and report backdrop.get fan_in before/after and calls_heuristic before/after in the ticket note.
- Bump writer SCHEMA_VERSION only if the export shape changes (it should not).

## Notes
