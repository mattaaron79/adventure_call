import { describe, expect, it } from 'vitest'
import {
  DRAG_THRESHOLD,
  FIT_PADDING,
  GOTO_DURATION_MS,
  GOTO_ZOOM_FACTOR,
  NODE_DRAG_THRESHOLD,
  TWEEN_DURATION,
  WHEEL_DELTA_CLAMP,
  WHEEL_ZOOM_RATE,
} from './settings'

describe('interaction settings (tic-8ff7)', () => {
  it('softens the goto zoom to about a third of the full fit zoom', () => {
    // The whole point of the ticket: a goto should no longer fill the
    // viewport with a single chip.  ~0.33 is "about a third".
    expect(GOTO_ZOOM_FACTOR).toBeGreaterThan(0.25)
    expect(GOTO_ZOOM_FACTOR).toBeLessThan(0.4)
    // The flight itself still has a positive, human-length duration.
    expect(GOTO_DURATION_MS).toBeGreaterThan(0)
  })

  it('keeps the wheel zoom rate and fit padding as named exports', () => {
    expect(WHEEL_ZOOM_RATE).toBeGreaterThan(0)
    expect(WHEEL_DELTA_CLAMP).toBeGreaterThan(0)
    expect(FIT_PADDING).toBeGreaterThanOrEqual(0)
  })

  it('keeps the drag thresholds and the tween duration as named exports', () => {
    expect(DRAG_THRESHOLD).toBeGreaterThan(0)
    expect(NODE_DRAG_THRESHOLD).toBeGreaterThan(0)
    expect(TWEEN_DURATION).toBeGreaterThan(0)
  })
})
