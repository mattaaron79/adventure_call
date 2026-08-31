import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SCALE } from '../canvas/viewport'
import { GOTO_ZOOM_FACTOR } from '../settings'
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
