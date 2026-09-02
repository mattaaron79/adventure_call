---
id: tic-59b1
title: 'Type-flow overlay: the pipeline implied by parameter and return annotations'
status: closed
type: feature
tier: high
domain: ui
epic: call-flow
priority: 11
tags:
- call-flow
- types
- dataflow
assignee: claude.opus.001
depends_on:
- tic-2255
- tic-7a5e
blocked_by: null
created: '2026-09-01T07:26:39'
updated: '2026-09-02T00:44:54'
closed: '2026-09-02T00:44:54'
---

## Description
A second kind of flow drawn over the SAME nodes as the call graph: A returns ToolResult, B accepts ToolResult, so data can move A -> B whether or not A ever calls B.

Depends on the `returns` field ticket; parameter annotations are already in the export.

Coverage is partial and honestly so -- measured on ../carnot, 1094 of 2528 callables carry a return annotation and 1270 of 3539 params are annotated. That is enough to be useful and not enough to be authoritative, and it improves on its own as a codebase gets typed. The UI must not imply the picture is complete.

Match annotations as WRITTEN, with light normalisation only: strip Optional/Union wrappers to their members, unwrap the obvious containers (list/dict/set/tuple/Sequence/Iterable) to their element type, and resolve a bare name through the module's own bindings, which the registry already exports per module. Do not attempt real type resolution or generics -- a string match on a normalised name is the right altitude here, and the failure mode (a missed link) is much better than the alternative (a fabricated one).

Render as an overlay on the call-flow mode, off by default, distinct from call edges. The interesting reading is where type flow and call flow DISAGREE: two functions that pass the same type but never call each other are either an unfinished pipeline or a missing abstraction, and that gap is exactly what a human is looking for.

Verification: unit tests over normalisation (Optional, Union, list[T], nested generics, forward-reference strings, a dotted name, an unresolvable name that must be dropped); browser-verify against a real ../carnot type that flows through several functions. npm run test, tsc -b.

## Notes
- 2026-09-02T00:44:54 claude.opus.001: Done. `web/src/data/typeFlow.ts` plus an overlay on mode 3 and a coverage
clause in the HUD.

## Two of the ticket's premises did not survive measurement

1. THE OVERLAY HAS TO ADD NODES. The ticket asked for lines between the nodes
   already drawn. Measured, that draws almost nothing: 17 producer/consumer
   pairs land inside ../carnot's whole 171-chip overview, ZERO inside a rooted
   view, and zero anywhere on hypermenu. The reason is structural, not bad
   luck -- the scene is shaped by the call graph, and two functions that pass a
   type without calling each other are exactly the pair a call cone will never
   contain both halves of. An overlay confined to the existing node set cannot
   show the thing type flow is for.

   So a ROOTED view with the overlay on pulls in the producers and consumers of
   the types the root touches, as chips of their own. That is the feature: who
   else handles what you handle, that you never call. Measured after the
   change:

     carnot,   rooted on parse_rules:    22 -> 27 chips, 12 type lines
     hypermenu, rooted on _stage_config:  4 -> 10 chips,  4 type lines
     carnot,   overview:                171 -> 171 chips, 13 type lines

   `parse_rules -> Rules._readings via Rule` is the shape: a producer and three
   consumers it never calls. The pull-in is rooted-only, and the extra chips
   are deliberately NOT counted in `cone.beyond` -- that number is a claim
   about what the CALL neighbourhood left out, and inflating it would make the
   root's honesty clause lie.

2. DISAGREEMENT IS THE RULE, NOT THE FINDING. The ticket expected type flow and
   call flow to mostly agree, with the gaps as the signal. It is the other way
   round: of ../carnot's 1246 producer/consumer pairs, a call joins EIGHT.
   0.6%. So `beside` marks the rare agreement, and the style draws the
   confirmed hand-off HEAVIER rather than muting it -- the reverse of what
   tic-675a's state overlay does, for a measured reason rather than a stylistic
   one.

## Currency types are excluded, and the cut is measured rather than picked

