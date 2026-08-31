---
id: tic-88ac
title: 'Inspector card: collapsible, with the collapsed state remembered'
status: closed
type: feature
tier: low
domain: ui
epic: viz-workspace
priority: 3
tags:
- inspector
- ui
- persistence
assignee: code
depends_on: []
blocked_by: null
created: '2026-08-30T20:57:47'
updated: '2026-08-30T21:42:43'
closed: '2026-08-30T21:42:43'
---

## Description
The object details card in the bottom right is always at full height and cannot be got out of the way.

WORK
1. src/ui/Inspector.tsx -- a collapse control in the card header. Collapsed, it stays present as a compact bar showing enough to identify the selection (kind swatch, name, kind) so the user can expand it again without reselecting; it must not vanish entirely.
2. Persist the collapsed state through the existing persistence layer (src/state/persist.ts) rather than component state, so it survives a reload. It is a UI preference, not per-mode state -- store it accordingly, and do not let it ride along in saved presets (src/modes/presets.ts), which describe what is visualised, not the chrome around it.
3. Selecting a different node while collapsed must not silently re-expand the card -- the user collapsed it on purpose.
4. Keep the keyboard reachable: the control is a real button with an aria-expanded state.

EXIT: the card collapses to a compact identifying bar and expands again; the state survives a reload; changing selection respects it.

## Notes
- 2026-08-30T21:42:30 code: Implemented collapsible inspector card: real toggle button with aria-expanded that collapses the card to a compact identifying bar (kind swatch, name, kind, goto); the bar tracks the selected node without re-expanding. Collapsed flag is a standalone UI preference persisted under adventure-call:ui via readUiPrefs/writeUiPrefs in persist.ts, hydrated and toggled via setInspectorCollapsed in store.ts; kept out of ModeState and mode presets. Added render tests (renderToStaticMarkup), persist tests, and store tests. Full web suite: 21 files / 277 tests passed; npx tsc -b clean.
