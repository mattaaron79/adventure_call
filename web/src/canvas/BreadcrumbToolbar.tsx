/**
 * The on-workspace breadcrumb toolbar (tic-b1ab).
 *
 * `/`, '..' and one button per ancestor segment of the focus path, floating
 * just above the focused folder's group box in world space.  It is an HTML
 * overlay positioned from the viewport transform -- not a Konva layer -- so
 * its text stays at a readable size at any zoom, exactly the weakness the
 * ticket calls out ("a toolbar that shrinks to nothing when zoomed out is
 * useless").  A long trail elides its middle segments rather than running off
 * the canvas, and the toolbar clamps to the visible workspace so a folder
 * that hugs an edge keeps its navigation on screen.
 */
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  breadcrumbSegments,
  elideBreadcrumbs,
  parentPath,
} from './breadcrumbs'
import { sameSize, worldToScreen, type Rect, type Size, type Viewport } from './viewport'

/** How many crumbs (plus at most one ellipsis) the toolbar shows before
 *  eliding the middle of a long trail (tic-b1ab). */
const MAX_CRUMBS = 6
/** Screen px of clearance between the toolbar and the group rect it floats on. */
const GAP = 8
/** Screen px of padding kept between the toolbar and the workspace edge. */
const EDGE_PAD = 8

export const BreadcrumbToolbar = memo(function BreadcrumbToolbar({
  viewport,
  size,
  rect,
  focusPath,
  onNavigate,
}: {
  viewport: Viewport
  size: Size
  /** The world rect of the focused folder's group box, or its chip. */
  rect: Rect
  /** The active focus path; non-empty by the time this is rendered. */
  focusPath: string
  /** Jump to a focus path -- a breadcrumb level, '..' or root (''). */
  onNavigate: (path: string) => void
}) {
  // The crumbs array is memoised on focusPath (tic-de05): elideBreadcrumbs
  // always builds a fresh array, and the measurement effect below keys on it.
  // Without the memo, every render gets a new reference, so the effect
  // re-runs every render, setBox() of a fresh size object never bails out
  // (Object.is), and the loop blows past React's update-depth limit.
  const crumbs = useMemo(
    () => elideBreadcrumbs(breadcrumbSegments(focusPath), MAX_CRUMBS),
    [focusPath],
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
  const above = top.y - GAP - box.height >= 0
  const y = above ? top.y - GAP : bottom.y + GAP
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
      <button
        type="button"
        className="crumb-nav"
        onClick={() => onNavigate('')}
        title="Back to the whole graph"
      >
        /
      </button>
      <button
        type="button"
        className="crumb-nav"
        onClick={() => onNavigate(parentPath(focusPath))}
        title={`Up to ${parentPath(focusPath) || '/'}`}
      >
        ..
      </button>
      {crumbs.map((crumb, i) =>
        crumb === null ? (
          <span key={`…${i}`} className="crumb-ellipsis" aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={crumb.path}
            type="button"
            className={crumb.current ? 'crumb current' : 'crumb'}
            onClick={() => onNavigate(crumb.path)}
            title={crumb.path}
          >
            {crumb.label}
          </button>
        ),
      )}
    </div>
  )
})
