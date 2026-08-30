---
id: tic-83ec
title: Generalize VizMode interface and serializable mode presets
status: open
type: refactor
tier: high
domain: ui
epic: viz-workspace
priority: 6
tags:
- frontend
- mode
- architecture
assignee: null
depends_on:
- tic-1faf
blocked_by: null
created: '2026-08-30T11:54:33'
updated: '2026-08-30T11:54:33'
closed: null
---

## Description
Extract the mode interface FROM the working fs-tree implementation rather than guessing it up front.

interface VizMode<P> {
  id: string; label: string; defaultParams: P;
  select(data: Derived, p: P): SceneSpec;           // which nodes/groups/edges exist
  measure(spec: SceneSpec, ui: UiState): SizeMap;   // intrinsic sizes
  layout(spec, sizes, p): Positioned;
  style(spec, p): StyleMap;
}

- Register fs-tree through the interface; nothing else in the app may reach past it into mode internals.
- A preset is { modeId, params, filters, expandState } -- serializable, saved/loaded by name from localStorage, exportable as JSON. This is the 'modes as saved presets instead of hand-coded' path, proven with one mode rather than over-built for hypothetical ones.
- ModePicker UI: switch mode, save preset, load preset, delete preset.

EXIT: fs-tree runs entirely through the interface; two saved presets (e.g. 'all files' vs 'src only, expanded') switch cleanly.

## Notes
