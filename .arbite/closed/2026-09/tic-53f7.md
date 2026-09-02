---
id: tic-53f7
title: 'Cross-mode jumps should be returnable: back out to where you came from'
status: closed
type: feature
tier: high
domain: ui
epic: call-flow
priority: 6
tags:
- navigation
- breadcrumbs
- store
assignee: claude.opus.001
depends_on:
- tic-e738
blocked_by: null
created: '2026-09-01T12:18:32'
updated: '2026-09-01T17:47:36'
closed: '2026-09-01T17:47:36'
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
- 2026-09-01T17:47:35 claude.opus.001: Done. The four questions the ticket said had to be settled and recorded, each
with the reason, because each could defensibly have gone the other way.

## 1. When does provenance expire?

It SURVIVES navigation inside the destination, and ends only when the user
leaves on purpose.

Jump fs-tree -> Local View of A, then re-centre on B, then C: the way back to
fs-tree is still offered. Walking a dependency chain by re-centring is exactly
what Local View is for (tic-d7d7's own notes call it "the fastest way to walk
a dependency chain"), and deleting the affordance after the first step takes
it away mid-walk -- a worse surprise than one that stays put. The alternative
reading, "you are three files deep now, home is no longer related to where you
are", is real but loses more than it protects: the '/' button already means
"the whole graph of the mode I am in", so nothing is ambiguous about a second
control that means something else.

What ends an excursion: choosing a mode by hand in the picker (a deliberate
departure -- offering to return to a trip the user has abandoned would point
at somewhere they have already decided not to be), and taking the return
itself.

It is ONE LEVEL DEEP, not a stack. A second jump replaces the first. "Back to
where this started" is one destination; a stack needs a UI to disambiguate
several, which the deliberately minimal toolbar does not have and which
nothing has asked for.

## 2. Does it survive a reload?

Yes, under its own storage key, `adventure-call:excursion`.

Neither a ModeState nor a UiPrefs, and the ticket was right that it does not
obviously belong in either. A mode slice is keyed BY mode and this is a
relationship BETWEEN two of them: storing it in either end would make the way
home vanish the moment that end's slice was reset, and would put a fact about
the origin inside the destination's record. It is not chrome either -- it
describes navigation, not how the app looks. The same reasoning that gave the
UI preferences their own key gives this one, and persist.ts already had the
precedent.

It never reaches a saved preset, which captures a view rather than the trip
taken to it.

A stored entry with no mode id is refused rather than returned broken -- a
return button that navigates nowhere is worse than no button. A missing focus
path is read as the origin mode's whole graph, which is a perfectly good place
to return to.

## 3. What does it look like?

A button, leftmost in the toolbar, reading `<- Files & symbols` -- the ORIGIN
MODE's own name, from the registry, never a scope.

Leftmost because it is the outermost step of the trail: origin, then this
mode's whole graph, then where you are. Named after a mode because that is
what makes it read as a different gesture from '/', which keeps meaning
exactly what it meant. Styled differently on purpose too: a filled accent chip
against the outlined surface of '..' and '/', so the eye can tell "out of
here" from "up one" without reading either. Ellipsised at 180px with the full
destination in the tooltip.

It renders in BOTH toolbar shapes, not just the rootOnly one the ticket
guessed at, because a jump can land on a directory scope as easily as on a
file or a symbol.

## 4. Origin no longer renderable?

Restored through the same `enterFocus` every other focus change uses, so a
path the origin mode can no longer resolve -- excluded, filtered out, or gone
from a refetched /out -- lands on that mode UNFOCUSED. That is the contract in
modes/types.ts, not anything this action enforces, and it is why the action
needs no special case: it restores the focus and lets the mode degrade.
Refusing to navigate would strand the user in the destination, which is the
one outcome worse than arriving somewhere wider than expected.

## Known limitation, stated rather than papered over

The return button lives in the breadcrumb toolbar, and that toolbar only
renders when the focus path resolves to a rect in the current scene. So a jump
whose TARGET the destination cannot draw offers no return button, even though
the excursion is recorded and survives.

In practice this is near-unreachable for the jumps that ship: both modes
derive from the same workspace, so a file the fs-tree drew is a file the
import graph draws. It is recorded because the failure mode is silent, and
because tic-d6af is about to add more jump sources.

## Verification

736 web tests (up from 716): 12 store, 7 persistence. tsc -b clean, build
clean.

Mutation-checked all four decisions, since the decisions ARE the ticket:
letting in-mode navigation end the excursion, not clearing on a manual mode
switch, recording an excursion for a same-mode re-focus, and stacking instead
of replacing -- each fails exactly the test that states the decision, and
nothing else.

NOT browser-verified: no DOM test environment here (vitest runs in node), and
the toolbar change is JSX over pure logic that is already covered. The round
trip worth clicking is fs-tree -> a file chip's Local View button -> the
`<- Files & symbols` button, and confirming the plain in-mode Local View still
shows no return button when there was no jump.
