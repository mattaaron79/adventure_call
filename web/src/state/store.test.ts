import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SCALE } from '../canvas/viewport'
import { GOTO_ZOOM_FACTOR } from '../settings'
import { modeById } from '../modes/registry'
import { storageKey } from './persist'

/**
 * The store hydrates at import time, so the fake storage has to be installed
 * before the module graph is evaluated -- hence `vi.hoisted`, which runs ahead
 * of the imports below.
 */
const SAVED = vi.hoisted(() => {
  const saved = { viewport: { x: -300, y: 120, scale: 2 }, overrides: { 'a.py': { x: 5, y: 6 } }, expanded: {}, params: {}, filterVisible: false, focusPath: '' }
  const map = new Map<string, string>([
    ['adventure-call:workspace:fs-tree', JSON.stringify(saved)],
    // A saved standalone UI preference (tic-88ac): the inspector is collapsed.
    ['adventure-call:ui', JSON.stringify({ inspectorCollapsed: true })],
  ])
  globalThis.localStorage = {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  } as Storage
  return saved
})

const {
  DEFAULT_MODE_ID,
  activeMode,
  flushWorkspaceState,
  relayout,
  selectExpanded,
  selectOverrides,
  selectViewport,
  useWorkspace,
} = await import('./store')

const RESET = {
  modeId: DEFAULT_MODE_ID,
  modes: { [DEFAULT_MODE_ID]: structuredClone(SAVED) },
  restored: true,
  selection: new Set<string>(),
  hovered: null,
  inspectorCollapsed: true,
  origin: null,
}

beforeEach(() => {
  useWorkspace.setState(structuredClone(RESET))
})

describe('hydration', () => {
  it('restores the saved camera and drags, and says so', () => {
    const state = useWorkspace.getState()
    expect(state.restored).toBe(true)
    expect(selectViewport(state)).toEqual(SAVED.viewport)
    expect(selectOverrides(state)).toEqual(SAVED.overrides)
  })

  it('restores the saved inspector collapse UI preference (tic-88ac)', () => {
    expect(useWorkspace.getState().inspectorCollapsed).toBe(true)
  })
})

describe('inspector collapse (tic-88ac)', () => {
  it('toggles the flag and persists it to its own UI-pref key, not the mode slice', () => {
    useWorkspace.getState().setInspectorCollapsed(false)
    expect(useWorkspace.getState().inspectorCollapsed).toBe(false)
    // The mode slice itself never carries the flag...
    expect(activeMode(useWorkspace.getState())).not.toHaveProperty('inspectorCollapsed')
    // ...and neither does the mode's serialized state.
    flushWorkspaceState()
    const mode = JSON.parse(localStorage.getItem(storageKey(DEFAULT_MODE_ID))!)
    expect(mode).not.toHaveProperty('inspectorCollapsed')
    // The standalone UI pref is written to its own key.  The animate-all flag
    // rides along in the same chrome prefs object (tic-5196).
    expect(JSON.parse(localStorage.getItem('adventure-call:ui')!)).toEqual({
      inspectorCollapsed: false,
      animateAllEdges: false,
    })
  })

  it('stays collapsed while the selection changes', () => {
    useWorkspace.getState().setInspectorCollapsed(true)
    useWorkspace.getState().select(['a'])
    useWorkspace.getState().select(['b', 'c'])
    expect(useWorkspace.getState().inspectorCollapsed).toBe(true)
  })

  it('survives a mode switch, because it is chrome, not per-mode state', () => {
    useWorkspace.getState().setInspectorCollapsed(true)
    useWorkspace.getState().setMode('call-graph')
    expect(useWorkspace.getState().inspectorCollapsed).toBe(true)
    useWorkspace.getState().setMode(DEFAULT_MODE_ID)
    expect(useWorkspace.getState().inspectorCollapsed).toBe(true)

    // Settle the write queued by the mode switch and drop the entry so later
    // tests still see 'call-graph' as never-saved.
    flushWorkspaceState()
    localStorage.removeItem(storageKey('call-graph'))
  })
})

