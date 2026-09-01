/**
 * Mode 2: the import graph instead of the folder tree (tic-5f52).
 *
 * Position is driven by IMPORTS relationships rather than directory nesting.
 * Design decisions resolved with the user 2026-08-31 (tic-5f52's notes):
 * nodes are files only, not symbols; no folder/directory grouping shapes --
 * pure import topology; edges point importer -> imported, with importers
 * ranked above what they import; the registry's external modules stay
 * excluded, as they already are elsewhere (tic-314c); the whole graph
 * renders at once, with no focus-scope constraint; CALLS edges are out of
 * scope for this mode. Files and edges inside an honest import cycle are
 * highlighted (tic-56b2), via `Workspace.importCycles` (a strongly-connected
 * component of more than one file).
 *
 * Unlike fs-tree, this mode's `layout` cannot be a pure synchronous function
 * of its arguments: the graph is not a tree (tic-5f52), so it goes through
 * elk's layered algorithm in a worker (tic-e82b's `layoutGraph`), which is
 * necessarily async. See ./asyncLayout.ts for the cache-and-notify bridge
 * that reconciles that with `VizMode.layout()`'s synchronous signature: a
 * cache miss kicks off `layoutGraph` in the background and returns nothing
 * to draw yet; its resolution notifies the app to re-render, and the second
 * `layout()` call -- for the same graph, so the same cache key -- returns
 * the real result synchronously.
 *
 * A file expands into its detail container on a double-click (tic-ea9d),
 * showing the same rows an fs-tree container does -- with "Imported By"
 * added above Imports, because in a mode about import topology the incoming
 * edges are half the story.  The row vocabulary itself lives in
 * ./fileDetail.ts, shared with fs-tree rather than reimplemented here.
 */
import type { FsFile, Workspace } from '../data/derive'
import { walkFiles } from '../data/derive'
import type { SymbolKind } from '../data/types'
import { KIND_COLOR, THEME } from '../canvas/theme'
import type { Point, Rect, Size } from '../canvas/viewport'
import { layoutGraph } from '../layout/elkGraph'
import type {
  ElkGraphEdgeInput,
  ElkGraphInput,
  ElkGraphNodeInput,
  ElkGraphPoint,
  ElkGraphResult,
} from '../layout/elkTypes'
import { CONTAINER, fileRows, layoutContainer, rowId, type Row } from './fileDetail'
import { notifyLayoutReady } from './asyncLayout'
import type {
  EdgeStyle,
  NodeStyle,
  Positioned,
  SceneSpec,
  SizeMap,
  SpecEdge,
  SpecNode,
  StyleMap,
  UiState,
  VizMode,
} from './types'

/**
 * Mode params.  tic-5f52 fixed the layout direction and tic-56b2 made cycle
 * highlighting unconditional -- a cycle is a fact about the code, not a
 * display preference -- so the only knob here is how the lines are routed.
 */
export interface ImportGraphParams {
  /**
   * Merge the import lines into a junction system (tic-531b).
   *
   * Off, every import is its own line and a popular module wears a fan of
   * them.  On, elk's layered `mergeEdges` routes everything entering a file
   * through one shared point and everything leaving it through another, so
   * the fan collapses into trunks and elk hands back the junction points
   * where those trunks split -- drawn as dots by the canvas.  A display
   * choice, hence a param rather than something the data decides.
   */
  mergeLines: boolean
}

/** The cycle-membership payload {@link select} carries on `SpecNode.data`
 *  and `SpecEdge.data` for {@link style} to read (tic-56b2). */
interface CycleFlag {
  inCycle: boolean
}

function isInCycle(carrier: { data?: unknown }): boolean {
  return (carrier.data as CycleFlag | undefined)?.inCycle ?? false
}

/**
 * Where an import edge really runs from and to, in FILES (tic-ea9d).
 *
 * `SpecEdge.from`/`to` may name a row inside an expanded container -- that is
 * what makes hovering one import light exactly the line it belongs to -- but
 * elk lays out files and knows nothing about rows, so handing it a row id
 * would fail with an unresolved shape reference (the same class of crash a
 * filtered-out file caused in tic-56b2).  The file-level ends therefore ride
 * along here, on the mode-private payload the framework never inspects:
 * `toElkGraphInput` routes with these, and `finalisePositioned` re-points the
 * polyline's ends onto the rows afterwards.
 */
interface ImportEdgeData extends CycleFlag {
  source: string
  target: string
}

/** An expanded file's rows, read back off the spec nodes `select` built. */
const rowsOf = (node: SpecNode): Row[] => node.children.map((child) => child.data as Row)

