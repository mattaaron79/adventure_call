import { describe, expect, it } from 'vitest'
import { DBLCLICK_MS } from '../settings'
import { isEmptyDoubleClick } from './useViewport'

describe('isEmptyDoubleClick (tic-1250)', () => {
  it('is false for the first click, which has no predecessor', () => {
    expect(isEmptyDoubleClick(null, 1000)).toBe(false)
  })

  it('is true when the second click lands inside the window', () => {
    expect(isEmptyDoubleClick(1000, 1000 + DBLCLICK_MS)).toBe(true)
    expect(isEmptyDoubleClick(1000, 1000 + DBLCLICK_MS - 1)).toBe(true)
  })

  it('is false when the second click lands outside the window', () => {
    expect(isEmptyDoubleClick(1000, 1000 + DBLCLICK_MS + 1)).toBe(false)
  })

  it('is false when the clicks are far apart in time', () => {
    expect(isEmptyDoubleClick(0, 10_000)).toBe(false)
  })
})