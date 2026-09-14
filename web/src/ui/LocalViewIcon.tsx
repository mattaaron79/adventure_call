import { IMPORT_GRAPH_MODE_ID } from '../modes/ids'
import { useWorkspace } from '../state/store'
import { LOCAL_VIEW_ICON_PATHS } from './VectorPolygonIcon'

/**
 * The import graph's Local View action in HTML chrome. The canvas already
 * draws these exact path strings; using them here keeps the two affordances
 * recognisably identical rather than approximating the glyph with an emoji or
 * a different icon set.
 */
export function LocalViewIcon({ target, label }: { target: string; label?: string }) {
  return (
    <button
      type="button"
      className="local-view-icon"
      title={label ?? `Open Local View for ${target}`}
      aria-label={label ?? `Open Local View for ${target}`}
      onClick={(event) => {
        event.stopPropagation()
        useWorkspace.getState().openInMode(IMPORT_GRAPH_MODE_ID, target)
      }}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        {LOCAL_VIEW_ICON_PATHS.map((d) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
    </button>
  )
}