describe('camera', () => {
  it('pans and zooms the active mode', () => {
    useWorkspace.getState().panBy(10, -5)
    expect(selectViewport(useWorkspace.getState())).toEqual({ x: -290, y: 115, scale: 2 })

    useWorkspace.getState().zoomAtPointer({ x: 0, y: 0 }, 2)
    expect(selectViewport(useWorkspace.getState()).scale).toBe(4)
  })

  it('clamps whatever it is handed', () => {
    useWorkspace.getState().setViewport({ x: 0, y: 0, scale: 1e6 })
    expect(selectViewport(useWorkspace.getState()).scale).toBe(MAX_SCALE)
  })

  it('frames a rect', () => {
    useWorkspace.getState().fitTo({ x: 0, y: 0, width: 100, height: 100 }, { width: 400, height: 400 }, 0)
    expect(selectViewport(useWorkspace.getState())).toEqual({ x: 0, y: 0, scale: 4 })
  })

  it('centres on a rect, pan-only keeping the current zoom', () => {
    useWorkspace
      .getState()
      .centerOn({ x: 100, y: 50, width: 40, height: 20 }, { width: 400, height: 400 })
    // Saved camera is scale 2, so the pan keeps it and centres the rect.
    expect(selectViewport(useWorkspace.getState())).toEqual({ x: -40, y: 80, scale: 2 })
  })

  it('zooms to a softened comfortable minimum when asked', () => {
    // A fresh camera (scale 1) sits below the softened goto target, so the
    // zoom still engages -- landing at about a third of the old fit scale.
    useWorkspace.getState().setViewport({ x: 0, y: 0, scale: 1 })
    useWorkspace
      .getState()
      .centerOn({ x: 0, y: 0, width: 100, height: 100 }, { width: 400, height: 400 }, { padding: 0, zoom: true })
    const vp = selectViewport(useWorkspace.getState())
    const scale = 4 * GOTO_ZOOM_FACTOR
    expect(vp.scale).toBeCloseTo(scale)
    expect(vp.x).toBeCloseTo(200 - 50 * scale)
    expect(vp.y).toBeCloseTo(200 - 50 * scale)
  })

  it('never zooms out past the user zoom, even when asked to zoom', () => {
    // Saved camera is scale 2; the softened goto target (4 * factor) sits
    // below it, so the goto keeps the user's zoom and only pans.
    useWorkspace
      .getState()
      .centerOn({ x: 0, y: 0, width: 100, height: 100 }, { width: 400, height: 400 }, { padding: 0, zoom: true })
    expect(selectViewport(useWorkspace.getState()).scale).toBe(2)
  })
})

describe('selection', () => {
  it('replaces by default and adds when asked', () => {
    const store = useWorkspace.getState()
    store.select(['a', 'b'])
    expect([...useWorkspace.getState().selection]).toEqual(['a', 'b'])

    store.select(['c'])
    expect([...useWorkspace.getState().selection]).toEqual(['c'])

    store.select(['d'], true)
    expect([...useWorkspace.getState().selection]).toEqual(['c', 'd'])
  })

  it('toggles one id in and out', () => {
    const store = useWorkspace.getState()
    store.select(['a'])
    store.toggleSelected('b')
    expect([...useWorkspace.getState().selection]).toEqual(['a', 'b'])
    store.toggleSelected('a')
    expect([...useWorkspace.getState().selection]).toEqual(['b'])
  })

  it('keeps the same object when a marquee re-selects the same nodes', () => {
    useWorkspace.getState().select(['a', 'b'])
    const first = useWorkspace.getState().selection
    useWorkspace.getState().select(['b', 'a'])
    expect(useWorkspace.getState().selection).toBe(first)
  })

  it('is not persisted', () => {
    useWorkspace.getState().select(['a'])
    useWorkspace.getState().setHovered('a')
    flushWorkspaceState()
    const raw = localStorage.getItem(storageKey(DEFAULT_MODE_ID)) ?? ''
    expect(raw).not.toContain('selection')
    expect(raw).not.toContain('hovered')
  })
})

describe('position overrides', () => {
  it('merges drags and forgets them on relayout', () => {
    useWorkspace.getState().moveNodes({ 'b.py': { x: 1, y: 2 } })
    expect(selectOverrides(useWorkspace.getState())).toEqual({
      'a.py': { x: 5, y: 6 },
      'b.py': { x: 1, y: 2 },
    })

    relayout()
    expect(selectOverrides(useWorkspace.getState())).toEqual({})
  })
})