const FILE_CHIP_HEIGHT = 40
const FILE_CHIP_MIN_WIDTH = 120
const FILE_CHIP_MAX_WIDTH = 260
/** Rough world-space width of one character at the chip's font size. */
const CHAR_W = 6.4
const CHIP_PAD = 24

const EMPTY_POSITIONED: Positioned = { rects: new Map(), edgePoints: new Map() }

/** Section headers carry their text on the canvas, not a box (tic-ea9d). */
const TRANSPARENT = 'rgba(0,0,0,0)'

// -- select -------------------------------------------------------------------

/**
 * The spec nodes of an expanded file's rows (tic-ea9d).
 *
 * The rows themselves come from the shared detail vocabulary in
 * ./fileDetail.ts -- the same one fs-tree containers use, so the two modes
 * cannot drift -- with "Imported By" turned on, which is the one section
 * this mode wants and fs-tree does not.  Each row carries its own symbol id
 * (so the inspector and the VS Code source-link button find it with no
 * further wiring) and its goto target (so the canvas draws the fly-to
 * button generically).
 */
function rowNodes(data: Workspace, file: FsFile): SpecNode[] {
  return fileRows(data, file, { importedBy: true }).map((row) => ({
    id: row.id,
    role: row.kind === 'section' ? 'section' : 'row',
    label: row.label,
    symbolId: row.symbolId,
    expandable: false,
    children: [],
    data: row,
    gotoTo: row.gotoTo,
  }))
}

function select(data: Workspace, params: ImportGraphParams, ui: UiState): SceneSpec {
  const expanded = ui.expanded
  const lod = ui.lod ?? 0
  const { componentOf, cyclic } = data.importCycles
  const fileInCycle = (path: string): boolean => {
    const id = componentOf.get(path)
    return id !== undefined && cyclic.has(id)
  }
  // An edge is only a cycle edge when both ends are in the *same* cyclic
  // component -- two files that each sit in their own unrelated cycle, or an
  // edge from a cyclic file out to an acyclic one, don't qualify.
  const edgeInCycle = (source: string, target: string): boolean => {
    const a = componentOf.get(source)
    return a !== undefined && a === componentOf.get(target) && cyclic.has(a)
  }

  // At the furthest zoom-out an expanded container collapses back to its
  // chip, as fs-tree's does (tic-fa56): a container a few pixels tall can
  // show no rows, so drawing them is cost with nothing to read.
  const fileOpen = (file: FsFile): boolean => lod < 3 && (expanded[file.path] ?? false)

  const children: SpecNode[] = []
  const goto = new Map<string, string>()
  const visibleFiles = new Set<string>()
  /** Files drawn as containers right now, so the edge anchoring below knows
   *  which ends actually have rows to land on. */
  const openFiles = new Set<string>()
  for (const file of walkFiles(data.tree)) {
    visibleFiles.add(file.path)
    const open = fileOpen(file)
    if (open) openFiles.add(file.path)
    const symbols = data.index.byModule.get(file.module.id)?.length ?? 0
    children.push({
      id: file.path,
      role: 'file',
      label: file.name,
      // An open container wears fs-tree's header: name on the first line, the
      // symbol count under it.  Not cosmetic -- the canvas top-aligns a
      // label only when the node has a sublabel and otherwise centres it
      // vertically (Workspace's `labelY`), which on a container hundreds of
      // pixels tall drops the file name into the middle of its own rows.
      // A collapsed chip keeps just its name, where centring is what we want.
      ...(open ? { sublabel: `${symbols} symbol${symbols === 1 ? '' : 's'}` } : {}),
      symbolId: null,
      // Double-click expands (tic-ea9d); the canvas reads this through
      // ModeOutput.expandable and the store persists it per mode.
      expandable: true,
      children: open ? rowNodes(data, file) : [],
      data: { inCycle: fileInCycle(file.path) } satisfies CycleFlag,
    })
    goto.set(file.path, file.path)
  }

  // Anchoring (tic-ea9d).  While both ends are collapsed an import runs chip
  // to chip, exactly as it always has.  Once an end is expanded the line
  // anchors to the row that end contributes -- the importer's Imports row,
  // the imported file's "Imported By" row -- so hovering one row lights
  // precisely its own line instead of every line the file owns.  Merged mode
  // opts out entirely: the lines have been fused into shared trunks, a trunk
  // cannot lead to one row, and the aggregate is the intended read there
  // (decided with the user 2026-08-31).
  const anchored = (path: string): boolean => !params.mergeLines && openFiles.has(path)

  // `Workspace.fileImports` can name a file the current exclude/file-query
  // scope has dropped from `data.tree` (deriveWorkspace keeps every module
  // node in its symbol index regardless of the file query, so a resolved
  // import target can point outside the filtered file set); an edge to a
  // node this mode never creates would otherwise crash elk's layout with an
  // unresolved shape reference. fs-tree's select() guards the same way.
  const edges: SpecEdge[] = data.fileImports
    .filter((edge) => visibleFiles.has(edge.source) && visibleFiles.has(edge.target))
    .map((edge) => {
      // The importer's Imports section has one row per imported symbol; any
      // of them belongs to this edge, so the first is as good an anchor as
      // the rest.  The imported file's "Imported By" section has exactly one
      // row for this importer, which is the anchor at the other end.
      const symbolId = edge.symbolIds[0]
      return {
        id: `imp:${edge.source}->${edge.target}`,
        from:
          anchored(edge.source) && symbolId !== undefined
            ? rowId(edge.source, `imp:${symbolId}`)
            : edge.source,
        to: anchored(edge.target)
          ? rowId(edge.target, `impby:${edge.source}`)
          : edge.target,
        kind: 'import',
        // Imports flow from importer to imported (tic-5f52); the canvas marches
        // ants on highlighted directional edges to show which way the line points.
        directional: true,
        data: {
          inCycle: edgeInCycle(edge.source, edge.target),
          source: edge.source,
          target: edge.target,
        } satisfies ImportEdgeData,
      }
    })

  const root: SpecNode = {
    id: 'root',
    role: 'root',
    label: '',
    symbolId: null,
    expandable: false,
    children,
  }

  return { root, groups: [], edges, goto }
}

