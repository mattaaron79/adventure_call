/**
 * Canvas colours.
 *
 * Konva paints into a canvas, where `var(--module)` means nothing, so the
 * palette is duplicated here as literals.  Keep in step with styles.css.
 */
import type { SymbolKind } from '../data/types'

export const THEME = {
  surface: '#181825',
  surface2: '#1e1e2e',
  line: '#313244',
  text: '#cdd6f4',
  textDim: '#a6adc8',
  textFaint: '#6c7086',
  accent: '#89b4fa',
  dir: '#94e2d5',
  gridMinor: '#2a2b3c',
  gridMajor: '#3d3f57',
  /** Selection, hover and the rubber band all read as "the accent, louder". */
  selected: '#89b4fa',
  hovered: '#7f849c',
  edge: '#45475a',
  /**
   * The blue shared with the module kind and the selection accent (tic-5393).
   * Lit connection edges no longer recolor -- they keep their own stroke
   * colour (tic-b864) -- so this entry is palette documentation: `accent` and
   * `KIND_COLOR.module` carry the same blue where it is actually applied.
   */
  import: '#89b4fa',
  /**
   * A lavender accent, once drawn on the single nearest connection line under
   * the cursor on empty canvas (tic-1250).  The nearest line now keeps its own
   * stroke colour like any other lit line (tic-b864), so this entry is retained
   * as palette documentation rather than applied.
   */
  nearest: '#b4befe',
  /** A file or edge inside an honest import cycle (tic-56b2): the one warm
   *  colour against an otherwise cool palette, so a cycle reads as worth
   *  noticing rather than blending into the ordinary import lines. */
  cycle: '#f38ba8',
  /** The stroke of a notably complex function (tic-d7d1): warm, but a
   *  different warmth from the cycle pink, which keeps its own channel. */
  hairy: '#fab387',
} as const

export const KIND_COLOR: Record<SymbolKind, string> = {
  module: '#89b4fa',
  class: '#a6e3a1',
  function: '#f9e2af',
  method: '#fab387',
  variable: '#cba6f7',
  attribute: '#cba6f7',
}
