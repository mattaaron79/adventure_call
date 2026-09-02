---
id: tic-23eb
title: Style call-flow edges by their control-flow tags
status: closed
type: feature
tier: low
domain: ui
epic: call-flow
priority: 8
tags:
- call-flow
- style
- canvas
assignee: z-ai.glm-5.3-flash.001
depends_on:
- tic-7a5e
- tic-5069
blocked_by: null
created: '2026-09-01T07:25:20'
updated: '2026-09-01T18:15:16'
closed: '2026-09-01T18:15:16'
---

## Description
Render tic-5069's edge vocabulary in the call-flow mode's style() phase. Pure presentation -- no new data, no new derivation.

Starting proposal, to be adjusted once tic-5069 reports the real tag distribution: solid for unguarded, dashed for guarded, a heavier stroke for looped, the warm THEME.cycle colour (added in tic-56b2, the one warm colour in the palette) for error-path, ghosted/low-opacity for heuristic confidence, and type-checking-only edges hidden by default behind a param.

Restraint is the point. Five simultaneous visual channels on one line is not a legend, it is noise, and the mode already spends channels on cycles and confidence. If the tag distribution turns out lopsided, style the two or three tags that actually discriminate and leave the rest to the inspector. Argue the choice in the notes rather than encoding every tag because it exists.

Everything goes through style(), which already receives SpecEdge.data -- the canvas needs no changes, as tic-56b2 established when it did the same thing for cycles.

Verification: unit tests asserting each tag maps to its intended treatment and that edge.kind is untouched; browser-verify legibility against ../carnot at two zoom levels, both themes if applicable. npm run test, tsc -b.

## Notes
- 2026-09-01T17:20:38 claude.opus.001: Distribution measured in tic-5069, so the visual budget can be spent on what actually appears:

                        carnot (3505 edges)   hypermenu (613 edges)
  unguarded                 77.9%                 74.2%
  guarded                   19.8%                 24.3%
  mixed                      2.2%                  1.5%
  looped                     8.6%                  9.3%
  error-path                 1.3%                  0.3%
  type-checking-only         0.0%                  0.0%

Draw 'guarded' and 'looped'; those are the two a reader will actually meet.
'mixed' is worth a distinct treatment only if it is cheap -- 78 edges on carnot.
'type-checking-only' fires ZERO times on both codebases and structurally will on
most, because 'if TYPE_CHECKING' guards imports rather than calls; do not draw it
until an export exists where it fires.

The tags are already on SpecEdge.data as EdgeTags (guard / looped / allLooped /
errorPath / typeCheckingOnly / sites), null for an external sink line and for the
implicit class -> __init__ edge -- 239 of the overview's 303 lines carry them. The
node roll-ups are already badged on the chip ('hot', 'error handler'), so this
ticket is edge styling only.

Naming stays 'unguarded', never 'unconditional' or 'always'.

- 2026-09-01T18:14:00 z-ai.glm-5.3-flash.001: Implemented as edgeStyleFor(FlowEdgeData) in callFlow.ts, called from style(); no canvas changes, no kind changes (tested: every edge stays kind 'call' with tags on data). The visual budget was argued from the measured distribution and spent on what appears: guarded AND mixed draw dashed [6,4] -- mixed shares the guarded dash because its claim ('this call can be skipped') is true of it too and a third treatment for 2.2%/1.5% of edges is not cheap; looped draws +0.6 heavier stroke, the one channel that reads at any zoom; errorPath takes THEME.cycle, matching the chips' warm 'error handler' badge so one colour means one thing at both ends of a line; type-checking-only is NOT drawn (opacity 0) and got no param -- it fired zero times on both codebases and structurally will on most, so styling and a legend entry would be ink for a tag that never happens (one-line change when an export exists where it fires); unguarded gets nothing -- the 78% majority IS the default. Composition: heuristic confidence keeps its fine [2,4] dash when the edge is also guarded (one dash channel; 'some of this is a guess' is the louder claim), while weight and colour still apply; external sinks keep their pre-existing voice. edge.kind untouched; naming stays 'unguarded'. Tests: callFlow.test.ts +9 (each tag's treatment, the composition rule, kind preservation). npm run test (754 pass), tsc -b clean. Remaining from verification: browser-verify legibility against ../carnot at two zoom levels, both themes if applicable.