// -- measure ------------------------------------------------------------------

function measure(spec: SceneSpec, _ui: UiState): SizeMap {
  const sizes = new Map<string, Size>()
  for (const node of spec.root.children) {
    // An expanded file is as big as the rows it holds (tic-ea9d), measured by
    // the same layoutContainer the layout phase places them with, so the two
    // can never disagree about how tall the box is.
    if (node.children.length > 0) {
      const container = layoutContainer(rowsOf(node))
      sizes.set(node.id, { width: container.width, height: container.height })
      // Rows are placed inside their container by `layout`, never by elk, so
      // their entries exist only for completeness.
      for (const child of node.children) sizes.set(child.id, { width: 0, height: CONTAINER.row })
      continue
    }
    const width = Math.min(
      FILE_CHIP_MAX_WIDTH,
      Math.max(FILE_CHIP_MIN_WIDTH, Math.ceil(CHIP_PAD + node.label.length * CHAR_W)),
    )
    sizes.set(node.id, { width, height: FILE_CHIP_HEIGHT })
  }
  return sizes
}

// -- layout ---------------------------------------------------------------

/**
 * A stable content key for everything the elk layout depends on, independent
 * of the `SceneSpec` object's identity -- `select()` builds a fresh spec
 * object on every call, including the one triggered by this mode's own
 * `notifyLayoutReady`, so identity-keyed caching would never hit.
 *
 * It keys on the ids, the measured sizes AND the params, and all three
 * matter (tic-531b).  Ids alone was the original v1 key and it was a trap:
 * turning on `mergeLines` changes no node id and no edge id, so the toggle
 * would have hit the stale single-slot cache and appeared to do nothing at
 * all, in either direction.  Folding the params in is what makes the
 * re-derive the user asked for happen for free -- a params change re-runs
 * App's `renderMode` memo, `layout()` misses this key, elk runs, and
 * `notifyLayoutReady` triggers the second, cache-hit render.  The sizes are
 * in for the same reason ahead of time: a future change that resizes a chip
 * (an expanded container, say) alters the geometry without touching an id,
 * and would fall into the identical trap.
 *
 * Node ids and edge ids are unique and deterministic per file/edge, so
 * joining them is enough; the sizes ride along in the same order as the
 * children they measure, and the params are serialised whole so a new knob
 * is covered without editing this function again.
 */
export function cacheKeyOf(spec: SceneSpec, sizes: SizeMap, params: ImportGraphParams): string {
  const nodeIds = spec.root.children.map((node) => node.id).join(',')
  const edgeIds = spec.edges.map((edge) => edge.id).join(',')
  const dims = spec.root.children
    .map((node) => {
      const size = sizes.get(node.id)
      return size ? `${size.width}x${size.height}` : '?'
    })
    .join(',')
  return `${nodeIds}|${edgeIds}|${dims}|${JSON.stringify(params)}`
}

