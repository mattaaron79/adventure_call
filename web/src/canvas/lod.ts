/**
 * Zoom-threshold level of detail (tic-fa56).
 *
 * A single number the canvas and the modes both read, so text thinning and
 * container collapsing happen on the same thresholds and only ever re-render
 * when a threshold is crossed -- never per pan/zoom frame.
 *
 *   0  everything: labels, sublabels, rows, import lines
 *   1  sublabels dropped (they are the first thing that stops being legible)
 *   2  labels dropped too; shapes and structure only, import lines dropped
 *   3  extreme zoom-out: expanded containers collapse to their summary chip
 */
export type Lod = 0 | 1 | 2 | 3

/** Below this scale, sublabels disappear. */
export const LOD_SUBLABEL = 0.6
/** Below this scale, labels disappear as well. */
export const LOD_LABEL = 0.35
/** Below this scale, expanded containers collapse to summary chips. */
export const LOD_SUMMARY = 0.15

export function lodOf(scale: number): Lod {
  if (scale >= LOD_SUBLABEL) return 0
  if (scale >= LOD_LABEL) return 1
  if (scale >= LOD_SUMMARY) return 2
  return 3
}
