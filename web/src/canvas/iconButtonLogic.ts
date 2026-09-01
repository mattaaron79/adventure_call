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

/** Which affordance owns a node's single action slot, if any. */
export type ActionAffordance = 'focus' | 'goto' | 'open-in'

/**
 * Which of the competing affordances a node's one action slot shows
 * (tic-e738).
 *
 * Three things can want it: a focus target on a directory chip (tic-e7d2), a
 * camera goto on an import row (tic-4d7c), and a cross-mode open on a file
 * chip (tic-e738).  No element carries more than one today, which is why one
 * slot is enough -- but "no element does" is not "no element ever will", so
 * the precedence is written down and tested rather than left to whichever
 * JSX branch happens to come first.  A node that genuinely needs two wants a
 * third slot in {@link iconSlots}, not a fight over this one.
 *
 * Focus wins because it is the only one that navigates WITHIN the current
 * view, so losing it would strand the user; goto next, being a camera move
 * rather than a state change; the cross-mode jump last, since it is always
 * reachable from the inspector as well.
 */
export function actionAffordance(
  node: { focusTo?: string; gotoTo?: string; openIn?: unknown },
  focusPath: string,
): ActionAffordance | null {
  if (shouldShowGoIn(node.focusTo, focusPath)) return 'focus'
  if (node.gotoTo !== undefined) return 'goto'
  if (node.openIn !== undefined) return 'open-in'
  return null
}

/** Hit-target size of an on-canvas icon button, and the pitch between two of
 *  them: 18 units of button plus 6 of gap. */
const ICON_SIZE = 18
const ICON_PITCH = 24
/** Gap between the outer button and the node's right edge. */
const ICON_EDGE_GAP = 8
/**
 * Right-edge width the label keeps clear, by how many buttons the node
 * carries.  Hand-tuned rather than derived from the slot pitch: the label is
 * an ellipsised Konva text, and these are the insets at which its "..." stops
 * crowding the button beside it.
 */
const LABEL_INSET = [20, 40, 64]

/**
 * A node this tall or shorter wears its icons vertically centred (tic-ea7b);
 * anything taller pins them to its top-right corner.
 *
 * The two cases are "a chip" and "an expanded container", and height is what
 * separates them: every chip in every mode is 24-40 units tall (rows,
 * directory chips, file chips) while the shortest container is a 36-unit
 * header plus padding and at least one row, so nothing lands near this line.
 * On a container hundreds of units tall, centred means halfway down the box,
 * far from the header the buttons belong to; on a chip, centred is where the
 * eye expects them -- which is where the folder chips have always had them.
 */
export const CENTRED_ICON_MAX_HEIGHT = 56

/** Where a node's icon buttons sit, and how much room they cost its label. */
export interface IconSlots {
  /** x of the source-link button; meaningless when the node has none. */
  source: number
  /** x of the action button -- the focus affordance or the camera goto. */
  action: number
  /** The y every button on this node shares. */
  y: number
  /** Right-edge width the label must leave clear. */
  labelInset: number
}

/**
 * Where the icon buttons go on a node (tic-4d7c / tic-468e / tic-ea7b).
 *
 * Two slots at the right edge, filled outermost first, with the source link
 * always the outer one (tic-ea7b): "open the code" then lands in the same
 * place on every item that offers it, and the action button -- which is a
 * focus affordance on a chip and a camera goto on a row, never both -- sits
 * inboard of it.  A node with only one button puts it in the outer slot
 * rather than leaving a gap where the other would have been.
 *
 * The label inset covers whichever buttons are present so a name is never
 * drawn under one; it is deliberately independent of the zoom LOD that hides
 * the buttons, so the text does not reflow as the camera crosses a threshold.
 */
export function iconSlots(
  width: number,
  height: number,
  hasSource: boolean,
  hasAction: boolean,
): IconSlots {
  const outer = width - ICON_SIZE - ICON_EDGE_GAP
  const inner = outer - ICON_PITCH
  const buttons = (hasSource ? 1 : 0) + (hasAction ? 1 : 0)
  return {
    source: outer,
    action: hasSource ? inner : outer,
    y: height <= CENTRED_ICON_MAX_HEIGHT ? height / 2 - ICON_SIZE / 2 : 4,
    labelInset: LABEL_INSET[buttons],
  }
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
