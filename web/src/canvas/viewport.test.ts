import { describe, expect, it } from 'vitest'
import { GOTO_ZOOM_FACTOR } from '../settings'
import {
  MAX_SCALE,
  MIN_SCALE,
  centerOn,
  clampScale,
  fitToRect,
  rectFromCorners,
  rectsIntersect,
  screenToWorld,
  translate,
  unionRects,
  visibleWorldRect,
  wheelZoomFactor,
  worldToScreen,
  zoomAt,
} from './viewport'

const VP = { x: 137, y: -62, scale: 0.7 }

describe('screen <-> world', () => {
  it('round trips', () => {
    const world = { x: -412.5, y: 908.25 }
    const back = screenToWorld(VP, worldToScreen(VP, world))
    expect(back.x).toBeCloseTo(world.x, 9)
    expect(back.y).toBeCloseTo(world.y, 9)
  })

  it('places the world origin at the viewport offset', () => {
    expect(worldToScreen(VP, { x: 0, y: 0 })).toEqual({ x: 137, y: -62 })
  })
})

describe('zoomAt', () => {
  it('keeps the point under the cursor fixed', () => {
    const pointer = { x: 300, y: 220 }
    const before = screenToWorld(VP, pointer)
    for (const factor of [1.6, 0.4, 1.05]) {
      const after = screenToWorld(zoomAt(VP, pointer, factor), pointer)
      expect(after.x).toBeCloseTo(before.x, 9)
      expect(after.y).toBeCloseTo(before.y, 9)
    }
  })

  it('stays anchored when the factor is clamped away', () => {
    // The naive implementation -- solve, then clamp -- slides the scene here.
    const pointer = { x: 640, y: 400 }
    const hot = { x: 10, y: 10, scale: MAX_SCALE }
    const zoomed = zoomAt(hot, pointer, 4)
    expect(zoomed).toBe(hot)

    const cold = { x: 10, y: 10, scale: MIN_SCALE * 1.2 }
    const out = zoomAt(cold, pointer, 0.1)
    expect(out.scale).toBe(MIN_SCALE)
    expect(screenToWorld(out, pointer).x).toBeCloseTo(screenToWorld(cold, pointer).x, 6)
    expect(screenToWorld(out, pointer).y).toBeCloseTo(screenToWorld(cold, pointer).y, 6)
  })

  it('clamps to the scale range', () => {
    expect(clampScale(1e9)).toBe(MAX_SCALE)
    expect(clampScale(0)).toBe(MIN_SCALE)
    expect(clampScale(Number.NaN)).toBe(1)
  })
})

describe('wheelZoomFactor', () => {
  it('zooms in on a scroll up and out on a scroll down', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100)).toBeLessThan(1)
    expect(wheelZoomFactor(0)).toBe(1)
  })

  it('bounds a single violent event', () => {
    // Line- and page-mode wheels report absurd deltas; one must not cross the
    // whole zoom range.
    expect(wheelZoomFactor(-100_000)).toBeLessThan(1.5)
    expect(wheelZoomFactor(100_000)).toBeGreaterThan(0.66)
  })
})