/**
 * Every distinct junction elk reported, flattened into one world-space list
 * (tic-531b).
 *
 * Flat rather than per-edge because a junction belongs to the picture, not
 * to any one line: the canvas only ever wants to stamp a dot there, and
 * nothing selects, hovers or hit-tests one.  Which edge owned the point is
 * information no caller has a use for.
 *
 * The de-duplication is deliberate insurance rather than a fix for observed
 * duplication.  Measured against elkjs directly while building this
 * (tic-531b): a merged 42-edge fan-in produced 12 junction entries and 12
 * distinct coordinates, so elk attributes each junction to exactly one edge
 * rather than to every edge running through it.  Nothing in elk's contract
 * promises that though -- two edges parting at one point could each claim
 * it -- and stacking identical circles on a pixel costs Konva nodes for no
 * visual difference.  The key rounds to a whole world pixel, which also
 * collapses near-coincident points the dot radius would have covered over;
 * the unrounded coordinate is what gets kept and drawn.
 */
export function flattenJunctions(
  junctionPoints: ReadonlyMap<string, readonly ElkGraphPoint[]>,
): Point[] {
  const seen = new Set<string>()
  const flat: Point[] = []
  for (const points of junctionPoints.values()) {
    for (const point of points) {
      const key = `${Math.round(point.x)},${Math.round(point.y)}`
      if (seen.has(key)) continue
      seen.add(key)
      flat.push({ x: point.x, y: point.y })
    }
  }
  return flat
}

/** The domain graph elk lays out: one node per file, one edge per import. */
export function toElkGraphInput(spec: SceneSpec, sizes: SizeMap): ElkGraphInput {
  const nodes: ElkGraphNodeInput[] = spec.root.children.map((node) => {
    const size = sizes.get(node.id) ?? { width: FILE_CHIP_MIN_WIDTH, height: FILE_CHIP_HEIGHT }
    return { id: node.id, width: size.width, height: size.height }
  })
  // Always the FILE ends, never the row an expanded end is anchored to
  // (tic-ea9d): elk lays out the file nodes this function declares above, and
  // a row id would name a shape it was never given.
  const edges: ElkGraphEdgeInput[] = spec.edges.map((edge) => {
    const ends = edge.data as ImportEdgeData | undefined
    return {
      id: edge.id,
      source: ends?.source ?? edge.from,
      target: ends?.target ?? edge.to,
    }
  })
  return { id: 'root', nodes, edges }
}

/**
 * Turn elk's file-level result into this mode's full geometry (tic-ea9d):
 * rows placed inside their containers, and every anchored import line
 * re-pointed onto the row it belongs to.
 *
 * Both steps happen here, after the worker has answered, rather than inside
 * elk, because elk only ever saw files.  Rows hang off their container's
 * rect at offsets `layoutContainer` computed -- the same call `measure` used
 * to size the box, so a row can never land outside it.  The polyline patch
 * keeps every bend elk routed and moves only the end that is anchored: the
 * line still takes elk's path through the layout and simply finishes on the
 * row instead of the container's centre.
 *
 * Pure, and exported for its tests: `layout` runs it once per resolved elk
 * result and caches what comes back, so a re-render pays nothing for it.
 */
export function finalisePositioned(spec: SceneSpec, result: ElkGraphResult): Positioned {
  const rects = new Map<string, Rect>(result.rects)
  for (const node of spec.root.children) {
    if (node.children.length === 0) continue
    const at = rects.get(node.id)
    if (!at) continue
    for (const placed of layoutContainer(rowsOf(node)).rows) {
      rects.set(placed.row.id, {
        x: at.x + placed.x,
        y: at.y + placed.y,
        width: placed.width,
        height: placed.height,
      })
    }
  }

  const edgePoints = new Map<string, readonly number[]>(result.edgePoints)
  for (const edge of spec.edges) {
    const ends = edge.data as ImportEdgeData | undefined
    if (ends === undefined) continue
    // An end is anchored exactly when the spec's endpoint id is no longer the
    // file's own id; anything else is already where elk put it.
    const from = edge.from === ends.source ? undefined : rects.get(edge.from)
    const to = edge.to === ends.target ? undefined : rects.get(edge.to)
    if (from === undefined && to === undefined) continue
    const points = edgePoints.get(edge.id)
    if (points === undefined || points.length < 4) continue
    const patched = [...points]
    if (from !== undefined) {
      patched[0] = from.x + from.width / 2
      patched[1] = from.y + from.height / 2
    }
    if (to !== undefined) {
      patched[patched.length - 2] = to.x + to.width / 2
      patched[patched.length - 1] = to.y + to.height / 2
    }
    edgePoints.set(edge.id, patched)
  }

  // Junctions are omitted rather than stored empty when nothing merged, so
  // `Positioned.junctions` stays absent on the ordinary layout and the canvas
  // cull skips the point filter entirely (tic-531b).
  const junctions = flattenJunctions(result.junctionPoints)
  return { rects, edgePoints, ...(junctions.length > 0 ? { junctions } : {}) }
}

