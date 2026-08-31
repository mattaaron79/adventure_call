import { launchVscodeLink } from './Inspector'

/**
 * The lucide `file-symlink` glyph's SVG path data (tic-468e).  Shared between
 * the on-canvas source-link icon button and any other surface that names a
 * symbol's source line, so both draw the same shape from the same data -- the
 * canvas renders it as a Konva Path rather than hand-redrawing it.  The lucide
 * source is 24x24; these coordinates are scaled by 2/3 into the shared 16x16
 * viewBox that {@link ../canvas/iconButtonLogic.iconGlyphGeometry} assumes.
 */
export const FILE_SYMLINK_ICON_PATHS = [
  // The link arrow (a chevron) inside the file body.
  'm6.67 12 2-2-2-2',
  // The folded-corner tab of the file.
  'M9.33 1.33v2.67a1.33 1.33 0 0 0 1.33 1.33h2.67',
  // The file body.
  'M2.67 7.33V2.67a1.33 1.33 0 0 1 1.33-1.33h6l3.33 3.33v8.67a1.33 1.33 0 0 1-1.33 1.33H4a1.33 1.33 0 0 1-1.33-1.33v-2',
  // The link tail leaving the file.
  'M4 13.33h4',
]

/**
 * The source-line affordance (tic-468e): a small file-symlink that opens a
 * `vscode://file/...` deep link to the item's source line, launched the same
 * way the inspector's path link does -- via a hidden iframe so no blank tab is
 * left behind.  It is a separate element from the item it appears in and stops
 * propagation, so activating it never triggers the item's own click.
 *
 * Any surface that names a symbol or file can drop one of these in -- the
 * workspace canvas, the file tree, a future imports list -- with no extra
 * wiring.
 */
export function FileSymlinkIcon({ href, label }: { href: string; label?: string }) {
  return (
    <button
      type="button"
      className="file-symlink-icon"
      title={label ?? 'Open in VS Code'}
      aria-label={label ?? 'Open in VS Code'}
      onClick={(event) => {
        event.stopPropagation()
        launchVscodeLink(href)
      }}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        {FILE_SYMLINK_ICON_PATHS.map((d) => (
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