describe('collapse all folders (tic-2356)', () => {
  it('collapses every dir:* key and leaves file containers alone', () => {
    useWorkspace.getState().setExpanded({
      'dir:src': true,
      'dir:src/app': false,
      'src/app/loop.py': true,
      'dir:lib': false,
    })
    useWorkspace.getState().collapseAllFolders(['dir:src', 'dir:src/app', 'dir:lib'])
    expect(selectExpanded(useWorkspace.getState())).toEqual({
      'dir:src': false,
      'dir:src/app': false,
      'src/app/loop.py': true,
      'dir:lib': false,
    })
  })

  it('does not touch keys it was not given', () => {
    useWorkspace.getState().setExpanded({ 'dir:web': true, 'other:id': true })
    useWorkspace.getState().collapseAllFolders(['dir:web'])
    expect(selectExpanded(useWorkspace.getState())).toEqual({
      'dir:web': false,
      'other:id': true,
    })
  })

  it('returns the same state when nothing needs collapsing', () => {
    const before = useWorkspace.getState().modes[useWorkspace.getState().modeId]
    useWorkspace.getState().collapseAllFolders([])
    expect(useWorkspace.getState().modes[useWorkspace.getState().modeId]).toBe(before)
  })

  it('collapses expanded file containers when given their bare-path keys', () => {
    useWorkspace.getState().setExpanded({
      'dir:src': true,
      'src/app/loop.py': true,
      'src/app/errors.py': true,
    })
    useWorkspace.getState().collapseAllFolders(['src/app/loop.py', 'src/app/errors.py'])
    expect(selectExpanded(useWorkspace.getState())).toEqual({
      'dir:src': true,
      'src/app/loop.py': false,
      'src/app/errors.py': false,
    })
  })
})

describe('expand all folders (tic-2356)', () => {
  it('expands every given dir:* key and leaves file containers alone', () => {
    useWorkspace.getState().setExpanded({
      'dir:src': false,
      'dir:src/app': false,
      'src/app/loop.py': true,
      'dir:lib': false,
    })
    useWorkspace.getState().expandAllFolders(['dir:src', 'dir:src/app', 'dir:lib'])
    expect(selectExpanded(useWorkspace.getState())).toEqual({
      'dir:src': true,
      'dir:src/app': true,
      'src/app/loop.py': true,
      'dir:lib': true,
    })
  })

  it('does not touch keys it was not given', () => {
    useWorkspace.getState().setExpanded({ 'dir:web': false, 'other:id': true })
    useWorkspace.getState().expandAllFolders(['dir:web'])
    expect(selectExpanded(useWorkspace.getState())).toEqual({
      'dir:web': true,
      'other:id': true,
    })
  })

  it('returns the same state when nothing needs expanding', () => {
    useWorkspace.getState().setExpanded({ 'dir:src': true })
    const before = useWorkspace.getState().modes[useWorkspace.getState().modeId]
    useWorkspace.getState().expandAllFolders(['dir:src'])
    expect(useWorkspace.getState().modes[useWorkspace.getState().modeId]).toBe(before)
  })
})


