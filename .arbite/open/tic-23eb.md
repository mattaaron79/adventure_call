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
updated: '2026-09-01T17:20:38'
closed: null
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
