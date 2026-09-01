---
id: tic-e738
title: 'Cross-mode navigation: an ''open symbol S in mode M'' action'
status: open
type: feature
tier: high
domain: ui
epic: call-flow
priority: 3
tags:
- navigation
- store
- modes
assignee: null
depends_on: []
blocked_by: null
created: '2026-09-01T07:22:26'
updated: '2026-09-01T07:22:26'
closed: null
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
