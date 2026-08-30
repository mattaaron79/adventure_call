/**
 * Grid spacing.  Pure so the ladder can be unit-tested; the drawing lives in
 * Grid.tsx (the file names differ so Windows does not fold them together).
 */

/** 1-2-5 per decade, the ladder chart axes use, over the whole scale range. */
export const GRID_STEPS: readonly number[] = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000,
]

/** Every fifth dot is drawn brighter, so the tile is a 5x5 block of dots. */
export const MAJOR_EVERY = 5

export const MIN_DOT_SPACING = 18

/**
 * The world-space distance between dots at this zoom: the coarsest-but-one
 * ladder entry whose on-screen spacing still clears {@link MIN_DOT_SPACING}.
 * Zooming out therefore drops a level rather than turning the grid into fog.
 */
export function gridStep(scale: number, minSpacing = MIN_DOT_SPACING): number {
  if (!Number.isFinite(scale) || scale <= 0) return GRID_STEPS[0]
  for (const step of GRID_STEPS) {
    if (step * scale >= minSpacing) return step
  }
  return GRID_STEPS[GRID_STEPS.length - 1]
}

/** Positive remainder; `%` in JS keeps the sign of the dividend, and the grid
 *  phase has to stay in [0, period) as the viewport crosses the origin. */
export function wrap(value: number, period: number): number {
  if (period <= 0) return 0
  return ((value % period) + period) % period
}
