---
id: tic-cdeb
title: Headless variable-size tidy tree layout engine + elbow connectors + group shapes
status: open
type: feature
tier: high
domain: ui
epic: viz-workspace
priority: 4
tags:
- frontend
- layout
- algorithm
assignee: null
depends_on:
- tic-3399
blocked_by: null
created: '2026-08-30T11:54:08'
updated: '2026-08-30T11:54:08'
closed: null
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