describe('focus scope (tic-e7d2)', () => {
  it('sets the active mode focus path and drops stale drag overrides', () => {
    useWorkspace.getState().moveNodes({ 'b.py': { x: 1, y: 2 } })
    useWorkspace.getState().setFocusPath('src/app')
    const state = useWorkspace.getState()
    expect(activeMode(state).focusPath).toBe('src/app')
    // Entering a scope must not inherit drags from the wider view.
    expect(selectOverrides(state)).toEqual({})
  })

  it('keeps the same state when the focus path does not change', () => {
    const before = useWorkspace.getState().modes[DEFAULT_MODE_ID]
    useWorkspace.getState().setFocusPath('')
    expect(useWorkspace.getState().modes[DEFAULT_MODE_ID]).toBe(before)
  })

  it('persists the focus path with the mode state', () => {
    useWorkspace.getState().setFocusPath('src/app')
    flushWorkspaceState()
    const stored = JSON.parse(localStorage.getItem(storageKey(DEFAULT_MODE_ID))!)
    expect(stored.focusPath).toBe('src/app')
  })

  it('keeps each mode its own focus path', () => {
    useWorkspace.getState().setFocusPath('src/app')
    useWorkspace.getState().setMode('call-graph')
    expect(activeMode(useWorkspace.getState()).focusPath).toBe('')

    // fs-tree's own slice still holds its focus while another mode is active.
    expect(useWorkspace.getState().modes[DEFAULT_MODE_ID].focusPath).toBe('src/app')

    // Settle the writes queued by the mode switches above.
    flushWorkspaceState()
    localStorage.removeItem(storageKey('call-graph'))
  })

  it('auto-expands the entered folder without collapsing anything (tic-b1ab)', () => {
    useWorkspace.getState().setExpanded({ 'dir:src': true, 'src/app/loop.py': true })
    useWorkspace.getState().setFocusPath('src/app')
    const state = useWorkspace.getState()
    expect(activeMode(state).focusPath).toBe('src/app')
    // The focused folder joins the expand state; what was already open stays.
    expect(selectExpanded(state)).toEqual({
      'dir:src': true,
      'src/app/loop.py': true,
      'dir:src/app': true,
    })
  })

  it('does not add an expand entry when leaving the scope back to root (tic-b1ab)', () => {
    useWorkspace.getState().setFocusPath('src/app')
    expect(selectExpanded(useWorkspace.getState())).toEqual({ 'dir:src/app': true })

    useWorkspace.getState().setFocusPath('')
    // Leaving the scope touches neither the path nor the expand state.
    expect(selectExpanded(useWorkspace.getState())).toEqual({ 'dir:src/app': true })
  })

  it('re-opens a folder explicitly collapsed from inside the scope (tic-b1ab)', () => {
    useWorkspace.getState().setFocusPath('src/app') // auto-expands
    useWorkspace.getState().toggleExpanded('dir:src/app') // collapse it -> false
    expect(selectExpanded(useWorkspace.getState())).toEqual({ 'dir:src/app': false })

    // Re-entering the same scope (its own breadcrumb) flips it back open.
    useWorkspace.getState().setFocusPath('src/app')
    expect(selectExpanded(useWorkspace.getState())).toEqual({ 'dir:src/app': true })
  })
})

describe('persistence', () => {
  it('writes the active mode after a change settles', () => {
    useWorkspace.getState().panBy(40, 0)
    flushWorkspaceState()
    const stored = JSON.parse(localStorage.getItem(storageKey(DEFAULT_MODE_ID))!)
    expect(stored.viewport).toEqual({ x: -260, y: 120, scale: 2 })
    expect(stored.overrides).toEqual(SAVED.overrides)
  })
})

describe('filter visibility toggle', () => {
  it('toggles per mode and persists with the mode state', () => {
    expect(activeMode(useWorkspace.getState()).filterVisible).toBe(false)

    useWorkspace.getState().setFilterVisible(true)
    expect(activeMode(useWorkspace.getState()).filterVisible).toBe(true)

    flushWorkspaceState()
    const stored = JSON.parse(localStorage.getItem(storageKey(DEFAULT_MODE_ID))!)
    expect(stored.filterVisible).toBe(true)

    useWorkspace.getState().setFilterVisible(false)
    expect(activeMode(useWorkspace.getState()).filterVisible).toBe(false)
  })

  it('keeps each mode its own toggle', () => {
    useWorkspace.getState().setFilterVisible(true)
    useWorkspace.getState().setMode('call-graph')
    expect(activeMode(useWorkspace.getState()).filterVisible).toBe(false)

    useWorkspace.getState().setMode(DEFAULT_MODE_ID)
    expect(activeMode(useWorkspace.getState()).filterVisible).toBe(true)

    // Settle the writes queued by the mode switches above.
    flushWorkspaceState()
    localStorage.removeItem(storageKey('call-graph'))
  })
})

