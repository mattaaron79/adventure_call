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
 */
import type { Workspace } from '../data/derive'
import { walkFiles } from '../data/derive'
import { KIND_COLOR, THEME } from '../canvas/theme'
import type { Point, Size } from '../canvas/viewport'
import { layoutGraph } from '../layout/elkGraph'
import type {
  ElkGraphEdgeInput,
  ElkGraphInput,
  ElkGraphNodeInput,
  ElkGraphPoint,
} from '../layout/elkTypes'
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

const FILE_CHIP_HEIGHT = 40
const FILE_CHIP_MIN_WIDTH = 120
const FILE_CHIP_MAX_WIDTH = 260
/** Rough world-space width of one character at the chip's font size. */
const CHAR_W = 6.4
const CHIP_PAD = 24

const EMPTY_POSITIONED: Positioned = { rects: new Map(), edgePoints: new Map() }

// -- select -------------------------------------------------------------------

function select(data: Workspace, _params: ImportGraphParams, _ui: UiState): SceneSpec {
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

  const children: SpecNode[] = []
  const goto = new Map<string, string>()
  const visibleFiles = new Set<string>()
  for (const file of walkFiles(data.tree)) {
    visibleFiles.add(file.path)
    children.push({
      id: file.path,
      role: 'file',
      label: file.name,
      symbolId: null,
      expandable: false,
      children: [],
      data: { inCycle: fileInCycle(file.path) } satisfies CycleFlag,
    })
    goto.set(file.path, file.path)
  }

  // `Workspace.fileImports` can name a file the current exclude/file-query
  // scope has dropped from `data.tree` (deriveWorkspace keeps every module
  // node in its symbol index regardless of the file query, so a resolved
  // import target can point outside the filtered file set); an edge to a
  // node this mode never creates would otherwise crash elk's layout with an
  // unresolved shape reference. fs-tree's select() guards the same way.
  const edges: SpecEdge[] = data.fileImports
    .filter((edge) => visibleFiles.has(edge.source) && visibleFiles.has(edge.target))
    .map((edge) => ({
      id: `imp:${edge.source}->${edge.target}`,
      from: edge.source,
      to: edge.target,
      kind: 'import',
      // Imports flow from importer to imported (tic-5f52); the canvas marches
      // ants on highlighted directional edges to show which way the line points.
      directional: true,
      data: { inCycle: edgeInCycle(edge.source, edge.target) } satisfies CycleFlag,
    }))

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
  const edges: ElkGraphEdgeInput[] = spec.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
  }))
  return { id: 'root', nodes, edges }
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
        // Junctions are omitted rather than stored empty when nothing merged,
        // so `Positioned.junctions` stays absent on the ordinary layout and
        // the canvas cull skips the point filter entirely (tic-531b).
        const junctions = flattenJunctions(result.junctionPoints)
        cache = {
          key,
          positioned: {
            rects: result.rects,
            edgePoints: result.edgePoints,
            ...(junctions.length > 0 ? { junctions } : {}),
          },
        }
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

function style(spec: SceneSpec, _params: ImportGraphParams): StyleMap {
  const nodes = new Map<string, NodeStyle>()
  for (const node of spec.root.children) {
    nodes.set(
      node.id,
      isInCycle(node)
        ? { fill: THEME.surface, stroke: THEME.cycle, accent: THEME.cycle }
        : { fill: THEME.surface, stroke: THEME.line, accent: KIND_COLOR.module },
    )
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
