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
import { FIT_PADDING, GOTO_ZOOM_FACTOR, WHEEL_DELTA_CLAMP, WHEEL_ZOOM_RATE } from '../settings'

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
  const clamped = Math.max(-WHEEL_DELTA_CLAMP, Math.min(WHEEL_DELTA_CLAMP, deltaY))
  return Math.exp(-clamped / WHEEL_ZOOM_RATE)
}

export function translate(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, x: vp.x + dx, y: vp.y + dy }
}

/** The viewport that centres `rect` in `size` with `padding` screen px around it. */
export function fitToRect(rect: Rect, size: Size, padding = FIT_PADDING): Viewport {
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

/** True when two sizes are equal (tic-de05).  A measurement effect can use
 *  this to bail out of its state update when the size did not change -- a
 *  fresh `{width,height}` object every time would never be `Object.is`-equal,
 *  so `setState` would schedule a render on every pass and re-trigger the
 *  effect that measured it, looping past React's update-depth limit. */
export function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height
}

/** Options for {@link centerOn}. */
export interface CenterOnOptions {
  /** Screen padding around the target rect, in CSS px. */
  padding?: number
  /**
   * Zoom to a "comfortable minimum" when the current scale would show the
   * target smaller than that. Pan-only when false.
   */
  zoom?: boolean
  /**
   * How much of the fit-to-rect scale a zoom lands on, as a fraction of it.
   * Defaults to {@link GOTO_ZOOM_FACTOR}, the goto's softened ~1/3 landing
   * zoom, so a caller that wants a different landing just passes one.
   */
  zoomFactor?: number
}

/**
 * The viewport that centres `rect` in `size` while keeping the current zoom
 * (tic-bee0).  Reuses the fitToRect maths rather than writing new projection
 * code, so a goto agrees with fit-to-content.  By default it pans without
 * touching the scale, so the user keeps their bearings; with `zoom` the scale
 * rises towards the fit-to-rect scale -- softened by {@link GOTO_ZOOM_FACTOR}
 * (about a third, so the flight lands with context visible) -- whenever the
 * current scale shows the target smaller.  The rise is a floor: it only ever
 * zooms in, never out past the user's current zoom (tic-8ff7).
 */
export function centerOn(vp: Viewport, rect: Rect, size: Size, opts: CenterOnOptions = {}): Viewport {
  const { padding = FIT_PADDING, zoom = false } = opts
  let scale = vp.scale
  if (zoom) {
    const target = fitToRect(rect, size, padding).scale * (opts.zoomFactor ?? GOTO_ZOOM_FACTOR)
    scale = clampScale(Math.max(scale, target))
  }
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return { scale, x: size.width / 2 - cx * scale, y: size.height / 2 - cy * scale }
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
