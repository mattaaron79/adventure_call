---
id: tic-59b1
title: 'Type-flow overlay: the pipeline implied by parameter and return annotations'
status: open
type: feature
tier: high
domain: ui
epic: call-flow
priority: 11
tags:
- call-flow
- types
- dataflow
assignee: null
depends_on:
- tic-2255
- tic-7a5e
blocked_by: null
created: '2026-09-01T07:26:39'
updated: '2026-09-01T07:26:55'
closed: null
---

## Description
A second kind of flow drawn over the SAME nodes as the call graph: A returns ToolResult, B accepts ToolResult, so data can move A -> B whether or not A ever calls B.

Depends on the `returns` field ticket; parameter annotations are already in the export.

Coverage is partial and honestly so -- measured on ../carnot, 1094 of 2528 callables carry a return annotation and 1270 of 3539 params are annotated. That is enough to be useful and not enough to be authoritative, and it improves on its own as a codebase gets typed. The UI must not imply the picture is complete.

Match annotations as WRITTEN, with light normalisation only: strip Optional/Union wrappers to their members, unwrap the obvious containers (list/dict/set/tuple/Sequence/Iterable) to their element type, and resolve a bare name through the module's own bindings, which the registry already exports per module. Do not attempt real type resolution or generics -- a string match on a normalised name is the right altitude here, and the failure mode (a missed link) is much better than the alternative (a fabricated one).

Render as an overlay on the call-flow mode, off by default, distinct from call edges. The interesting reading is where type flow and call flow DISAGREE: two functions that pass the same type but never call each other are either an unfinished pipeline or a missing abstraction, and that gap is exactly what a human is looking for.

Verification: unit tests over normalisation (Optional, Union, list[T], nested generics, forward-reference strings, a dotted name, an unresolvable name that must be dropped); browser-verify against a real ../carnot type that flows through several functions. npm run test, tsc -b.

## Notes