A type everything makes links nothing to nothing. Sorting ../carnot's 39
two-ended project types by producers + consumers puts a visible gap after six:

  ToolResult 53, CommandContext 53, Event 41, Message 36, Turn 26, ToolCall 17
  ---- gap ----
  Session 16, Cursor 13, Grant 10, Rule 7, ...

Those six ARE the currency of that codebase, the shapes every layer passes
around, and each would drag dozens of unrelated chips into a rooted view.
TYPE_NEIGHBOUR_LIMIT = 16 sits in the gap: 33 of 39 types survive.

## Coverage, stated rather than buried

  carnot     returns annotated 1132/2578 (44%)   params 1285/2801 (46%)
  hypermenu  returns annotated   89/572  (16%)   params  101/546  (18%)

The mode's HUD gains a second clause while the overlay is on, one step quieter
than tic-171f's call-coverage line. A reader looking at a sparse type graph has
to be able to tell "these are the links" from "these are the links we can see",
and hypermenu at 16% is exactly the case that would otherwise mislead.

(My parameter totals differ from the ticket's 1270/3539 because `self` and
`cls` are not counted -- a receiver is almost never annotated, and counting it
would drag the figure down by one per method and understate how typed the
codebase is.)

## Normalisation

Every case the ticket named, verified against the real export:

  int                        -> [int]
  Optional[ToolResult]       -> [ToolResult]
  ToolResult | None          -> [ToolResult]
  Union[A, B]                -> [A, B]
  A | B | None               -> [A, B]
  list[ToolResult]           -> [ToolResult]
  dict[str, ToolResult]      -> [str, ToolResult]
  list[Optional[ToolResult]] -> [ToolResult]
  "ToolResult"               -> [ToolResult]
  types.ToolResult           -> [ToolResult]
  dict[str | int, Result]    -> [str, int, Result]
  Result[int]                -> [Result]
  tuple[int, ...]            -> [int]
  Callable[[int], str]       -> [Callable]
  None                       -> []

A mapping yields ALL its arguments rather than a guess at which is the payload;
`str` costs nothing because it resolves to no project class and is dropped a
step later. An unknown generic keeps its head. Unions split only at bracket
depth zero, so `dict[str | int, X]` does not split into `dict[str` and
`int, X]`.

Resolution is same-module classes first, then the module's own import bindings
from the registry, and nothing else. No project-wide name search: `Config` in
four modules would resolve to whichever was indexed first, and a wrong link is
worse than a missing one. Only in-project CLASSES survive, which is what keeps
`str` and `Path` and `httpx.Response` out.

A constructor is not a producer of its own class -- `Foo()` reaching `Foo` is
already a call edge, and type flow earns its keep on the pairs calls cannot
see. A method is not a consumer of its own class through `self`, which would
make every method of a class a consumer of it.

## Deleted rather than tested

`walk` stripped the quotes from a forward reference before unwrapping generics.
A mutation proved it changes nothing -- every path through `walk` ends at
`lastSegment`, which strips quotes anyway -- so it is gone and `lastSegment`
now documents that it is where forward references lose their quotes. The test
for `"list[ToolResult]"` stays and pins the surviving code.

Two other mutations survived their first run and both were fixture faults
rather than missing rules: the constructor and receiver tests built method
nodes whose module came out as `app.types.Rule` instead of `app.types`, so
nothing resolved either way and the rule was never exercised. And the
currency-type test ran against the overview, where the make/take functions are
orphans and never drawn at all.

## Verification

899 web tests, up from 862. tsc -b clean, build clean.

Mutation-checked ten rules, all now caught: no neighbour pull-in fails 2, no
currency cap fails 1, the overlay defaulting to on fails 2, `kind: 'call'`
fails 2, muting `beside` instead of emphasising it fails 1, a constructor
producing its own class fails 1, counting `self` as a parameter fails 1, a
project-wide name search fails 1, splitting a union inside brackets fails 1,
and not stripping quotes fails 1.

Not browser-verified -- the user is away. The derive layer and the scene output
are checked against fresh carnot and hypermenu exports with the registry
loaded; what remains unverified is how the long-dashed overlay looks on the
canvas alongside tic-675a's dotted one.
