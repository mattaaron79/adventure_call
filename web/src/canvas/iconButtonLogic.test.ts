import { describe, expect, it } from 'vitest'
import { iconGlyphGeometry, isIconClick, shouldShowGoIn } from './iconButtonLogic'

describe('isIconClick (tic-4d7c)', () => {
  it('counts a still press as a click', () => {
    expect(isIconClick({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(true)
  })

  it('tolerates a small jitter (<= 5px), the same slop as the chips', () => {
    expect(isIconClick({ x: 10, y: 10 }, { x: 13, y: 14 })).toBe(true) // 3,4 -> 25
    expect(isIconClick({ x: 10, y: 10 }, { x: 15, y: 10 })).toBe(true) // exactly 5
    expect(isIconClick({ x: 10, y: 10 }, { x: 5, y: 10 })).toBe(true) // negative direction
  })

  it('rejects a press that travelled far enough to be a drag', () => {
    expect(isIconClick({ x: 0, y: 0 }, { x: 4, y: 4 })).toBe(false) // 32 > 25
    expect(isIconClick({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(false)
  })
})

describe('shouldShowGoIn (tic-4d7c)', () => {
  it('shows the go-into button on any directory except the focused one', () => {
    expect(shouldShowGoIn('src/app', 'src')).toBe(true)
    expect(shouldShowGoIn('src/app', '')).toBe(true)
  })

  it('hides it when the target equals the active focus path', () => {
    expect(shouldShowGoIn('src/app', 'src/app')).toBe(false)
    // The whole-graph root (focusTo '') hides its button while focused.
    expect(shouldShowGoIn('', '')).toBe(false)
  })

  it('hides it on nodes that carry no focus target', () => {
    expect(shouldShowGoIn(undefined, '')).toBe(false)
    expect(shouldShowGoIn(undefined, 'src/app')).toBe(false)
  })
})

describe('iconGlyphGeometry (tic-4d7c)', () => {
  it('centres a 16x16 glyph inside the hit target, scaled to ~72% of it', () => {
    const g = iconGlyphGeometry(18)
    expect(g.scale).toBeCloseTo(0.81) // 18 * 0.72 / 16
    expect(g.x).toBeCloseTo(2.52) // (18 - 18*0.72) / 2
    expect(g.y).toBeCloseTo(2.52)
  })

  it('always keeps the glyph strictly inside the target', () => {
    for (const size of [14, 18, 24, 32]) {
      const g = iconGlyphGeometry(size)
      const glyph = 16 * g.scale
      expect(glyph).toBeLessThan(size)
      expect(g.x + glyph).toBeLessThanOrEqual(size)
      expect(g.y + glyph).toBeLessThanOrEqual(size)
    }
  })
})
