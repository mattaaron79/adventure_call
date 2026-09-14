---
id: tic-1ba3
title: 'vcall refs NAME: syntactic occurrences (attributes, identifiers, string literals)
  attributed to enclosing symbols'
status: open
type: feature
tier: high
domain: io
epic: agent-cli
priority: 3
tags:
- query
- refs
- attributes
- strings
- vcall-feedback
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-14T14:21:55'
updated: '2026-09-14T14:21:55'
closed: null
---

## Description
Top agent wish (diku tic-dac8, tic-2e31, tic-98c8): 'who reads X.attr for a dataclass field?' and 'map string literals to the enclosing symbol'. Agents fell back to grep for room.npcs, npc_templates, world._npcs, _handlers._compiled, NpcRuntime._conversations, help strings and set_focus calls. READS/WRITES edges only exist where the resolver knows the receiver (self.x, module vars), and full type inference is out of scope.

Build the honest version: a structured grep.
- New query Workspace.refs(name, kinds=attr|name|string|all, match=exact|substring|regex, path=glob, limit) and CLI 'refs' (alias worth considering: 'uses').
- Implementation: at query time, parse the analysed files with tree-sitter (reuse CodebaseParser/languages; files come from the store's module list, read from disk so results are current) and collect: attribute nodes whose attribute identifier matches (with read/write/call context: assignment target, augmented assignment, call function position, else read), bare identifiers, and string literal contents. Attribute each hit to the innermost enclosing symbol by line range (Workspace.resolve's path:LINE logic already does this).
- Output compact, grouped by file to keep it small: {"name":..., "total":N, "hits": {"path": ["L88 w quests.QuestService.load", "L120 r quests.QuestService.run", ...]}} ; for strings include a trimmed snippet. Respect --limit with a _more count.
- If a hit's receiver expression is resolvable to a READS/WRITES edge already in the graph, mark it exact; otherwise it is name-based -- say so in the help text and AGENTS.md (name matches, not type-checked).
- Performance: measure on ../diku (115 files); if a full parse per query is > ~1s, cache per-file occurrence indexes in the store keyed by manifest mtime.

Acceptance: tests on the sample fixture (e.g. refs name --kind attr finds user.name reads in models/api with enclosing symbols; refs 'login' --kind string finds the route literal in Router.dispatch); CLI help + AGENTS.md table row + a recipe ('find consumers of a field: refs FIELD --kind attr').

## Notes