describe('mode params and expand state', () => {
  it('replaces params and expand state wholesale, as a preset load does', () => {
    useWorkspace.getState().setParams({ showImports: false })
    expect(activeMode(useWorkspace.getState()).params).toEqual({ showImports: false })

    useWorkspace.getState().setExpanded({ 'a.py': true, 'b.py': false })
    expect(selectExpanded(useWorkspace.getState())).toEqual({ 'a.py': true, 'b.py': false })
  })

  it('keeps each mode its own params and expand state', () => {
    useWorkspace.getState().setParams({ showImports: false })
    useWorkspace.getState().setMode('call-graph')
    expect(activeMode(useWorkspace.getState()).params).toEqual({})

    useWorkspace.getState().setMode(DEFAULT_MODE_ID)
    expect(activeMode(useWorkspace.getState()).params).toEqual({ showImports: false })

    // The mode switches above queued a write for 'call-graph'; settle it and
    // drop the entry so later tests still see that mode as never-saved.
    flushWorkspaceState()
    localStorage.removeItem(storageKey('call-graph'))
  })
})

describe('modes', () => {
  it('gives each mode its own camera and drops the selection on the way', () => {
    useWorkspace.getState().select(['a'])
    useWorkspace.getState().setMode('call-graph')

    const state = useWorkspace.getState()
    expect(state.modeId).toBe('call-graph')
    expect(state.restored).toBe(false)
    expect(selectViewport(state)).toEqual({ x: 0, y: 0, scale: 1 })
    expect(state.selection.size).toBe(0)

    state.panBy(7, 7)
    useWorkspace.getState().setMode(DEFAULT_MODE_ID)
    expect(selectViewport(useWorkspace.getState())).toEqual(SAVED.viewport)
  })
})

