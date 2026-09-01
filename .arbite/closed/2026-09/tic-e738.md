---
id: tic-e738
title: 'Cross-mode navigation: an ''open symbol S in mode M'' action'
status: closed
type: feature
tier: high
domain: ui
epic: call-flow
priority: 3
tags:
- navigation
- store
- modes
assignee: claude.opus.001
depends_on: []
blocked_by: null
created: '2026-09-01T07:22:26'
updated: '2026-09-01T10:16:48'
closed: '2026-09-01T10:16:48'
---

## Description
The one framework seam the call-flow mode needs that does not exist yet. Decided with the user 2026-09-01 (see .arbite/planning/call-flow-design.md).

Today `focusPath` is per-mode state whose MEANING each mode defines -- a directory in fs-tree, a file in import-graph's Local View (tic-d7d7), and a symbol id in the coming call-flow mode. App.tsx's resolveGotoScope already documents that divergence. But `setMode` deliberately preserves whatever the target mode last had (store.ts), and SpecNode.focusTo drills only WITHIN the current mode, so there is no way to say "switch to mode X, rooted at Y".

Add that. A store action that sets `modeId` and seeds the target mode's `focusPath` in one transition (one state update, so nothing re-renders against a half-applied switch), plus a way for a spec node to declare such a target. Prefer a NEW optional SpecNode field over overloading `focusTo`: "go into this, here" and "go look at this elsewhere" are different gestures, and conflating them would force the canvas's affordance logic to guess which it is holding. The framework renders the affordance generically, as tic-d7d7 established -- a mode names an icon and a label, it does not write canvas code.

Build it as a general "open symbol/path S in mode M", not as a call-flow special case. The reverse trip (from call-flow back to fs-tree, "show me where this lives on disk") is the same mechanism and must cost nothing extra.

This ticket is independently demonstrable and does not depend on the call-flow mode existing: wire fs-tree's file rows to open import-graph's Local View for that file. That is a real capability the app does not have today, and it proves the seam against two modes that already ship.

Open question for the implementer to resolve and record: what happens when the target mode cannot render the seeded focus (a stale symbol id, a filtered-out file). Falling back to the target mode's unfocused state is probably right; whatever is chosen, make it explicit rather than incidental.

