import { emitGoto } from '../data/goto'

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
        <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 0v2.5M8 13.5V16M0 8h2.5M13.5 8H16" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  )
}
