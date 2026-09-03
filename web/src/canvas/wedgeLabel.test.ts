import { describe, expect, it } from 'vitest'
import {
  BUTTON_MIN_SPAN,
  isHubWedge,
  wedgeChord,
  wedgeLabelFit,
  wedgeLabelWidth,
} from './wedgeLabel'

/** A wedge of the given radii/span, centred at the origin like the sunburst. */
const wedge = (
  innerRadius: number,
  outerRadius: number,
  span: number,
  start = -Math.PI / 2,
) => ({
  cx: 0,
  cy: 0,
  innerRadius,
  outerRadius,
  start,
  end: start + span,
})

/** The span whose chord at the ring's mid radius equals `chord`. */
const spanForChord = (inner: number, outer: number, chord: number): number =>
  2 * Math.asin(chord / (inner + outer))

describe('isHubWedge / wedgeChord', () => {
  it('calls the inner-radius-zero disk the hub', () => {
    expect(isHubWedge({ innerRadius: 0 })).toBe(true)
    expect(isHubWedge({ innerRadius: 120 })).toBe(false)
  })

  it('measures the chord across the arc at the mid radius', () => {
    // A 90-degree slice at mid radius 300 has chord 300*sqrt(2).
    expect(wedgeChord(wedge(240, 360, Math.PI / 2))).toBeCloseTo(300 * Math.SQRT2, 9)
    // A full circle has no straight chord: sin(pi) is 0.
    expect(wedgeChord(wedge(0, 120, Math.PI * 2))).toBeCloseTo(0, 9)
  })
})

describe('wedgeLabelFit', () => {
  it('always fits a label on the hub disk, never an affordance icon', () => {
    const fit = wedgeLabelFit(wedge(0, 120, Math.PI * 2), false)
    expect(fit.hub).toBe(true)
    expect(fit.label).toBe(true)
    expect(fit.sublabel).toBe(true)
    expect(fit.button).toBe(false)
  })

  it('labels a slice whose span, chord and thickness clear the floors', () => {
    // 90 degrees, ring 240..360 thick, chord 300*sqrt(2) ~ 424.
    const fit = wedgeLabelFit(wedge(240, 360, Math.PI / 2), false)
    expect(fit.hub).toBe(false)
    expect(fit.label).toBe(true)
    expect(fit.sublabel).toBe(true)
  })

  it('keeps a thin, narrow slice anonymous at normal lod', () => {
    // Span 0.1 < 0.16 and a short chord, so no label at lod 1.
    const fit = wedgeLabelFit(wedge(60, 120, 0.1), false)
    expect(fit.label).toBe(false)
    expect(fit.sublabel).toBe(false)
  })

  it('sizes the affordance-icon gate by span alone once the ring is thick', () => {
    // A thin ring is still plenty thick for a sunburst (RING_THICKNESS 120);
    // the icon floor is the angular span.
    const fit = wedgeLabelFit(wedge(60, 180, 0.34), false)
    expect(fit.button).toBe(0.34 >= BUTTON_MIN_SPAN)
    const narrow = wedgeLabelFit(wedge(60, 180, 0.2), false)
    expect(narrow.button).toBe(false)
  })

  it('reveals more slices at lod 0 by dropping the label floors', () => {
    // A far-out outer slice (large radius, so a big chord even at small span):
    // span 0.1 fails the normal 0.16 floor but clears the 0.09 lod-0 floor.
    const atLod1 = wedgeLabelFit(wedge(1200, 1320, 0.1), false)
    expect(atLod1.label).toBe(false)
    const atLod0 = wedgeLabelFit(wedge(1200, 1320, 0.1), true)
    expect(atLod0.label).toBe(true)
  })

  it('needs extra chord for the sublabel line over the name alone', () => {
    // Chord between the name floor (60) and the sublabel floor (70): a name
    // fits, the second line does not.
    const fit = wedgeLabelFit(wedge(180, 300, spanForChord(180, 300, 64)), false)
    expect(fit.label).toBe(true)
    expect(fit.sublabel).toBe(false)
  })
})

describe('wedgeLabelWidth', () => {
  it('runs the hub label up to nearly the disk diameter', () => {
    // outer 120 -> 2*120 - 32 = 208.
    expect(wedgeLabelWidth(wedge(0, 120, Math.PI * 2))).toBeCloseTo(208, 9)
  })

  it('caps an annulus label at its chord, never past 220', () => {
    const w = wedge(120, 360, Math.PI / 2) // mid 240, chord ~ 339
    expect(wedgeLabelWidth(w)).toBeCloseTo(Math.min(2 * 240 * Math.sin(Math.PI / 4), 220), 9)
    // A giant slice caps at 220.
    const giant = wedge(120, 600, Math.PI * 1.4) // chord > 220
    expect(wedgeLabelWidth(giant)).toBe(220)
  })
})