interface LayoutCache {
  key: string
  positioned: Positioned
}

/** Single-slot: only one graph is ever in view at a time, so a new key just
 *  replaces the old entry rather than growing an unbounded map. */
let cache: LayoutCache | null = null
/** The key currently being computed, so a re-render mid-flight (e.g. two
 *  `layout()` calls before the worker responds) doesn't launch a second
 *  redundant elk request for the same graph. */
let inFlightKey: string | null = null

function layout(spec: SceneSpec, sizes: SizeMap, params: ImportGraphParams): Positioned {
  const key = cacheKeyOf(spec, sizes, params)
  if (cache && cache.key === key) return cache.positioned

  if (inFlightKey !== key) {
    inFlightKey = key
    layoutGraph(toElkGraphInput(spec, sizes), { mergeEdges: params.mergeLines })
      .then((result) => {
        // The spec captured here is the one this key was computed from, so
        // the rows and anchors finalisePositioned reads always match the
        // layout that just came back (tic-ea9d).
        cache = { key, positioned: finalisePositioned(spec, result) }
        if (inFlightKey === key) inFlightKey = null
        notifyLayoutReady()
      })
      .catch((error: unknown) => {
        console.error('[import-graph] elk layout failed', error)
        if (inFlightKey === key) inFlightKey = null
      })
  }

  // Nothing to draw yet for this key; the resolution above notifies the app
  // to re-render, and the next `layout()` call for the same key hits the
  // cache set above.
  return EMPTY_POSITIONED
}

// -- style ----------------------------------------------------------------

/**
 * A row or section header inside an expanded container (tic-ea9d), styled as
 * fs-tree styles its own so the two containers read identically.  Every row
 * is pinned: a row has no meaning away from the file it describes, and
 * dragging one out of its box would only break the container it belongs to.
 */
function rowStyle(row: Row, role: string): NodeStyle {
  if (role === 'section') {
    return { fill: TRANSPARENT, stroke: TRANSPARENT, draggable: false }
  }
  // An external import resolves to nothing and links nowhere (tic-314c), so
  // it reads muted against the rows that do.
  if (row.external === true) {
    return {
      fill: THEME.surface2,
      stroke: THEME.textFaint,
      accent: THEME.textFaint,
      draggable: false,
    }
  }
  return {
    fill: THEME.surface2,
    stroke: THEME.line,
    // Sections are handled above, so the kind is a symbol kind.
    accent: KIND_COLOR[row.kind as SymbolKind],
    draggable: false,
  }
}

function style(spec: SceneSpec, _params: ImportGraphParams): StyleMap {
  const nodes = new Map<string, NodeStyle>()
  for (const node of spec.root.children) {
    const cycle = isInCycle(node)
    nodes.set(node.id, {
      // An expanded container reads as a surface holding rows, a collapsed
      // file as a chip on the grid -- the same two fills fs-tree uses.
      fill: node.children.length > 0 ? THEME.surface2 : THEME.surface,
      stroke: cycle ? THEME.cycle : THEME.line,
      accent: cycle ? THEME.cycle : KIND_COLOR.module,
    })
    for (const child of node.children) {
      nodes.set(child.id, rowStyle(child.data as Row, child.role))
    }
  }

  const edges = new Map<string, EdgeStyle>()
  for (const edge of spec.edges) {
    edges.set(
      edge.id,
      isInCycle(edge)
        ? { stroke: THEME.cycle, strokeWidth: 2, opacity: 0.9 }
        : { stroke: THEME.edge, strokeWidth: 1, opacity: 0.45 },
    )
  }

  return { nodes, groups: new Map(), edges }
}

// -- the mode ---------------------------------------------------------------

export const importGraphMode: VizMode<ImportGraphParams> = {
  id: 'import-graph',
  label: 'Import graph',
  defaultParams: { mergeLines: false },
  // Rendered as a checkbox by ModePicker's generic paramToggles handling
  // (tic-83ec), so merging needs no UI code of its own (tic-531b).
  paramToggles: [{ key: 'mergeLines', label: 'Merge import lines' }],
  select,
  measure,
  layout,
  style,
}
