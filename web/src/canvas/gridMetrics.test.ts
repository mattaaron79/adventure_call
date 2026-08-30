import { describe, expect, it } from 'vitest'
import { GRID_STEPS, MIN_DOT_SPACING, gridStep, wrap } from './gridMetrics'
import { MAX_SCALE, MIN_SCALE } from './viewport'

describe('gridStep', () => {
  it('never lets the dots crowd closer than the minimum', () => {
    for (let scale = MIN_SCALE; scale <= MAX_SCALE; scale *= 1.07) {
      expect(gridStep(scale) * scale).toBeGreaterThanOrEqual(MIN_DOT_SPACING)
    }
  })

  it('picks the finest ladder entry that clears it', () => {
    for (const scale of [0.03, 0.2, 1, 2.5, 8]) {
      const step = gridStep(scale)
      const finer = GRID_STEPS[GRID_STEPS.indexOf(step) - 1]
      if (finer !== undefined) expect(finer * scale).toBeLessThan(MIN_DOT_SPACING)
    }
  })

  it('steps up as the camera pulls back', () => {
    expect(gridStep(0.05)).toBeGreaterThan(gridStep(1))
    expect(gridStep(1)).toBeGreaterThanOrEqual(gridStep(8))
  })

  it('survives a degenerate scale', () => {
    expect(gridStep(0)).toBe(GRID_STEPS[0])
    expect(gridStep(Number.NaN)).toBe(GRID_STEPS[0])
  })
})

describe('wrap', () => {
  it('stays in [0, period) on both sides of the origin', () => {
    expect(wrap(-1, 40)).toBe(39)
    expect(wrap(-40, 40)).toBe(0)
    expect(wrap(41, 40)).toBe(1)
    expect(wrap(0, 40)).toBe(0)
  })

  it('is a no-op for a zero period', () => {
    expect(wrap(17, 0)).toBe(0)
  })
})
