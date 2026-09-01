/**
 * The lucide `vector-polygon` glyph's SVG path data (tic-d7d7): four small
 * circles joined by four lines, the "Local View" affordance the import graph
 * puts on every file chip -- a shape that reads as a little neighbourhood of
 * connected nodes rather than the folder-and-arrow "go into" it sits beside.
 *
 * Only the path data lives here, no React component: the canvas is the single
 * surface that draws this today, and it renders the strings as Konva `Path`s
 * rather than as SVG.  A component can join it if an HTML surface ever wants
 * the same glyph, the way {@link ./GoInIcon} pairs both.
 *
 * Two conventions the sibling icon modules already document apply here:
 *
 * - The lucide source is a 24x24 viewBox and
 *   {@link ../canvas/iconButtonLogic.iconGlyphGeometry} assumes 16x16, so
 *   every coordinate is scaled by 2/3 (see FILE_SYMLINK_ICON_PATHS in
 *   ./FileSymlinkIcon).
 * - `CanvasIconButton` draws path `d` strings only, so lucide's four
 *   `<circle>` elements are written out as arc data (see the circle in
 *   GOTO_ICON_PATHS in ./GotoIcon).
 *
 * The circles are lucide's r=2 at (11,4), (15,20), (20,8) and (4,13), i.e.
 * r=4/3 at (7.333,2.667), (10,13.333), (13.333,5.333) and (2.667,8.667) once
 * scaled; each is two half-arcs starting at the circle's left-most point.
 */
export const LOCAL_VIEW_ICON_PATHS = [
  // The four vertices.
  'M6 2.667a1.333 1.333 0 1 0 2.667 0a1.333 1.333 0 1 0-2.667 0',
  'M8.667 13.333a1.333 1.333 0 1 0 2.667 0a1.333 1.333 0 1 0-2.667 0',
  'M12 5.333a1.333 1.333 0 1 0 2.667 0a1.333 1.333 0 1 0-2.667 0',
  'M1.333 8.667a1.333 1.333 0 1 0 2.667 0a1.333 1.333 0 1 0-2.667 0',
  // The four edges between them.
  'm8.552 3.209 3.563 1.583',
  'm10.513 12.102 2.307-5.537',
  'm3.791 9.383 5.083 3.235',
  'M6.515 3.719 3.485 7.613',
]
