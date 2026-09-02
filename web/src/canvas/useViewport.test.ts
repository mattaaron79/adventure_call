import { describe, expect, it } from 'vitest'
import { DBLCLICK_MS } from '../settings'
import { isEmptyDoubleClick } from './useViewport'

describe('isEmptyDoubleClick (tic-1250)', () => {
  it('is false for the first click, which has no predecessor', () => {
    expect(isEmptyDoubleClick(null, 1000, false)).toBe(false)
    expect(isEmptyDoubleClick(null, 1000, true)).toBe(false)
  })

  it('is true when the second click lands inside the window with the same modifier', () => {
    expect(isEmptyDoubleClick({ time: 1000, shift: false }, 1000 + DBLCLICK_MS, false)).toBe(true)
    expect(isEmptyDoubleClick({ time: 1000, shift: false }, 1000 + DBLCLICK_MS - 1, false)).toBe(true)
    expect(isEmptyDoubleClick({ time: 1000, shift: true }, 1000 + DBLCLICK_MS, true)).toBe(true)
  })

  it('is false when the second click lands outside the window', () => {
    expect(isEmptyDoubleClick({ time: 1000, shift: false }, 1000 + DBLCLICK_MS + 1, false)).toBe(
      false,
    )
  })

  it('is false when the clicks are far apart in time', () => {
    expect(isEmptyDoubleClick({ time: 0, shift: false }, 10_000, false)).toBe(false)
  })

  it('is false when the Shift state differs between the two clicks', () => {
    // A plain double-click and a shift+double-click are different gestures
    // (tic-0961): the shift one flies to the nearest line's source, so the two
    // must not seed each other's window.
    expect(isEmptyDoubleClick({ time: 1000, shift: false }, 1000 + DBLCLICK_MS, true)).toBe(false)
    expect(isEmptyDoubleClick({ time: 1000, shift: true }, 1000 + DBLCLICK_MS, false)).toBe(false)
  })
})
