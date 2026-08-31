import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_SCALE } from '../canvas/viewport'
import { memoryStorage } from '../testing/memoryStorage'
import {
  createDebouncedWriter,
  clearModeState,
  emptyModeState,
  readModeState,
  storageKey,
  writeModeState,
} from './persist'

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const STATE = {
  viewport: { x: -120.5, y: 40, scale: 1.75 },
  overrides: { 'src/a.py': { x: 10, y: 20 } },
  expanded: { 'src/a.py': true },
  params: { showImports: false },
  filterVisible: true,
}

describe('mode state', () => {
  it('round trips', () => {
    writeModeState('fs-tree', STATE)
    expect(readModeState('fs-tree')).toEqual(STATE)
  })

  it('keys by mode, so one mode cannot read another camera', () => {
    writeModeState('fs-tree', STATE)
    expect(readModeState('call-graph')).toBeNull()
    expect(localStorage.getItem(storageKey('fs-tree'))).not.toBeNull()
  })

  it('reports nothing stored rather than a default', () => {
    // The canvas frames the scene on a null and restores the camera otherwise;
    // handing back an empty state here would make it frame every reload.
    expect(readModeState('fs-tree')).toBeNull()
  })

  it('survives junk left by a hand edit or an older build', () => {
    localStorage.setItem(storageKey('fs-tree'), 'not json')
    expect(readModeState('fs-tree')).toBeNull()

    localStorage.setItem(storageKey('fs-tree'), '"a string"')
    expect(readModeState('fs-tree')).toBeNull()

    localStorage.setItem(
      storageKey('fs-tree'),
      JSON.stringify({
        viewport: { x: 'nope', y: null, scale: 2 },
        overrides: { good: { x: 1, y: 2 }, bad: { x: 1 }, worse: 7, nan: { x: NaN, y: 0 } },
        expanded: { yes: true, no: 'true' },
      }),
    )
    expect(readModeState('fs-tree')).toEqual({
      viewport: emptyModeState().viewport,
      overrides: { good: { x: 1, y: 2 } },
      expanded: { yes: true },
      params: {},
      filterVisible: false,
    })
  })

  it('defaults filterVisible to false when absent or junk', () => {
    localStorage.setItem(
      storageKey('fs-tree'),
      JSON.stringify({ viewport: { x: 0, y: 0, scale: 1 }, overrides: {}, expanded: {} }),
    )
    expect(readModeState('fs-tree')?.filterVisible).toBe(false)

    localStorage.setItem(
      storageKey('fs-tree'),
      JSON.stringify({ filterVisible: 'yes' }),
    )
    expect(readModeState('fs-tree')?.filterVisible).toBe(false)
  })

  it('keeps only JSON-safe scalar params', () => {
    localStorage.setItem(
      storageKey('fs-tree'),
      JSON.stringify({
        viewport: { x: 0, y: 0, scale: 1 },
        overrides: {},
        expanded: {},
        params: { good: true, bad: { nested: 1 }, worse: [1, 2] },
      }),
    )
    expect(readModeState('fs-tree')?.params).toEqual({ good: true })
  })

  it('clamps a stored scale into the usable range', () => {
    localStorage.setItem(
      storageKey('fs-tree'),
      JSON.stringify({ viewport: { x: 0, y: 0, scale: 1e-9 }, overrides: {}, expanded: {} }),
    )
    expect(readModeState('fs-tree')?.viewport.scale).toBe(MIN_SCALE)
  })

  it('forgets on clear', () => {
    writeModeState('fs-tree', STATE)
    clearModeState('fs-tree')
    expect(readModeState('fs-tree')).toBeNull()
  })

  it('is a no-op when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => writeModeState('fs-tree', STATE)).not.toThrow()
    expect(readModeState('fs-tree')).toBeNull()
  })
})

describe('debounced writer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces a burst into one write', () => {
    const writer = createDebouncedWriter(250)
    for (let i = 0; i < 50; i++) {
      writer.write('fs-tree', { ...STATE, viewport: { x: i, y: 0, scale: 1 } })
    }
    expect(readModeState('fs-tree')).toBeNull()
    vi.advanceTimersByTime(250)
    expect(readModeState('fs-tree')?.viewport.x).toBe(49)
  })

  it('does not lose the outgoing mode when the mode changes', () => {
    const writer = createDebouncedWriter(250)
    writer.write('fs-tree', STATE)
    writer.write('call-graph', emptyModeState())
    expect(readModeState('fs-tree')).toEqual(STATE)
    vi.advanceTimersByTime(250)
    expect(readModeState('call-graph')).toEqual(emptyModeState())
  })

  it('flushes on demand, for the last write before the page goes away', () => {
    const writer = createDebouncedWriter(250)
    writer.write('fs-tree', STATE)
    writer.flush()
    expect(readModeState('fs-tree')).toEqual(STATE)
    // A flushed write must not be replayed by the pending timer.
    vi.advanceTimersByTime(250)
    expect(readModeState('fs-tree')).toEqual(STATE)
  })
})
