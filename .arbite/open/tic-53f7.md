---
id: tic-53f7
title: 'Cross-mode jumps should be returnable: back out to where you came from'
status: open
type: feature
tier: high
domain: ui
epic: call-flow
priority: 6
tags:
- navigation
- breadcrumbs
- store
assignee: null
depends_on:
- tic-e738
blocked_by: null
created: '2026-09-01T12:18:32'
updated: '2026-09-01T12:18:32'
closed: null
---

## Description
Reported by the user 2026-09-01 after trying tic-e738's fs-tree -> import-graph jump: "the breadcrumb in local mode goes out to the Import graph, and I'd expect it to back out to the files and symbols mode if we entered from there."

They are right, and this is a gap in tic-e738 rather than a new idea. That ticket argued the return trip "is the same mechanism and must cost nothing extra", and built the outbound half only. Nothing records where a jump came from, so backing out cannot know.

CURRENT BEHAVIOUR. In the import graph's Local View the breadcrumb toolbar is `rootOnly` (tic-d7d7): '/' plus a plain label, no '..' and no ancestor crumbs, because a Local View's focus path is a FILE and the ancestor trail would offer directory scopes that mode cannot render. So the only way out is "the whole import graph" -- correct when you got there from inside the import graph, wrong when you arrived from the fs-tree.

WHAT IS NEEDED. Provenance on the jump, and a way back that uses it. `openInMode` (store.ts) is the one place a cross-mode transition happens, so it is the place to record where the user came from -- the source mode id and that mode's focus path at the time. Then the destination's toolbar can offer a return, and the store can restore both in one transition, exactly as the outbound jump does.

Build it generally, as tic-e738 did: "return to wherever this excursion started", not "return to the fs-tree from the import graph". Every future cross-mode jump inherits it, including the call-flow ones tic-d6af will add.

QUESTIONS THE IMPLEMENTER MUST SETTLE AND RECORD:

1. When does provenance expire? Jump fs-tree -> Local View of A, then click Local View of B from inside the import graph. Is the user still on the same excursion (back should reach the fs-tree) or has navigating within the destination ended it (back should reach the whole import graph)? Argue it either way, but decide deliberately -- the difference is felt, not theoretical, since walking a dependency chain by re-centring is exactly what Local View is for (tic-d7d7's notes call it "the fastest way to walk a dependency chain").
2. Does it survive a reload? ModeState is persisted per mode; provenance is about a relationship BETWEEN two modes, so it does not obviously belong in either slice. A jump whose return target is silently forgotten across a refresh is worse than one that never offered a return.
3. What does it look like? Probably an extra crumb in the rootOnly toolbar naming the origin ("Files" or the origin path) rather than a second control -- but the toolbar is deliberately minimal in this mode and the ticket that made it minimal had reasons. Whatever is chosen, '/' must keep meaning "the whole graph of the mode I am in"; the return is a different gesture and must read as one.
4. What happens when the origin is no longer renderable -- the file was excluded, the directory is gone? The same contract every focus obeys (modes/types.ts UiState.focusPath): degrade to the origin mode unfocused rather than refusing to navigate.

Verification: store tests for provenance recorded, used, cleared per the decision in (1), and surviving whatever (2) settles; unit tests on the toolbar's crumb set for both the arrived-from-elsewhere and the arrived-from-here cases. Browser-verify the round trip fs-tree -> Local View -> back, and confirm the plain in-mode Local View is unchanged when there was no jump. npm run test, tsc -b.

## Notes
