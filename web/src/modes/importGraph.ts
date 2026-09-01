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
import type { Size } from '../canvas/viewport'
import { layoutGraph } from '../layout/elkGraph'
import type { ElkGraphEdgeInput, ElkGraphInput, ElkGraphNodeInput } from '../layout/elkTypes'
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

/** Mode params. Empty for v1: no configurable knobs (tic-5f52 fixed the
 *  layout direction; cycle highlighting (tic-56b2) is always on, not a
 *  toggle -- a cycle is a fact about the code, not a display preference). */
export type ImportGraphParams = Record<string, never>

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
 * A stable content key for the current node/edge set, independent of the
 * `SceneSpec` object's identity -- `select()` builds a fresh spec object on
 * every call, including the one triggered by this mode's own `notifyLayoutReady`,
 * so identity-keyed caching would never hit. Node ids and edge ids are
 * already unique and deterministic per file/edge, so joining them is enough;
 * the file count alone can't accidentally collide with a different edge set
 * because the edge ids are included too.
 */
export function cacheKeyOf(spec: SceneSpec): string {
  const nodeIds = spec.root.children.map((node) => node.id).join(',')
  const edgeIds = spec.edges.map((edge) => edge.id).join(',')
  return `${nodeIds}|${edgeIds}`
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

function layout(spec: SceneSpec, sizes: SizeMap, _params: ImportGraphParams): Positioned {
  const key = cacheKeyOf(spec)
  if (cache && cache.key === key) return cache.positioned

  if (inFlightKey !== key) {
    inFlightKey = key
    layoutGraph(toElkGraphInput(spec, sizes))
      .then((result) => {
        cache = { key, positioned: { rects: result.rects, edgePoints: result.edgePoints } }
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
  defaultParams: {},
  select,
  measure,
  layout,
  style,
}
