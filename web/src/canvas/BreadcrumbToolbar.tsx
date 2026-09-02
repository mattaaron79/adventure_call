/**
 * The on-workspace breadcrumb toolbar (tic-b1ab).
 *
 * '..', '/' and one button per ancestor segment of the focus path, floating
 * just above the focused folder's group box in world space.  It is an HTML
 * overlay positioned from the viewport transform -- not a Konva layer -- so
 * its text stays at a readable size at any zoom, exactly the weakness the
 * ticket calls out ("a toolbar that shrinks to nothing when zoomed out is
 * useless").  A long trail elides its middle segments rather than running off
 * the canvas, and the toolbar clamps to the visible workspace so a folder
 * that hugs an edge keeps its navigation on screen.
 *
 * `rootOnly` cuts it down to a return-to-root button and a label (tic-d7d7),
 * for a scope whose path is not a directory trail -- the import graph's Local
 * View focuses a file, so '..' and the ancestor crumbs would offer folder
 * scopes that mode cannot render.  Everything else about the toolbar --
 * measuring, clamping, the vertical flip -- is shared, so both shapes behave
 * identically once positioned.
 */
import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parentPath, toolbarCrumbs, toolbarScreenY } from './breadcrumbs'
import { sameSize, worldToScreen, type Rect, type Size, type Viewport } from './viewport'

/** How many crumbs (plus at most one ellipsis) the toolbar shows before
 *  eliding the middle of a long trail (tic-b1ab). */
const MAX_CRUMBS = 6
/** Screen px of padding kept between the toolbar and the workspace edge. */
const EDGE_PAD = 8

export const BreadcrumbToolbar = memo(function BreadcrumbToolbar({
  viewport,
  size,
  rect,
  focusPath,
  rootOnly = false,
  rootLabel,
  origin,
  onReturn,
  onNavigate,
}: {
  viewport: Viewport
  size: Size
  /** The world rect of the focused folder's group box, or its chip. */
  rect: Rect
  /** The active focus path; non-empty by the time this is rendered. */
  focusPath: string
  /**
   * Cut the toolbar down to '/' plus a plain label (tic-d7d7): no '..', no
   * ancestor crumbs, nothing clickable but the return to the whole graph.
   * For a focus path that is not a directory trail, i.e. the import graph's
   * Local View of a single file.
   */
  rootOnly?: boolean
  /**
   * What to call the single root-only crumb (tic-7a5e): the focused element's
   * own chip label, which the canvas reads off the scene.  Absent falls back
   * to the last path segment, which is right for a file path and wrong for
   * anything without slashes in it -- a call-flow focus is a dotted symbol id,
   * and slicing it yields the whole id back.
   */
  rootLabel?: string
  /**
   * Where a cross-mode jump started (tic-53f7), for the return button.
   *
   * `label` is the origin mode's own name and `detail` the focus it will
   * return to, so the button can be short and the tooltip specific.  Absent
   * when the current view was not arrived at by a jump, which is the ordinary
   * case and draws no button at all.
   */
  origin?: { label: string; detail: string }
  /** Go back to where the excursion started. */
  onReturn?: () => void
  /** Jump to a focus path -- a breadcrumb level, '..' or root (''). */
  onNavigate: (path: string) => void
}) {
  // The crumbs array is memoised on focusPath (tic-de05): elideBreadcrumbs
  // always builds a fresh array, and the measurement effect below keys on it.
  // Without the memo, every render gets a new reference, so the effect
  // re-runs every render, setBox() of a fresh size object never bails out
  // (Object.is), and the loop blows past React's update-depth limit.
  const crumbs = useMemo(
    () => toolbarCrumbs(focusPath, rootOnly, MAX_CRUMBS),
    [focusPath, rootOnly],
  )

  // Measure the toolbar so it can be clamped to the visible workspace: the
  // horizontal position keeps the whole bar on screen, and the vertical
  // placement flips below the group when there is not enough room above it.
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const width = el.offsetWidth
    const height = el.offsetHeight
    // Bail out when the measured size is unchanged (tic-de05): a fresh
    // {width,height} object every time would never be Object.is-equal, so
    // setBox would schedule a render on every pass and re-trigger this effect.
    setBox((prev) => (sameSize(prev, { width, height }) ? prev : { width, height }))
  }, [crumbs, focusPath])

  const top = worldToScreen(viewport, { x: rect.x, y: rect.y })
  const bottom = worldToScreen(viewport, { x: rect.x, y: rect.y + rect.height })
  // Vertical placement (tic-9f02): the pure function clears the folder's top
  // boundary by the toolbar's own height when it fits above, or drops below.
  const y = toolbarScreenY(top.y, bottom.y, box.height)
  const x = Math.min(
    Math.max(EDGE_PAD, top.x),
    Math.max(EDGE_PAD, size.width - box.width - EDGE_PAD),
  )

  return (
    <div
      ref={ref}
      className="breadcrumb-toolbar"
      style={{ left: x, top: y }}
      role="navigation"
      aria-label="Scope breadcrumbs"
    >
      {/* Back to where a cross-mode jump started (tic-53f7).  Leftmost,
          because it is the outermost step of the trail: origin, then this
          mode's whole graph, then where you are.  It is a DIFFERENT gesture
          from '/', which keeps meaning "the whole graph of the mode I am in"
          -- so it is named after the mode it returns to, never after a
          scope. */}
      {origin && onReturn && (
        <button
          type="button"
          className="crumb-return"
          onClick={onReturn}
          title={`Back to ${origin.label}${origin.detail ? ` at ${origin.detail}` : ''}`}
        >
          {`← ${origin.label}`}
        </button>
      )}
      {/* A file's parent directories are meaningless in a scene laid out by
          imports, so the Local View toolbar drops '..' entirely (tic-d7d7). */}
      {!rootOnly && (
        <button
          type="button"
          className="crumb-nav"
          onClick={() => onNavigate(parentPath(focusPath))}
          title={`Up to ${parentPath(focusPath) || '/'}`}
        >
          ..
        </button>
      )}
      <button
        type="button"
        className="crumb-nav"
        onClick={() => onNavigate('')}
        title="Back to the whole graph"
      >
        /
      </button>
      {crumbs.map((crumb, i) => (
        <Fragment key={crumb === null ? `…${i}` : crumb.path}>
          {/* A subtle '/' reads the trail as a path (tic-9f02); the ellipsis
              is a level too, so it separates as well. */}
          {i > 0 && (
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
          )}
          {crumb === null ? (
            <span className="crumb-ellipsis" aria-hidden="true">
              …
            </span>
          ) : rootOnly ? (
            // The one crumb of a Local View names what the scene is about; it
            // is where you already are, so it is a label, not a button.
            <span className="crumb-label" title={crumb.path}>
              {rootLabel ?? crumb.label}
            </span>
          ) : (
            <button
              type="button"
              className={crumb.current ? 'crumb current' : 'crumb'}
              onClick={() => onNavigate(crumb.path)}
              title={crumb.path}
            >
              {crumb.label}
            </button>
          )}
        </Fragment>
      ))}
    </div>
  )
})
