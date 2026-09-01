---
id: tic-d8a8
title: 'Mode 3: call flow -- the unfocused entry-point overview'
status: open
type: feature
tier: high
domain: ui
epic: call-flow
priority: 5
tags:
- mode
- call-flow
- elk
assignee: null
depends_on:
- tic-a8a6
- tic-22db
- tic-1ecc
blocked_by: null
created: '2026-09-01T07:24:08'
updated: '2026-09-01T07:24:08'
closed: null
---

## Description
The third VizMode, registered alongside fsTreeMode and importGraphMode. This ticket delivers its UNFOCUSED state; tic-7a5e adds the rooted local view.

Decided with the user 2026-09-01: the mode is rooted on a function by default, but a purely rooted mode has a discovery problem -- you can only use it if you already know which function to ask about. So `focusPath === ''` is the mode's index: the entry points from tic-22db laid out as the top layer of tic-a8a6's condensed DAG, one or two levels deep. That doubles as an architecture overview -- "here are the N ways execution enters this codebase, and what each one immediately reaches".

Nodes are callables (kind function|method), identified by the symbol_id the export already provides -- which is already the qualified `module.class.function` path, so identity and lexical distance come for free with no new data. Classes stay containers, not nodes. A cyclic component from tic-a8a6 draws as ONE node badged with its size; a self-recursive function draws as itself with a recursion badge. That is what makes the picture 2D at all.

Two synthetic node kinds beyond the callables, both deliberate: external sinks (aggregate one node per external module -- "this reaches out to json / subprocess" is flow worth seeing, and today it is thrown away into unresolved_calls), and dynamic holes (a computed callee is NOT a node; it is a badge on the caller saying flow leaves the map here -- 902 of them in ../carnot, and drawing an honest hole beats drawing nothing).

Follow importGraph's async layout path: the graph is not a tree, so layout goes through elk layered in a worker via layoutGraph, reconciled with the synchronous VizMode.layout signature by modes/asyncLayout.ts. Reuse fileDetail.ts for expanded containers rather than reimplementing rows.

Do NOT attempt the whole 2500-node call graph at once -- it is a hairball and elk will not save it. If the entry-point overview at depth 2 is still too big on ../carnot, cap it and say so in the UI; record the actual node counts in the notes.

Verification: browser-verify against ../carnot -- entry points visible and labelled by role, a real recursive cluster rendering as a single badged node, external sinks distinguishable. npm run test, tsc -b, production build.

## Notes
