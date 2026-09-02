/**
 * Interaction settings for the workspace camera and gestures (tic-8ff7).
 *
 * Every tunable that shapes how the canvas feels -- wheel zoom sensitivity,
 * fit-to-content padding, the goto flight's zoom and duration, gesture drag
 * thresholds, and node-move tweens -- lives here as a single named export, so
 * adjusting the feel of the camera is a one-line edit by a human instead of a
 * hunt through viewport maths and event handlers.  Consumers import these
 * constants; they never inline their own numbers.
 *
 * Kept dependency-free (plain `const` exports) so any module -- pure viewport
 * maths, React hooks, components -- can read them without pulling in a frame.
 */

/** Duration of the goto flight, in milliseconds (ease-out cubic). */
export const GOTO_DURATION_MS = 250

/**
 * Two clicks on the same thing inside this window count as a double-click
 * (tic-1250).  Shared by the node double-click that expands/contracts a
 * workspace object (tic-3430) and the empty-canvas double-click that flies the
 * camera to the nearest line's target.
 */
export const DBLCLICK_MS = 350

/**
 * How far a goto zooms in relative to a full fit-to-rect scale.
 *
 * A goto used to rise to the full fit scale, which fills the viewport with a
 * single chip -- far too close.  This factor lands the camera at about a
 * third of that, leaving the surrounding context visible at a comfortable
 * middle distance.  Named for what it means rather than its value, so the
 * next adjustment is a one-line edit here, not a hunt for 'MAGIC_0_33'.
 */
export const GOTO_ZOOM_FACTOR = 0.33

/**
 * Wheel zoom sensitivity: the pixel-delta divisor in the exponential zoom
 * factor.  Larger values make each wheel notch change the scale less.
 */
export const WHEEL_ZOOM_RATE = 320

/**
 * Wheel deltas beyond this many pixels are clamped before they are scaled, so
 * a single violent flick (or a line/page-mode wheel event) cannot cross the
 * whole zoom range in one notch.
 */
export const WHEEL_DELTA_CLAMP = 120

/** Screen padding kept around content when framing it (fit-to-content and
 *  the goto's fit floor), in CSS pixels. */
export const FIT_PADDING = 48

/**
 * How far the pointer must move (px) before an empty-space drag counts as a
 * pan/marquee rather than a click; trackpads are twitchy.
 */
export const DRAG_THRESHOLD = 3

/**
 * How far a press must travel (px, as a radius) before it is a drag instead
 * of a click -- used by the chip click discrimination and the on-canvas icon
 * button alike.  The squared comparison at call sites is this value squared.
 */
export const NODE_DRAG_THRESHOLD = 5

/** Duration of the Konva tween that glides a node to its new position after a
 *  re-layout (expansion, collapse, relayout), in seconds. */
export const TWEEN_DURATION = 0.2

/**
 * How close the pointer must come to a connection line, in SCREEN pixels,
 * before the near-pointer connection summary picks it up (tic-f1d7).
 *
 * Screen pixels rather than world units on purpose: the query converts this
 * by the camera scale, so the pick area stays the same size under the cursor
 * whether the graph is zoomed right in or pulled all the way out.  32 is the
 * figure the feature was specified to start at -- generous enough that a 1px
 * line does not have to be hit exactly, tight enough that it does not sweep
 * up half a bundle.  Tune here.
 */
export const EDGE_HOVER_RADIUS_PX = 32

/**
 * How many connections the near-pointer summary lists before it stops and
 * counts the rest (tic-f1d7, raised for tic-260c).
 *
 * Over a merged trunk (tic-531b) the query legitimately finds dozens of lines
 * at nearly the same distance -- which is exactly when the summary is worth
 * having -- so it has to have a stopping point, or a dense bundle papers the
 * popup over the canvas it is describing.
 *
 * 8 truncated more often than a stopping point should.  Counting connections
 * per node on the ../carnot export -- a layout-free proxy for what a pointer
 * finds, since it bounds what one chip's lines can contribute to a bundle --
 * 7.3% of call-flow nodes and 9.1% of import-graph nodes carry more than 8,
 * so the popup was ending in "+N more" on roughly one busy line in twelve.
 * At 20 that is 0% and 3.3%: truncation stops happening at all in call flow
 * and becomes a hub-file event in the import graph, which is the case the cap
 * was written for.
 *
 * The cost of the raise is height -- twenty ellipsised lines is around 350px
 * against the old ~150px -- which is why the popup's flip-near-the-edge
 * threshold is derived from the line count rather than the constant it used
 * to assume.  See `Workspace.tsx`'s `edgePopup` block.
 */
export const EDGE_POPUP_MAX_LINES = 20
