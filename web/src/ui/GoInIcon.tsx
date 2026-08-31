import { useWorkspace } from '../state/store'

/**
 * The focus-scope affordance (tic-e7d2): a small folder-and-arrow that asks
 * the workspace to drill the canvas into `target`.  Drawn as a folder with an
 * arrow dropping into it so it reads as "go into" and stays visually distinct
 * from the camera-goto crosshair it sits beside.  It is a separate element
 * from the row it appears in and stops propagation, so activating it never
 * triggers the row's own click -- expanding a directory, selecting a file.
 *
 * Any surface that names a directory can drop one of these in -- the file
 * tree, a future breadcrumb -- with no extra wiring.
 */
export function GoInIcon({ target, label }: { target: string; label?: string }) {
  const text = target === '' ? '/' : target
  return (
    <button
      type="button"
      className="go-in-icon"
      title={label ?? `Go into ${text}`}
      aria-label={label ?? `Go into ${text}`}
      onClick={(event) => {
        event.stopPropagation()
        useWorkspace.getState().setFocusPath(target)
      }}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          d="M2 3.5h4.5l1.5 2.5H14v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path
          d="M8 8.5v3M6.5 10l1.5 1.5L9.5 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
