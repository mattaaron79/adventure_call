/**
 * The pure logic behind the shared on-canvas icon button (tic-4d7c).
 *
 * Kept free of React and Konva so the behaviour the ticket cares about --
 * hover isolation, click-vs-drag discrimination, hiding the go-into button on
 * the focused folder, and glyph geometry -- is unit-testable in the node test
 * environment, matching the rest of the codebase.
 */
import { NODE_DRAG_THRESHOLD } from '../settings'

/** A point in client coordinates. */
export interface IconPoint {
  x: number
  y: number
}

/**
 * Whether a pointer press/release pair counts as a click on an on-canvas icon
 * button (tic-4d7c).  Mirrors the chip's own click discrimination: a press
 * that travels more than {@link NODE_DRAG_THRESHOLD} is a drag, not a click.
 * Because the button also stops propagation and prevents default, a press
 * that becomes a drag never arms the chip it sits on -- so dragging a folder
 * chip by its body keeps working with the button sitting on its edge.
 */
export function isIconClick(down: IconPoint, up: IconPoint): boolean {
  const dx = up.x - down.x
  const dy = up.y - down.y
  return dx * dx + dy * dy <= NODE_DRAG_THRESHOLD ** 2
}

/**
 * Whether a 'go into' affordance should be shown for a node carrying
 * `focusTo`: shown for every directory except the one the scene is currently
 * scoped to -- there is nowhere to go into from the folder you are already in
 * (tic-e7d2 / tic-4d7c).
 */
export function shouldShowGoIn(focusTo: string | undefined, focusPath: string): boolean {
  return focusTo !== undefined && focusTo !== focusPath
}

/**
 * Geometry to centre a 16x16-viewBox glyph inside a `size` hit target: the
 * uniform scale and the top-left offset.  `fraction` is how much of the target
 * the glyph should occupy, so a `size`-square button draws a slightly smaller
 * glyph in its middle instead of filling the whole target.
 */
export function iconGlyphGeometry(size: number, fraction = 0.72): { scale: number; x: number; y: number } {
  const glyph = size * fraction
  return { scale: glyph / 16, x: (size - glyph) / 2, y: (size - glyph) / 2 }
}
