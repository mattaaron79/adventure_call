/**
 * Breadcrumb navigation for the focus scope (tic-b1ab).
 *
 * The pure path logic behind the on-workspace breadcrumb toolbar: what the
 * ancestor trail of a focus path is, how to walk up one level, how to elide a
 * long trail so it stays on the canvas, and where the toolbar floats.  Kept
 * free of React and Konva so it is unit-testable in the node test environment,
 * matching the rest of the canvas's pure-logic modules.
 */

/** Screen px of clearance the toolbar keeps from the folder it floats on. */
export const TOOLBAR_GAP = 8

/** One button in the breadcrumb trail: a level the user can jump to. */
export interface Breadcrumb {
  /** The full focus path this crumb jumps to, e.g. `src/app`. */
  path: string
  /** The segment name shown, e.g. `app` for `src/app`. */
  label: string
  /** True when this crumb is the currently focused folder. */
  current: boolean
}

/** The parent directory of a focus path, or the empty string at the root
 *  (tic-e7d2).  The toolbar's '..' button walks up one level with this. */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/**
 * The ancestor trail of a focus path, outermost first: one crumb per level,
 * each carrying the full path its button jumps to, with the last entry the
 * current folder.  The root (empty path) has no trail, so the toolbar does
 * not exist there.
 */
export function breadcrumbSegments(focusPath: string): Breadcrumb[] {
  if (focusPath === '') return []
  let prefix = ''
  const segments = focusPath.split('/')
  return segments.map((segment, i) => {
    prefix = prefix ? `${prefix}/${segment}` : segment
    return { path: prefix, label: segment, current: i === segments.length - 1 }
  })
}

/**
 * Elide the middle of a long breadcrumb trail so it cannot run off the canvas
 * (tic-b1ab): keep the first `head` crumbs and the last `tail`, drop
 * everything between them, and mark the gap with `null` (the ellipsis).  The
 * current folder is always the last crumb, so it always survives.  Trails at
 * or under `max` slots pass through untouched.
 */
export function elideBreadcrumbs(
  crumbs: readonly Breadcrumb[],
  max: number,
): (Breadcrumb | null)[] {
  if (crumbs.length <= max) return [...crumbs]
  const head = 2
  const tail = Math.max(1, Math.min(crumbs.length - head - 1, max - head - 1))
  return [...crumbs.slice(0, head), null, ...crumbs.slice(crumbs.length - tail)]
}

/**
 * The screen y coordinate for the toolbar, given the focused folder's screen
 * top/bottom and the toolbar's own measured height (tic-9f02).  When there is
 * room, the toolbar floats `TOOLBAR_GAP` above the folder's top edge -- its
 * *bottom* clears the folder boundary, matching how the below placement clears
 * it -- otherwise it drops `TOOLBAR_GAP` below the folder's bottom edge.  The
 * above branch must subtract the toolbar's height or it overlaps the folder by
 * `height - GAP`; extracting the placement here keeps that off-by-height bug
 * testable.
 */
export function toolbarScreenY(
  topY: number,
  bottomY: number,
  toolbarHeight: number,
  gap: number = TOOLBAR_GAP,
): number {
  const fitsAbove = topY - gap - toolbarHeight >= 0
  return fitsAbove ? topY - gap - toolbarHeight : bottomY + gap
}
