---
id: tic-23eb
title: Style call-flow edges by their control-flow tags
status: open
type: feature
tier: low
domain: ui
epic: call-flow
priority: 8
tags:
- call-flow
- style
- canvas
assignee: null
depends_on:
- tic-7a5e
- tic-5069
blocked_by: null
created: '2026-09-01T07:25:20'
updated: '2026-09-01T07:26:53'
closed: null
---

## Description
Render tic-5069's edge vocabulary in the call-flow mode's style() phase. Pure presentation -- no new data, no new derivation.

Starting proposal, to be adjusted once tic-5069 reports the real tag distribution: solid for unguarded, dashed for guarded, a heavier stroke for looped, the warm THEME.cycle colour (added in tic-56b2, the one warm colour in the palette) for error-path, ghosted/low-opacity for heuristic confidence, and type-checking-only edges hidden by default behind a param.

Restraint is the point. Five simultaneous visual channels on one line is not a legend, it is noise, and the mode already spends channels on cycles and confidence. If the tag distribution turns out lopsided, style the two or three tags that actually discriminate and leave the rest to the inspector. Argue the choice in the notes rather than encoding every tag because it exists.

Everything goes through style(), which already receives SpecEdge.data -- the canvas needs no changes, as tic-56b2 established when it did the same thing for cycles.

Verification: unit tests asserting each tag maps to its intended treatment and that edge.kind is untouched; browser-verify legibility against ../carnot at two zoom levels, both themes if applicable. npm run test, tsc -b.

## Notes
