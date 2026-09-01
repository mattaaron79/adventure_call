---
id: tic-531b
title: 'Import graph: merge import lines into a junction system (elk mergeEdges +
  junction dots)'
status: open
type: feature
tier: high
domain: ui
epic: viz-modes-next
priority: 12
tags:
- imports
- elk
- junctions
- mode-params
assignee: null
depends_on: []
blocked_by: null
created: '2026-08-31T20:27:53'
updated: '2026-08-31T20:27:53'
closed: null
---

## Description
User request: in Import graph every line is currently separate; add a checkbox that merges them into a junction system, re-deriving the view when the value changes.

ELK already implements exactly this and it was confirmed against the ELK reference during planning: the layered option org.eclipse.elk.layered.mergeEdges (boolean, default false, applies to parents) makes all incoming edges to a node share one input port and all outgoing edges share one output port, so edges without explicit ports touch their nodes at unified points and overlap into shared trunks instead of fanning out. ELK then computes org.eclipse.elk.junctionPoints on each edge -- an OUTPUT property, not a user option, surfaced in the elkjs JSON result as edge.junctionPoints -- giving the points where junction symbols should be drawn. Do not hand-roll hyperedge geometry; use these two.

WORK
1. web/src/layout/elkTypes.ts: ElkLayoutOptions gains mergeEdges?: boolean. ElkGraphResult gains junctionPoints: ReadonlyMap<string, readonly {x,y}[]> (keyed by edge id).
2. web/src/layout/elkConvert.ts: toElkNode emits "elk.layered.mergeEdges": String(options.mergeEdges ?? false) alongside the existing layered options. fromElkResult collects each edges junctionPoints, offset by the accumulated ancestor origin exactly as the section start/bend/end points already are. elkjs ElkExtendedEdge does not declare junctionPoints -- narrow through a small local interface, not a bare any.
3. web/src/modes/types.ts: Positioned gains junctions?: readonly {x,y}[]; assemble() carries them onto the Scene. web/src/canvas/scene.ts: Scene gains junctions?, and cullScene filters them against the visible world rect like everything else.
4. web/src/canvas/Workspace.tsx: draw the junction dots as small non-listening Konva Circles in the existing edge layer (radius ~3 world px, THEME.edge). They are decoration, never hit targets.
5. web/src/modes/importGraph.ts: ImportGraphParams stops being Record<string, never> and becomes {mergeLines: boolean}, defaultParams {mergeLines: false}, with paramToggles [{key: "mergeLines", label: "Merge import lines"}]. ModePicker (web/src/ui/ModePicker.tsx) already renders a modes declared paramToggles as checkboxes generically, so there is NO new UI code. layout() passes {mergeEdges: params.mergeLines} through to layoutGraph.

THE CRUX -- do not skip. cacheKeyOf(spec) in importGraph.ts keys the single-slot elk layout cache on node ids and edge ids only. A param change alters no ids, so the toggle would hit the stale cache and appear to do nothing; the same trap will catch tic-ea9ds expanded containers, which change sizes without changing ids. Generalise it to cacheKeyOf(spec, sizes, params) -- fold in the measured sizes and the JSON-serialised params -- keeping it exported and unit-tested. The re-derive the user asked for then happens for free: a params change re-runs Apps renderMode useMemo, layout() misses the cache, kicks off elk, and notifyLayoutReady (web/src/modes/asyncLayout.ts) triggers the second, cache-hit render.

Verification: cd web && npm run test -- add tests in layout/elkConvert.test.ts (the option is emitted with both values; junction points are read and offset by the ancestor origin) and modes/importGraph.test.ts (the cache key varies with params and with sizes; the toggle is declared). npm run build. Then npm run dev, switch to Import graph, and toggle the checkbox: lines into a shared target should visibly collapse into common trunks with junction dots at the splits, and toggling back must restore the fan-out (proving the cache key change works).

## Notes
