/**
 * Label-fit geometry for the sunburst's annular-sector nodes (tic-bc09).
 *
 * A wedge can host text only when it actually has room: a wide enough angular
 * span, a chord (the straight distance across the arc at the ring's mid
 * radius) long enough to hold a line, and a ring thick enough that the text
 * does not spill over the arc's neighbours.  Those are the same numbers
 * WedgeNode guessed inline before this ticket; extracting them here -- pure,
 * canvas-owned, unit-testable -- is what lets the label thresholds and the
 * lod-0 "reveal" behave as one rule instead of a JSX constant.
 *
 * The innermost slice is a full disk (the hub), not an annulus: its "chord" is
 * meaningless (a full circle has none), yet a disk has the most room of any
 * slice for a centred label -- which is exactly the zoomed-scope label this
 * ticket is about.  So the hub is special-cased to always fit its text.
 *
 * Follows the same LOD spirit as the chips (tic-fa56): at lod 0 the camera is
 * fully zoomed in, so the floors drop and the thin outer file slices that a
 * real codebase is full of reveal their names instead of staying anonymous.
 */
import type { WedgeGeom } from './scene'

/** A ring slice needs at least this angular span (radians) for a name. */
export const LABEL_MIN_SPAN = 0.16
/** ...a chord this long (world units) for the line itself. */
export const LABEL_MIN_CHORD = 60
/** ...and a ring this thick (world units). */
export const LABEL_MIN_THICKNESS = 26

/** At lod 0 the floors drop so more slices can be read (tic-fa56 spirit). */
export const LABEL_REVEAL_SPAN = 0.09
export const LABEL_REVEAL_CHORD = 40
export const LABEL_REVEAL_THICKNESS = 18

/** A second (sublabel) line stacked under the name wants a touch more room. */
export const SUBLABEL_MIN_CHORD = 70
export const SUBLABEL_MIN_THICKNESS = 48

/** An 18px affordance icon on a wedge needs at least this span and thickness. */
export const BUTTON_MIN_SPAN = 0.32
export const BUTTON_MIN_THICKNESS = 34

export interface WedgeLabelFit {
  /** The slice can host a single-line name at its midpoint. */
  label: boolean
  /** It can also host a second (sublabel) line beneath the name. */
  sublabel: boolean
  /** It is big enough to host the 18px affordance icon. */
  button: boolean
  /** The slice is the innermost full disk (the hub), not an annulus. */
  hub: boolean
}

/** True when the wedge is the innermost full disk (depth 0 in a sunburst). */
export function isHubWedge(w: Pick<WedgeGeom, 'innerRadius'>): boolean {
  return w.innerRadius === 0
}

/** The straight-line chord across the arc at the ring's mid radius. */
export function wedgeChord(w: WedgeGeom): number {
  const mid = (w.innerRadius + w.outerRadius) / 2
  return 2 * mid * Math.sin((w.end - w.start) / 2)
}

/**
 * What this wedge can host.  `reveal` (lod 0) relaxes the label floors so the
 * small outer slices of a real codebase get names when the camera is in close
 * enough to read them; the affordance-icon and hub rules do not change.
 */
export function wedgeLabelFit(w: WedgeGeom, reveal: boolean): WedgeLabelFit {
  if (isHubWedge(w)) {
    return { label: true, sublabel: true, button: false, hub: true }
  }
  const span = w.end - w.start
  const thickness = w.outerRadius - w.innerRadius
  const chord = wedgeChord(w)
  const minSpan = reveal ? LABEL_REVEAL_SPAN : LABEL_MIN_SPAN
  const minChord = reveal ? LABEL_REVEAL_CHORD : LABEL_MIN_CHORD
  const minThickness = reveal ? LABEL_REVEAL_THICKNESS : LABEL_MIN_THICKNESS
  const label = span >= minSpan && chord >= minChord && thickness >= minThickness
  const sublabel = label && chord >= SUBLABEL_MIN_CHORD && thickness >= SUBLABEL_MIN_THICKNESS
  const button = span >= BUTTON_MIN_SPAN && thickness >= BUTTON_MIN_THICKNESS
  return { label, sublabel, button, hub: false }
}

/** How wide a wedge's label line may run, before Konva ellipsises it. */
export function wedgeLabelWidth(w: WedgeGeom): number {
  // The hub is a disk: the line may run up to its diameter (minus a margin),
  // which is the whole point of a centred hub label.
  if (isHubWedge(w)) return Math.max(0, w.outerRadius * 2 - 32)
  return Math.min(wedgeChord(w), 220)
}
