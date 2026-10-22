---
id: tic-ca91
title: Export any web view as a Mermaid diagram
status: closed
type: feature
tier: high
domain: ui
epic: null
priority: 3
tags: []
assignee: claude.opus-5.001
depends_on: []
blocked_by: null
created: '2026-10-22T11:43:24'
updated: '2026-10-22T11:52:58'
closed: '2026-10-22T11:52:58'
---

## Description
Every mode produces a generic SceneSpec (nested SpecNodes, groups, edges). Add a pure SceneSpec -> Mermaid flowchart converter (nesting -> subgraph, directional edges -> arrows, edge kinds -> linkStyle/classDef) and an 'Export Mermaid' action in the UI that copies/downloads the current view's diagram (respecting focus, excludes and expand state). Assess Mermaid's expressiveness per mode in the ticket notes.

## Notes
- 2026-10-22T11:52:52 claude.opus-5.001: Expressiveness assessment: Mermaid's flowchart is enough to carry the STRUCTURE and FLOW of every current view, not its geometry. Per mode -- call-flow: a flat directed graph (chips + call/state/type/external edges), maps 1:1, edge colours and dashes kept via linkStyle. import-graph: files with import arrows, opened files become subgraphs holding their rows, Local View exports the neighbourhood; 1:1. fs-tree: dirs/files joined by nesting edges (undirected '---'), opened files as subgraphs, stub chips as small circles; the translucent group boxes are dropped (redundant with the nesting edges). sunburst: no edges at all -- the hierarchy becomes nested subgraphs (containment), which loses the angular size encoding; Mermaid's treemap-beta would carry size but is beta and not rendered by GitHub et al., so not used. Not carried anywhere: positions/drags, fills (canvas palette is dark-only, fills would bury Mermaid's text), sizes. Practical limit: Mermaid's default maxEdges 500 / maxTextSize 50k are in its 'secure' config, so a diagram can't raise them via %%{init}%%; the export reports node/edge counts and warns when over. On this repo: default views 3.8k-12k chars (fine), everything-expanded fs-tree/import-graph ~195k chars (over -> warned).

- 2026-10-22T11:52:52 claude.opus-5.001: Implementation: web/src/modes/mermaid.ts -- sceneToMermaid(spec, {direction, styles, title}) is pure over SceneSpec (children joined to their parent by an edge are sibling nodes, other children are contained -> subgraph; bare 'root' skipped; ids remapped to n0..; labels entity-escaped; empty root label -> '/'; hex strokes only); exportModeMermaid(mode, data, params, ui) runs select+style at lod 0, direction from params.orientation. ModePicker gains an Export section (Copy Mermaid / Download .mmd + a count/limit note); Sidebar passes workspace. Tests: mermaid.test.ts (unit + a sweep over every registered mode), ModePicker.test.ts. vitest 1049 passed, tsc -b clean, vite build rebuilt web/dist. Validated with the real parser: exports of all 4 modes from this repo's own graph (default, all-expanded with state/type/externals on, fs-tree focused, import Local View, call-flow rooted) -- 11 diagrams -- all mermaid.parse() OK as flowchart-v2 under mermaid 11.4.1 + jsdom. Not exercised: an actual click in a browser (clipboard permission path) -- no browser available in this session.

- 2026-10-22T11:52:53 claude.opus-5.001: Observable via integration testing: 'vcall serve' (bundle rebuilt) shows a new 'Export' heading in the sidebar between the mode controls and Presets, with 'Copy Mermaid' and 'Download .mmd' (disabled until data loads). Copy puts a 'flowchart LR|TB' document on the clipboard and shows 'Copied N nodes, M edges.'; Download saves <mode-id>.mmd. Pasting into mermaid.live / a GitHub markdown fence renders the current view: what is focused, expanded and toggled (import lines, state/type/external overlays) is what is exported, regardless of zoom. Large views show a warning that they exceed Mermaid's 500-edge / 50k-char defaults. If the browser refuses clipboard access, the note says to use Download.

- 2026-10-22T11:52:58 system: Submitted; closed (review disabled).