describe('fitToRect', () => {
  const size = { width: 800, height: 600 }

  it('centres the rect', () => {
    const rect = { x: -200, y: 40, width: 400, height: 100 }
    const vp = fitToRect(rect, size)
    const centre = worldToScreen(vp, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
    expect(centre.x).toBeCloseTo(400, 9)
    expect(centre.y).toBeCloseTo(300, 9)
  })

  it('fits both axes inside the padding', () => {
    const rect = { x: 0, y: 0, width: 4000, height: 200 }
    const vp = fitToRect(rect, size, 48)
    expect(rect.width * vp.scale).toBeLessThanOrEqual(size.width - 96 + 1e-9)
    expect(rect.height * vp.scale).toBeLessThanOrEqual(size.height - 96 + 1e-9)
  })

  it('does not exceed the scale range on a tiny or vast scene', () => {
    expect(fitToRect({ x: 0, y: 0, width: 1, height: 1 }, size).scale).toBe(MAX_SCALE)
    expect(fitToRect({ x: 0, y: 0, width: 1e7, height: 1e7 }, size).scale).toBe(MIN_SCALE)
  })
})

describe('centerOn', () => {
  const size = { width: 800, height: 600 }

  it('pans so the rect is centred without touching the scale', () => {
    const vp = { x: 10, y: -20, scale: 1 }
    const rect = { x: 100, y: 50, width: 40, height: 20 }
    const out = centerOn(vp, rect, size)
    expect(out.scale).toBe(1)
    expect(worldToScreen(out, { x: 120, y: 60 })).toEqual({ x: 400, y: 300 })
  })

  it('zooms to a softened comfortable floor only when asked, without zooming out', () => {
    const vp = { x: 0, y: 0, scale: 0.2 }
    const rect = { x: 0, y: 0, width: 100, height: 100 }
    // Pan-only keeps the user's zoom.
    expect(centerOn(vp, rect, size).scale).toBe(0.2)
    // Zoom rises towards the fit-to-rect scale, softened to ~1/3 of it, and
    // the rect is centred.
    const zoomed = centerOn(vp, rect, size, { zoom: true })
    expect(zoomed.scale).toBeCloseTo(fitToRect(rect, size).scale * GOTO_ZOOM_FACTOR)
    // The landing is about a third of the full fit zoom: a goto no longer
    // fills the viewport with a single chip.
    expect(zoomed.scale).toBeLessThan(fitToRect(rect, size).scale * 0.5)
    const c = worldToScreen(zoomed, { x: 50, y: 50 })
    expect(c.x).toBeCloseTo(400, 6)
    expect(c.y).toBeCloseTo(300, 6)
    // Already zoomed in further than a comfortable fit: never zoom out.
    const hot = { x: 0, y: 0, scale: 6 }
    expect(centerOn(hot, rect, size, { zoom: true }).scale).toBe(6)
    // Even a softened target below the user's zoom never zooms out.
    const cozy = { x: 0, y: 0, scale: 3 }
    expect(centerOn(cozy, rect, size, { zoom: true }).scale).toBe(3)
  })

  it('clamps the softened target to the scale range like everything else', () => {
    const vp = { x: 0, y: 0, scale: 1 }
    // An aggressive zoomFactor still cannot escape the scale bounds.
    const out = centerOn(vp, { x: 0, y: 0, width: 1, height: 1 }, size, {
      zoom: true,
      zoomFactor: 4,
    })
    expect(out.scale).toBe(MAX_SCALE)
  })
})

describe('rects', () => {
  it('reports what the camera can see', () => {
    const vp = { x: -100, y: -50, scale: 2 }
    expect(visibleWorldRect(vp, { width: 800, height: 600 })).toEqual({
      x: 50,
      y: 25,
      width: 400,
      height: 300,
    })
  })

  it('normalises a drag made in any direction', () => {
    expect(rectFromCorners({ x: 90, y: 80 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 60,
    })
  })

  it('treats a shared edge as no overlap', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 }
    expect(rectsIntersect(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false)
    expect(rectsIntersect(a, { x: 9.9, y: 0, width: 10, height: 10 })).toBe(true)
  })

  it('unions, and reports null for nothing', () => {
    expect(unionRects([])).toBeNull()
    expect(
      unionRects([
        { x: 10, y: 10, width: 5, height: 5 },
        { x: -4, y: 30, width: 2, height: 2 },
      ]),
    ).toEqual({ x: -4, y: 10, width: 19, height: 22 })
  })

  it('translates without touching the scale', () => {
    expect(translate(VP, 10, -10)).toEqual({ x: 147, y: -72, scale: 0.7 })
  })
})