Verification: unit tests on the store action (mode switches, target focus is seeded, the source mode's own state is untouched, an unknown target degrades predictably); browser-verify the fs-tree -> import-graph Local View trip. npm run test, tsc -b.

## Notes
- 2026-09-01T10:16:48 claude.opus.001: Implemented. NOT browser-verified -- see the caveat at the end; everything else the ticket asks for is done and unit-tested.

THE STORE ACTION. `openInMode(modeId, target)` in web/src/state/store.ts, one `set` that switches mode and seeds the destination's focusPath together. The one-transition requirement is not decorative and is now pinned by a test that subscribes to the store and asserts no observed state ever pairs the destination mode with a stale focus -- with setMode + setFocusPath it would, and the canvas would lay out and frame a scene nobody asked for before the focus landed. Also extracted `enterFocus(mode, path)` so setFocusPath and openInMode share one definition of what entering a scope means (clear drag overrides, auto-expand the `dir:` key per tic-b1ab); they would otherwise drift, since only one of them is exercised by everyday clicking.

Behaviour settled and tested: the mode being left is untouched (asserted by object identity, not deep equality); selection and hover clear on a real switch, for the same reason setMode clears them, but NOT on a same-mode re-focus, since nothing was left; the destination's stale drag overrides are dropped; the seeded focus persists; and switching to the already-active mode re-focuses rather than no-opping.

THE SPEC FIELD. `SpecNode.openIn?: OpenInTarget` ({modeId, target, icon?, label?}), kept separate from focusTo exactly as the ticket asked -- the docstring records why, so the next person does not helpfully merge them. Carried through `assemble` (with a test, since a field assembly forgets is a mode feature that silently does nothing) onto SceneNode, and rendered by the canvas as a generic button: the mode names destination, glyph and wording, the canvas knows nothing about what any mode's focus means.

While wiring the button I found the canvas has only ONE action slot and now three candidates for it (focus on a directory chip, goto on an import row, openIn on a file chip). No element carries two today, so one slot is still enough, but "no element does" is not "no element ever will". Rather than leave the outcome implied by JSX order I moved the precedence into a pure `actionAffordance()` in canvas/iconButtonLogic.ts -- which is exactly what that module exists for -- with the ordering argued in the docstring (focus first because it is the only one that navigates within the current view, so losing it strands the user; goto next; the cross-mode jump last, since the inspector will offer it too) and seven tests. A node that genuinely needs two wants a third slot in iconSlots, and the comment says so.

THE OPEN QUESTION -- what happens when the destination cannot render the seeded focus -- RESOLVED, and the answer turned out to be pleasing: the fallback already existed in both shipping modes. fsTree's `scopeRoot` walks back to the root and importGraph's `centre` falls back to '', each documented as its own politeness about a `/out` refetch. So there was nothing to build; what was missing was the STATUS. I promoted it to a stated contract on `UiState.focusPath` in modes/types.ts: a mode MUST treat a focus path it cannot resolve as the unfocused state. The reasoning is that cross-mode navigation changes the frequency -- a foreign or stale focus stops being an accident and becomes an ordinary occurrence, because one mode is now seeding another's state -- so it has to be a requirement on every future mode rather than two independent coincidences. Tested from both directions: fs-tree handed a file path (the import graph's vocabulary) and the import graph handed a directory (the fs-tree's). The import-graph case was ALREADY covered by an existing test, so I extended that test's comment to tie it to the contract rather than duplicating it.

THE DEMONSTRATION. fs-tree file chips now carry an openIn to the import graph's Local View of that file -- a real capability the app did not have, proving the seam against two modes that already ship, with no call-flow mode in sight. File chips only; a directory has no import neighbourhood, and it already spends its action slot on its own 'go into'.

ONE THING I GOT WRONG AND FIXED. My first cut had fsTree.ts import `importGraphMode` just to read its `.id`. That violates a rule this codebase already settled and wrote down: tic-0680 lifted the shared container rows into fileDetail.ts precisely because "a mode importing another mode is the wrong seam -- the registry is the only way modes meet". Tests passed, which is exactly why it was worth catching by reading rather than by running. Replaced with web/src/modes/ids.ts, a leaf module holding the mode id constants, which both modes now take their own `id` from and which a mode declaring a cross-mode target reads the destination's id from. Naming a mode is not importing one, and a bare string literal was not an option either -- a typo would resolve silently to the default mode. Verified no mode imports another outside the registry.

Tests: 26 new (558 -> 584, 28 files). Store (11): switch + seed, the no-intermediate-state subscription test, source mode untouched by identity, overrides dropped, selection/hover cleared, same-mode re-focus keeping the selection, no-op when already focused there, auto-expand, persistence, unknown mode id taken at face value with modeById falling back, unresolvable target seeded and left to the mode. Plus assembly carrying openIn (3), actionAffordance precedence (7), the fs-tree wiring and its focus-vocabulary discipline (4), and the fs-tree fallback contract (2). tsc -b clean, production build fine, no new dependencies.

VERIFICATION GAP, stated plainly: the ticket asks for a browser check of the fs-tree -> import-graph Local View trip, and there is no Playwright or equivalent in this environment, so I could not do it. Everything above is unit-tested, and the pieces that unit tests cannot reach are the ones worth a human eye: that the button actually appears on a file chip at the expected zoom (it is gated on `showGoIn`, i.e. lod < 2), that it does not collide with the source-link button, and that the camera re-frames sensibly on arrival. On that last point, one thing to watch that I could reason about but not observe: Workspace.tsx re-frames on a focusPath CHANGE, so if the destination mode happened to already sit at the same focus path the camera would keep its previous framing. Harmless, but it would look like nothing happened.