describe('cross-mode navigation (tic-e738)', () => {
  const OTHER = 'import-graph'

  afterEach(() => {
    flushWorkspaceState()
    localStorage.removeItem(storageKey(OTHER))
  })

  it('switches mode and seeds that mode focus in one go', () => {
    useWorkspace.getState().openInMode(OTHER, 'src/app/loop.py')
    const state = useWorkspace.getState()
    expect(state.modeId).toBe(OTHER)
    expect(activeMode(state).focusPath).toBe('src/app/loop.py')
  })

  it('never lets the new mode render against the old focus', () => {
    // The reason this is one action and not setMode + setFocusPath: with two
    // calls the store would briefly hold the destination mode with whatever
    // focus it had before, and the canvas would lay out and frame a scene
    // nobody asked for. Every state React can observe must already agree.
    useWorkspace.getState().setMode(OTHER)
    useWorkspace.getState().setFocusPath('stale/path')
    useWorkspace.getState().setMode(DEFAULT_MODE_ID)

    const seen: { modeId: string; focusPath: string }[] = []
    const stop = useWorkspace.subscribe((state) =>
      seen.push({ modeId: state.modeId, focusPath: activeMode(state).focusPath }),
    )
    useWorkspace.getState().openInMode(OTHER, 'src/app/loop.py')
    stop()

    expect(seen.length).toBeGreaterThan(0)
    for (const step of seen) {
      if (step.modeId === OTHER) expect(step.focusPath).toBe('src/app/loop.py')
    }
  })

  it('leaves the mode being left completely untouched', () => {
    useWorkspace.getState().setFocusPath('src/app')
    useWorkspace.getState().moveNodes({ 'b.py': { x: 1, y: 2 } })
    const before = useWorkspace.getState().modes[DEFAULT_MODE_ID]

    useWorkspace.getState().openInMode(OTHER, 'src/app/loop.py')

    // Same object, not merely an equal one: nothing rewrote the source mode.
    expect(useWorkspace.getState().modes[DEFAULT_MODE_ID]).toBe(before)
    expect(before.focusPath).toBe('src/app')
  })

  it('drops the destination stale drag overrides', () => {
    useWorkspace.getState().setMode(OTHER)
    useWorkspace.getState().moveNodes({ 'x.py': { x: 9, y: 9 } })
    useWorkspace.getState().setMode(DEFAULT_MODE_ID)

    useWorkspace.getState().openInMode(OTHER, 'src/app/loop.py')
    expect(selectOverrides(useWorkspace.getState())).toEqual({})
  })

  it('clears a selection and hover that belonged to the mode being left', () => {
    useWorkspace.getState().select(['a.py'])
    useWorkspace.getState().setHovered('a.py')
    useWorkspace.getState().openInMode(OTHER, 'src/app/loop.py')
    expect(useWorkspace.getState().selection.size).toBe(0)
    expect(useWorkspace.getState().hovered).toBeNull()
  })

  it('re-focuses the active mode when it is already the destination', () => {
    // Not a no-op, and not a mode switch either: the selection survives,
    // because nothing was left.
    useWorkspace.getState().select(['a.py'])
    useWorkspace.getState().openInMode(DEFAULT_MODE_ID, 'src/app')
    const state = useWorkspace.getState()
    expect(state.modeId).toBe(DEFAULT_MODE_ID)
    expect(activeMode(state).focusPath).toBe('src/app')
    expect(state.selection.size).toBe(1)
  })

  it('keeps the same state when the destination is already focused there', () => {
    useWorkspace.getState().setFocusPath('src/app')
    const before = useWorkspace.getState().modes[DEFAULT_MODE_ID]
    useWorkspace.getState().openInMode(DEFAULT_MODE_ID, 'src/app')
    expect(useWorkspace.getState().modes[DEFAULT_MODE_ID]).toBe(before)
  })

  it('auto-expands the seeded folder, like entering a scope does', () => {
    useWorkspace.getState().openInMode(OTHER, 'src/app')
    expect(selectExpanded(useWorkspace.getState())['dir:src/app']).toBe(true)
  })

  it('persists the destination seeded focus', () => {
    useWorkspace.getState().openInMode(OTHER, 'src/app/loop.py')
    flushWorkspaceState()
    const stored = JSON.parse(localStorage.getItem(storageKey(OTHER))!)
    expect(stored.focusPath).toBe('src/app/loop.py')
  })

  it('takes an unknown mode id at face value, and the registry falls back', () => {
    // The store does not know which modes exist -- the registry is the only
    // thing that does. So a bad id is stored as given and resolves to the
    // default mode at render, rather than being silently swallowed here.
    useWorkspace.getState().openInMode('no-such-mode', 'whatever')
    expect(useWorkspace.getState().modeId).toBe('no-such-mode')
    expect(modeById('no-such-mode').id).toBe(DEFAULT_MODE_ID)

    flushWorkspaceState()
    localStorage.removeItem(storageKey('no-such-mode'))
  })

  it('seeds a target the destination cannot resolve, and leaves it to the mode', () => {
    // The store cannot know whether a focus is renderable -- it has no graph.
    // The mode contract (modes/types.ts UiState.focusPath) is that an
    // unresolvable focus draws the whole graph, so seeding one is safe.
    useWorkspace.getState().openInMode(OTHER, 'gone/missing.py')
    expect(activeMode(useWorkspace.getState()).focusPath).toBe('gone/missing.py')
  })
})


