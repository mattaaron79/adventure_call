---
id: tic-cdeb
title: Headless variable-size tidy tree layout engine + elbow connectors + group shapes
status: closed
type: feature
tier: high
domain: ui
epic: viz-workspace
priority: 4
tags:
- frontend
- layout
- algorithm
assignee: zoo.glm
depends_on:
- tic-3399
blocked_by: null
created: '2026-08-30T11:54:08'
updated: '2026-08-30T14:03:57'
closed: '2026-08-30T14:03:57'
---

## Description
Layout is a pure function, fully separated from rendering, so it stays testable and swappable (elkjs later).

- src/layout/tidyTree.ts: layoutTree(root, sizeOf, opts) -> Map<id, Rect>. Variable-size tidy tree: children stacked along one axis, parent centered against its child block, tier offset along the other. Must handle the wildly different heights of collapsed chips vs expanded file containers -- this is why d3-hierarchy's uniform-node tree() is not enough.
- Elbow / orthogonal connector routing for nesting lines (parent dir -> child).
- Optional rounded translucent rect behind each directory subtree: the first grouping-shape primitive.
- No canvas or React imports in this module. Deterministic: same input, same output.
- Vitest golden-file tests over a synthetic tree; assert zero overlap across a mix of node sizes.

EXIT: golden tests pass; no overlap at any mix of node sizes.

## Notes
- 2026-08-30T14:03:52 zoo.glm: Layout engine landed in web/src/layout/tidyTree.ts. layoutTree(root, sizeOf, opts) -> Map<id, Rect>: variable-size tidy tree, children stacked along one axis, parent centred against its child block, per-depth tier bands sized by the largest node at that depth, so collapsed chips and expanded containers coexist. elbowConnectors(root, rects, opts): orthogonal parent-to-child polylines, degenerating to a straight 2-point line when aligned. subtreeGroups(root, rects, opts): padded bounding box per branching subtree in pre-order so translucent groups paint outer before inner. No canvas or React imports; deterministic; duplicate ids throw. Orientations lr (default) and tb; optional childrenOf accessor for trees that do not keep children under a children property. Tests: 16 in tidyTree.test.ts -- hand-computed golden rects for lr and tb, golden elbow polylines, group boxes, degenerate elbow, duplicate-id error, custom gaps, childrenOf, a committed snapshot golden file over a deeper synthetic fs tree, and zero-overlap property tests over 200 seeded random trees per orientation plus the pathological wide-parent tall-container tree. Full suite 103/103 green; tsc -b and vite build clean. ENVIRONMENT DEVIATION: default vitest threads/forks pools are broken here (every suite incl. pre-existing died at first describe with Cannot read properties of undefined reading config -- worker state never provided); vite.config.ts now sets test.pool=vmThreads, the only pool that runs, with a comment to revisit on vitest upgrade. No net dependency changes (vite briefly 6.4.2 for diagnosis, restored to 6.4.3).
