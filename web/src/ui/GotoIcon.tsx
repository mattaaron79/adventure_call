import { emitGoto } from '../data/goto'

/**
 * The crosshair glyph's SVG path data (tic-4d7c).  Shared between the
 * inspector's GotoIcon and the on-canvas import-row goto button so both
 * surfaces draw the same shape from the same data -- the canvas renders it as
 * a Konva Path rather than hand-redrawing it.  Coordinates live in a 16x16
 * viewBox.
 */
export const GOTO_ICON_PATHS = [
  // The circle, drawn as arcs so it is one path data string.
  'M5 8a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  // The four crosshair arms.
  'M8 0v2.5M8 13.5V16M0 8h2.5M13.5 8H16',
]

/**
 * The camera-goto affordance (tic-bee0): a small crosshair that asks the
 * workspace to fly the camera to `target`.  Drawn as a crosshair rather than
 * a caret so it reads as "locate" and stays visually distinct from the
 * expand/collapse chevrons it sits beside.  It is a separate element from the
 * row it appears in and stops propagation, so activating it never triggers the
 * row's own click -- expanding a directory, selecting a file.
 *
 * Any surface that names a node can drop one of these in -- the file tree,
 * the inspector, a future imports list -- with no extra wiring.
 */
export function GotoIcon({ target, label }: { target: string; label?: string }) {
  return (
    <button
      type="button"
      className="goto-icon"
      title={label ?? `Go to ${target}`}
      aria-label={label ?? `Go to ${target}`}
      onClick={(event) => {
        event.stopPropagation()
        emitGoto(target)
      }}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        {GOTO_ICON_PATHS.map((d) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
    </button>
  )
}
