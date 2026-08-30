/**
 * Viewport maths.
 *
 * The workspace never scales the Konva Stage itself -- the grid and the
 * overlay have to stay in screen space -- so the transform lives here as plain
 * data and is applied to the world layers as `x`/`y`/`scale` props.  Keeping it
 * as pure functions also means the interesting behaviour (zoom stays anchored
 * under the cursor, fit-to-content actually fits) is unit-testable without a
 * canvas.
 *
 * Convention: `screen = world * scale + offset`, y down, no rotation.
 */

export interface Viewport {
  /** Screen-space translation of the world origin, in CSS pixels. */
  x: number
  y: number
  scale: number
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Point, Size {}

export const MIN_SCALE = 0.02
export const MAX_SCALE = 8
export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, scale: 1 }

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

export function worldToScreen(vp: Viewport, world: Point): Point {
  return { x: world.x * vp.scale + vp.x, y: world.y * vp.scale + vp.y }
}

export function screenToWorld(vp: Viewport, screen: Point): Point {
  return { x: (screen.x - vp.x) / vp.scale, y: (screen.y - vp.y) / vp.scale }
}

/**
 * Scale by `factor` while pinning `pointer` (screen space) to the world point
 * currently beneath it.  Clamping the scale first and *then* solving for the
 * offset is what keeps the anchor exact at the ends of the zoom range: solving
 * for an unclamped scale and clamping afterwards makes the scene slide.
 */
export function zoomAt(vp: Viewport, pointer: Point, factor: number): Viewport {
  const scale = clampScale(vp.scale * factor)
  if (scale === vp.scale) return vp
  const world = screenToWorld(vp, pointer)
  return { scale, x: pointer.x - world.x * scale, y: pointer.y - world.y * scale }
}

/** A wheel delta in pixels to a multiplicative zoom factor. */
export function wheelZoomFactor(deltaY: number): number {
  // ~1.1x per notch, continuous for trackpads, and bounded so that one violent
  // flick (or a line/page-mode wheel event) cannot cross the whole range.
  const clamped = Math.max(-120, Math.min(120, deltaY))
  return Math.exp(-clamped / 320)
}

export function translate(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, x: vp.x + dx, y: vp.y + dy }
}

/** The viewport that centres `rect` in `size` with `padding` screen px around it. */
export function fitToRect(rect: Rect, size: Size, padding = 48): Viewport {
  const available = {
    width: Math.max(1, size.width - padding * 2),
    height: Math.max(1, size.height - padding * 2),
  }
  const scale = clampScale(
    Math.min(available.width / Math.max(rect.width, 1), available.height / Math.max(rect.height, 1)),
  )
  return {
    scale,
    x: size.width / 2 - (rect.x + rect.width / 2) * scale,
    y: size.height / 2 - (rect.y + rect.height / 2) * scale,
  }
}

/** The world-space rectangle currently on screen, grown by `margin` world px. */
export function visibleWorldRect(vp: Viewport, size: Size, margin = 0): Rect {
  const topLeft = screenToWorld(vp, { x: 0, y: 0 })
  return {
    x: topLeft.x - margin,
    y: topLeft.y - margin,
    width: size.width / vp.scale + margin * 2,
    height: size.height / vp.scale + margin * 2,
  }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

/** Normalise a drag (which may run right-to-left or bottom-to-top) to a Rect. */
export function rectFromCorners(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    if (r.x < minX) minX = r.x
    if (r.y < minY) minY = r.y
    if (r.x + r.width > maxX) maxX = r.x + r.width
    if (r.y + r.height > maxY) maxY = r.y + r.height
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
