---
id: tic-83ec
title: Generalize VizMode interface and serializable mode presets
status: closed
type: refactor
tier: high
domain: ui
epic: viz-workspace
priority: 6
tags:
- frontend
- mode
- architecture
assignee: zoo.glm-5.3-flash.001
depends_on:
- tic-1faf
blocked_by: null
created: '2026-08-30T11:54:33'
updated: '2026-08-30T17:34:15'
closed: '2026-08-30T17:34:15'
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
- 2026-08-30T17:34:07 zoo.glm-5.3-flash.001: Implemented. VizMode interface extracted from the working fs-tree (web/src/modes/types.ts): select/measure/layout/style phases over Derived, with renderMode assembling the flat Scene; app consumes only ModeOutput (scene, rects, symbolOf, expandable). fs-tree registered through the new registry (web/src/modes/registry.ts) with a showImports param proving the params path. Serializable presets { modeId, params, filters, expandState } saved/loaded by name from localStorage, validated on read, exportable as JSON (web/src/modes/presets.ts). ModePicker UI (web/src/ui/ModePicker.tsx) does switch mode, param toggles, save/load/delete preset, export JSON. Store gained setParams/setExpanded; ModeState persists params. Tests: presets, registry, fsTree-through-interface, store params/expand state; 129 tests + tsc/vite build green.
