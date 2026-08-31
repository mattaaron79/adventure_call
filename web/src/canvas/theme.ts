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
  /** Import lines, and the highlight for an import edge incident to the
   *  selection/hover (tic-5393).  Same blue as the module kind: imports
   *  connect modules, so a lit line reads as "this is what I import". */
  import: '#89b4fa',
} as const

export const KIND_COLOR: Record<SymbolKind, string> = {
  module: '#89b4fa',
  class: '#a6e3a1',
  function: '#f9e2af',
  method: '#fab387',
  variable: '#cba6f7',
  attribute: '#cba6f7',
}