describe('cross-mode excursions (tic-53f7)', () => {
  beforeEach(() => {
    useWorkspace.setState({ origin: null })
    localStorage.removeItem('adventure-call:excursion')
  })

  afterEach(() => {
    flushWorkspaceState()
    localStorage.removeItem(storageKey('import-graph'))
    localStorage.removeItem(storageKey('call-flow'))
    localStorage.removeItem('adventure-call:excursion')
  })

  it('records where a jump started, with the origin focus it had at the time', () => {
    useWorkspace.getState().setFocusPath('src/app')
    useWorkspace.getState().openInMode('import-graph', 'src/app/loop.py')
    expect(useWorkspace.getState().origin).toEqual({
      modeId: DEFAULT_MODE_ID,
      focusPath: 'src/app',
    })
  })

  it('records nothing for a re-focus inside the same mode', () => {
    // Nothing was left, so there is nowhere to go back to.
    useWorkspace.getState().openInMode(DEFAULT_MODE_ID, 'src/app')
    expect(useWorkspace.getState().origin).toBeNull()
  })

  it('goes back to the origin mode AND its focus in one transition', () => {
    useWorkspace.getState().setFocusPath('src/app')
    useWorkspace.getState().openInMode('import-graph', 'src/app/loop.py')
    useWorkspace.getState().returnFromExcursion()

    const state = useWorkspace.getState()
    expect(state.modeId).toBe(DEFAULT_MODE_ID)
    expect(activeMode(state).focusPath).toBe('src/app')
    expect(state.origin).toBeNull()
  })

  it('leaves the destination where it was, so going back out returns to it', () => {
    useWorkspace.getState().openInMode('import-graph', 'src/app/loop.py')
    useWorkspace.getState().returnFromExcursion()
    expect(useWorkspace.getState().modes['import-graph'].focusPath).toBe('src/app/loop.py')
  })

  it('survives navigation INSIDE the destination, which is what that view is for', () => {
    // Re-centring the import graph's Local View on neighbour after neighbour
    // is the point of it (tic-d7d7); deleting the way home after one step
    // would take the affordance away mid-walk.
    useWorkspace.getState().setFocusPath('src/app')
    useWorkspace.getState().openInMode('import-graph', 'src/app/loop.py')
    useWorkspace.getState().setFocusPath('src/app/other.py')
    useWorkspace.getState().setFocusPath('src/app/third.py')

    expect(useWorkspace.getState().origin).toEqual({
      modeId: DEFAULT_MODE_ID,
      focusPath: 'src/app',
    })
    useWorkspace.getState().returnFromExcursion()
    expect(useWorkspace.getState().modeId).toBe(DEFAULT_MODE_ID)
  })

  it('ends when a mode is chosen by hand, because that is leaving on purpose', () => {
    useWorkspace.getState().openInMode('import-graph', 'src/app/loop.py')
    useWorkspace.getState().setMode('call-flow')
    expect(useWorkspace.getState().origin).toBeNull()
  })

  it('is one level deep: a second jump replaces the first', () => {
    // "Back to where this started" is one destination.  A stack would need a
    // UI to disambiguate several, which the toolbar does not have.
    useWorkspace.getState().openInMode('import-graph', 'src/app/loop.py')
    useWorkspace.getState().openInMode('call-flow', 'src.app.loop.run')
    expect(useWorkspace.getState().origin).toEqual({
      modeId: 'import-graph',
      focusPath: 'src/app/loop.py',
    })
  })

  it('does nothing when there is no excursion to return from', () => {
    const before = useWorkspace.getState()
    useWorkspace.getState().returnFromExcursion()
    expect(useWorkspace.getState()).toBe(before)
  })

  it('survives a reload, because a forgotten way home is worse than none', () => {
    useWorkspace.getState().setFocusPath('src/app')
    useWorkspace.getState().openInMode('import-graph', 'src/app/loop.py')
    expect(JSON.parse(localStorage.getItem('adventure-call:excursion')!)).toEqual({
      modeId: DEFAULT_MODE_ID,
      focusPath: 'src/app',
    })
  })

  it('clears the stored excursion once it has been taken', () => {
    useWorkspace.getState().openInMode('import-graph', 'src/app/loop.py')
    useWorkspace.getState().returnFromExcursion()
    expect(localStorage.getItem('adventure-call:excursion')).toBeNull()
  })

  it('clears the stored excursion when a mode is chosen by hand', () => {
    useWorkspace.getState().openInMode('import-graph', 'src/app/loop.py')
    useWorkspace.getState().setMode('call-flow')
    expect(localStorage.getItem('adventure-call:excursion')).toBeNull()
  })

  it('returns to a mode whose origin focus has since become unresolvable', () => {
    // The contract in modes/types.ts: a focus a mode cannot resolve draws its
    // unfocused state.  This only has to restore it and let the mode degrade;
    // refusing to navigate would strand the user in the destination.
    useWorkspace.getState().setFocusPath('src/gone')
    useWorkspace.getState().openInMode('import-graph', 'src/app/loop.py')
    useWorkspace.getState().returnFromExcursion()
    const state = useWorkspace.getState()
    expect(state.modeId).toBe(DEFAULT_MODE_ID)
    expect(activeMode(state).focusPath).toBe('src/gone')
  })

  it('names the origin by its MODE, which is what makes it a different gesture from /', () => {
    useWorkspace.getState().openInMode('import-graph', 'src/app/loop.py')
    const origin = useWorkspace.getState().origin!
    expect(modeById(origin.modeId).label).toBe('Files & symbols')
  })
})
