import { describe, expect, it } from 'vitest'
import {
  DRAG_THRESHOLD,
  EDGE_POPUP_MAX_LINES,
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

describe('near-pointer summary cap (tic-f1d7, raised for tic-260c)', () => {
  it('clears the busiest node the call-flow mode actually draws', () => {
    // Not a mirror of the constant: 18 is the highest connection count on any
    // node of ../carnot's call-flow overview, so a cap below it would truncate
    // in the very mode the raise was for.  It stayed at 8 for two tickets
    // after call flow shipped, ending in "+N more" on one busy line in twelve.
    expect(EDGE_POPUP_MAX_LINES).toBeGreaterThanOrEqual(18)
  })

  it('still has a stopping point, because a merged trunk has no bound', () => {
    // The import graph's hub files reach 105 (tic-531b merges them into one
    // trunk).  Listing those would paper the popup over the canvas it is
    // describing, which is the whole reason a cap exists.
    expect(EDGE_POPUP_MAX_LINES).toBeLessThan(105)
  })
})
