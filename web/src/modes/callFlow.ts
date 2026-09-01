/**
 * Mode 3: call flow -- what can happen when this code runs (tic-d8a8).
 *
 * Modes 1 and 2 answer "where does code live" and "what depends on what".
 * This one answers "what can this set in motion".  It stands entirely on
 * derivations that already exist: tic-a8a6's condensed call DAG, tic-22db's
 * entry points and tic-1ecc's per-callable metrics.  Nothing here re-derives
 * graph facts; it selects, sizes, lays out and styles them.
 *
 * ## Why the picture is drawable at all
 *
 * A raw call graph is not a DAG -- recursion and mutual recursion see to that
 * -- and cannot be layered.  Its CONDENSATION always is (tic-a8a6), so this
 * mode draws components, not functions: a lone function is a component of
 * one, a mutual-recursion knot is a single node badged with its size, and a
 * self-recursive function is itself with a recursion badge.  That is the
 * whole trick, and it is why the layout can be a layered DAG rather than a
 * hairball.
 *
 * ## This ticket delivers the UNFOCUSED state
 *
 * `focusPath === ''` is the mode's index: the entry points, ranked, with what
 * they immediately reach.  A purely rooted mode has a discovery problem --
 * you can only use it if you already know which function to ask about -- so
 * the unfocused state doubles as an architecture overview.  tic-7a5e adds the
 * rooted view; until then a focus path is honoured only by being ignored, per
 * the contract on `UiState.focusPath` (tic-e738): an unresolvable focus draws
 * the whole picture rather than nothing.
 *
 * ## Size is the real constraint, and it is not optional
 *
 * The entry set is large and its expansion is larger.  Measured across two
 * real codebases: on hypermenu, 290 entries expanding to 420 nodes at depth 1
 * and 461 at depth 2; on carnot, 1491 entries expanding to 2286 nodes at
 * depth 2, i.e. very nearly the whole graph.  Drawing every entry is not a
 * picture on either, so the mode ranks entries by blast radius
 * (`reachDown`) and takes the top `entryLimit`, then expands `depth` levels
 * from those.  The count that was left out is reported on the scene, because
 * a view that silently shows 40 of 1491 roots while looking complete is the
 * same failure mode as a call graph that silently drops half its edges.
 */
import type { CallGraph, ExternalCall, Workspace } from '../data/derive'
import { deriveCallMetrics, type CallMetricsIndex } from '../data/callMetrics'
import { deriveEntryPoints, type EntryPoints } from '../data/entryPoints'
import { isTestPath } from '../data/roles'
import { KIND_COLOR, THEME } from '../canvas/theme'
import type { Point, Rect, Size } from '../canvas/viewport'
import { layoutGraph } from '../layout/elkGraph'
import type { ElkGraphInput, ElkGraphResult } from '../layout/elkTypes'
import { notifyLayoutReady } from './asyncLayout'
import { CALL_FLOW_MODE_ID } from './ids'
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

export interface CallFlowParams {
  /**
   * How many levels below the entry points to draw.  1 is "what does each
   * entry immediately reach", which is the question the overview exists to
   * answer; 2 and 3 trade legibility for depth.
   */
  depth: number
  /**
   * How many entry points to draw, most far-reaching first.  Not a display
   * preference so much as the thing that keeps the mode usable: see the size
   * measurements in the module docstring.
   */
  entryLimit: number
  /** Draw the third-party and stdlib modules the code calls out to. */
  showExternals: boolean
  /**
   * Include test functions among the entry points.
   *
   * Off by default, and that default is load-bearing rather than a
   * preference.  Ranking entries by blast radius puts TESTS at the top,
   * because a test drives a deeper path through the system than almost
   * anything else: measured on carnot, 9 of the top 12 entries by `reachDown`
   * were tests, and 982 of 1491 entries are tests at all.  An overview meant
   * to answer "how does execution enter this codebase" that opens on a wall
   * of test functions has answered a different question.  Turn it on to see
   * the test surface, which is a real thing to want -- just not the default.
   *
   * The filter is by FILE (roles.isTestPath), not by the `test` role: the
   * role matches on a `^test_` name, which misses the helpers a test module
   * defines around its tests, and on carnot those helpers -- a dozen nested
   * functions all called `go` -- outranked every real entry point.
   */
  includeTests: boolean
}

const CHIP_HEIGHT = 34
const CHIP_MIN_WIDTH = 140
const CHIP_MAX_WIDTH = 320
const CHAR_WIDTH = 6.6
const CHIP_PADDING = 44

/** Prefix marking an external sink's element id, so nothing mistakes one for
 *  a symbol id (they share a namespace in the scene). */
export const EXTERNAL_PREFIX = 'ext:'

/** Mode-private payload `select` hands to `style`, which never sees the data
 *  or the ui state (the same trick importGraph uses for its cycle flags). */
interface FlowNodeData {
  role: 'entry' | 'framework-entry' | 'internal' | 'orphan' | 'external'
  /** Members of a cyclic component; 1 for an ordinary function. */
  size: number
  /** The function calls itself directly (tic-a8a6). */
  recursive: boolean
  /** Layers from the nearest entry point, or null when unreachable. */
  rank: number | null
}

interface FlowEdgeData {
  /** An edge into an external sink rather than into project code. */
  external: boolean
}

/** What `select` learned that only the app can render as text (tic-d8a8):
 *  how much of the entry set is actually on screen. */
export interface CallFlowSummary {
  /** Entry points drawn. */
  shown: number
  /** Entry points eligible to be drawn, after the test filter. */
  total: number
  /** Entry points held back because they are tests (see
   *  {@link CallFlowParams.includeTests}) -- reported separately so a filter
   *  that removes two thirds of the roots cannot do it silently. */
  hiddenTests: number
}

const summaries = new WeakMap<SceneSpec, CallFlowSummary>()

/** How many entry points this scene shows, out of how many exist.  Absent for
 *  a spec built by another mode. */
export function callFlowSummary(spec: SceneSpec): CallFlowSummary | undefined {
  return summaries.get(spec)
}

/**
 * The label a component wears: its single member's qualified-enough name, or
 * a count for a cycle.
 *
 * A bare function name is not enough to identify a node here.  Measured on
 * the hypermenu export, the default overview draws two different functions
 * both called `menu_items` (from `views` and `views_v1`) side by side -- and
 * a picture whose nodes cannot be told apart is worse than no picture.  A
 * method therefore carries its class, and {@link moduleTail} puts the owning
 * module on the second line.  The symbol id already holds all of this
 * (tic-a8a6): nothing new has to be derived to say which one is which.
 */
export function componentLabel(members: readonly string[], index: Workspace['index']): string {
  if (members.length > 1) return `${members.length} functions (cycle)`
  const node = index.byId.get(members[0])
  if (!node) return members[0]
  if (node.kind === 'method' && node.parent) {
    return `${node.parent.split('.').pop()}.${node.name}`
  }
  return node.name
}

/** The last segment of a module id -- `views_v1` for
 *  `platform.menus.views_v1` -- which is what actually distinguishes two
 *  same-named functions in practice. */
export function moduleTail(moduleId: string): string {
  return moduleId.split('.').pop() ?? moduleId
}

/** A component's element id -- its lowest member id, so the id is stable
 *  across runs rather than depending on Tarjan's numbering. */
export function componentId(members: readonly string[]): string {
  let lowest = members[0]
  for (const member of members) if (member < lowest) lowest = member
  return lowest
}

function chipWidth(label: string, sublabel: string): number {
  const longest = Math.max(label.length, sublabel.length)
  return Math.max(CHIP_MIN_WIDTH, Math.min(CHIP_MAX_WIDTH, longest * CHAR_WIDTH + CHIP_PADDING))
}

/**
 * The frontier: the chosen entry components plus everything within `depth`
 * calls of them, in component space.
 *
 * Breadth-first and in component space rather than symbol space, so a cyclic
 * knot costs one step rather than one per member -- otherwise a mutual
 * recursion would eat the whole depth budget going nowhere.
 */
export function frontierOf(
  graph: CallGraph,
  seeds: readonly number[],
  depth: number,
): Set<number> {
  const seen = new Set<number>(seeds)
  let level = [...seeds]
  for (let step = 0; step < depth; step++) {
    const next: number[] = []
    for (const component of level) {
      for (const target of graph.condensed.get(component) ?? []) {
        if (seen.has(target)) continue
        seen.add(target)
        next.push(target)
      }
    }
    level = next
  }
  return seen
}

/**
 * The entry components to draw, most far-reaching first.
 *
 * Ranked by `reachDown` because "what sets the most in motion" is the useful
 * ordering for an overview -- an entry that reaches two functions tells you
 * much less about the shape of a codebase than one that reaches sixty.  Ties
 * break on the id so the picture is stable between runs rather than
 * depending on map iteration order.
 */
export function rankedEntryComponents(
  graph: CallGraph,
  entryPoints: EntryPoints,
  metrics: CallMetricsIndex,
  /** Which entries to rank; defaults to all of them. */
  entries: readonly string[] = entryPoints.entries,
): number[] {
  const best = new Map<number, number>()
  for (const id of entries) {
    const component = graph.componentOf.get(id)
    if (component === undefined) continue
    const reach = metrics.metricOf.get(id)?.reachDown ?? 0
    const known = best.get(component)
    if (known === undefined || reach > known) best.set(component, reach)
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([component]) => component)
}

function select(data: Workspace, params: CallFlowParams, ui: UiState): SceneSpec {
  const graph = data.callGraph
  const entryPoints = deriveEntryPoints(graph, data.index)
  const metrics = deriveCallMetrics(graph, data.index, entryPoints)

  // Filtered by FILE, not by the `test` role.  The role is name-based
  // (`^test_`), which misses the helpers a test module defines around its
  // tests -- on carnot the top of the ranking was a wall of nested functions
  // called `go`, none of which the role matched and all of which are test
  // surface.  "Is this in a test file" is the question actually being asked.
  const eligible = params.includeTests
    ? entryPoints.entries
    : entryPoints.entries.filter((id) => {
        const node = data.index.byId.get(id)
        return node === undefined || !isTestPath(node.file_path)
      })
  const hiddenTests = entryPoints.entries.length - eligible.length

  const ranked = rankedEntryComponents(graph, entryPoints, metrics, eligible)
  const seeds = ranked.slice(0, Math.max(1, params.entryLimit))
  const frontier = frontierOf(graph, seeds, Math.max(0, params.depth))

  const children: SpecNode[] = []
  const edges: SpecEdge[] = []
  const goto = new Map<string, string>()
  /** Component id -> the element id drawn for it. */
  const elementOf = new Map<number, string>()

  for (const component of frontier) {
    const members = graph.members.get(component) ?? []
    if (members.length === 0) continue
    const id = componentId(members)
    elementOf.set(component, id)

    const representative = data.index.byId.get(members[0])
    const role = entryPoints.roleOf.get(members[0])
    const metric = metrics.metricOf.get(members[0])
    const recursive = members.some((member) => graph.recursive.has(member))

    children.push({
      id,
      role: 'call',
      label: componentLabel(members, data.index),
      sublabel: sublabelFor(
        members,
        representative ? moduleTail(representative.module) : null,
        role?.framework ?? null,
        metric?.reachDown ?? 0,
        recursive,
      ),
      symbolId: members.length === 1 ? members[0] : null,
      expandable: false,
      children: [],
      data: {
        role: role?.role ?? 'internal',
        size: members.length,
        recursive,
        rank: metric?.rank ?? null,
      } satisfies FlowNodeData,
    })

    // Goto targets: the symbol itself, and the file it lives in, so the
    // camera can reach a function from the sidebar or another mode.
    for (const member of members) goto.set(member, id)
    if (representative) goto.set(representative.file_path, id)
  }

  for (const component of frontier) {
    const from = elementOf.get(component)
    if (from === undefined) continue
    for (const target of graph.condensed.get(component) ?? []) {
      const to = elementOf.get(target)
      if (to === undefined) continue // outside the frontier; not drawn
      edges.push({
        id: `call:${from}->${to}`,
        from,
        to,
        kind: 'call',
        route: 'center',
        directional: true,
        data: { external: false } satisfies FlowEdgeData,
      })
    }
  }

  if (params.showExternals) {
    appendExternalSinks(data.externalCalls, graph, frontier, elementOf, children, edges)
  }

  const spec: SceneSpec = {
    root: { id: 'root', role: 'root', label: '', symbolId: null, expandable: false, children },
    groups: [],
    edges,
    goto,
  }
  summaries.set(spec, { shown: seeds.length, total: ranked.length, hiddenTests })
  void ui
  return spec
}

/** The one-line second row: where a node lives, what it is, how far it
 *  reaches.  The module comes first because it is what disambiguates two
 *  same-named functions, which is the common case rather than the exotic
 *  one. */
export function sublabelFor(
  members: readonly string[],
  module: string | null,
  framework: string | null,
  reachDown: number,
  recursive: boolean,
): string {
  const parts: string[] = []
  if (module) parts.push(module)
  if (members.length > 1) parts.push(`${members.length} mutually recursive`)
  else if (recursive) parts.push('recursive')
  if (framework) parts.push(framework)
  parts.push(`reaches ${reachDown}`)
  return parts.join(' · ')
}

/**
 * Add one node per external root module the drawn code calls into, and an
 * edge per (caller, module) pair.
 *
 * Only modules something in the frontier actually calls are added, so the
 * sinks describe THIS picture rather than the whole codebase's dependencies.
 */
function appendExternalSinks(
  externalCalls: readonly ExternalCall[],
  graph: CallGraph,
  frontier: ReadonlySet<number>,
  elementOf: ReadonlyMap<number, string>,
  children: SpecNode[],
  edges: SpecEdge[],
): void {
  const pairs = new Map<string, { from: string; target: string; count: number }>()
  for (const call of externalCalls) {
    const component = graph.componentOf.get(call.source)
    if (component === undefined || !frontier.has(component)) continue
    const from = elementOf.get(component)
    if (from === undefined) continue
    const key = `${from} ${call.target}`
    const known = pairs.get(key)
    if (known) known.count += call.count
    else pairs.set(key, { from, target: call.target, count: call.count })
  }

  const totals = new Map<string, number>()
  for (const pair of pairs.values()) {
    totals.set(pair.target, (totals.get(pair.target) ?? 0) + pair.count)
  }

  for (const [target, count] of totals) {
    children.push({
      id: `${EXTERNAL_PREFIX}${target}`,
      role: 'external',
      label: target,
      sublabel: `${count} call${count === 1 ? '' : 's'} out`,
      symbolId: null,
      expandable: false,
      children: [],
      data: { role: 'external', size: 1, recursive: false, rank: null } satisfies FlowNodeData,
    })
  }

  for (const pair of pairs.values()) {
    edges.push({
      id: `ext:${pair.from}->${pair.target}`,
      from: pair.from,
      to: `${EXTERNAL_PREFIX}${pair.target}`,
      kind: 'call',
      route: 'center',
      directional: true,
      data: { external: true } satisfies FlowEdgeData,
    })
  }
}

function measure(spec: SceneSpec): SizeMap {
  const sizes = new Map<string, Size>()
  for (const node of spec.root.children) {
    sizes.set(node.id, {
      width: chipWidth(node.label, node.sublabel ?? ''),
      height: CHIP_HEIGHT,
    })
  }
  return sizes
}

/** The domain graph elk lays out: one node per drawn component or sink. */
export function toElkGraphInput(spec: SceneSpec, sizes: SizeMap): ElkGraphInput {
  return {
    id: 'root',
    nodes: spec.root.children.map((node) => {
      const size = sizes.get(node.id) ?? { width: CHIP_MIN_WIDTH, height: CHIP_HEIGHT }
      return { id: node.id, width: size.width, height: size.height }
    }),
    edges: spec.edges.map((edge) => ({ id: edge.id, source: edge.from, target: edge.to })),
  }
}

export function cacheKeyOf(spec: SceneSpec, sizes: SizeMap, params: CallFlowParams): string {
  const nodes = spec.root.children.map((node) => node.id).join(',')
  const dims = spec.root.children
    .map((node) => {
      const size = sizes.get(node.id)
      return size ? `${size.width}x${size.height}` : '?'
    })
    .join(',')
  return `${nodes}|${spec.edges.map((e) => e.id).join(',')}|${dims}|${JSON.stringify(params)}`
}

const EMPTY_POSITIONED: Positioned = { rects: new Map(), edgePoints: new Map() }

interface LayoutCache {
  key: string
  positioned: Positioned
}

/** Single-slot, like importGraph's: only one graph is ever in view. */
let cache: LayoutCache | null = null
let inFlightKey: string | null = null

function toPositioned(result: ElkGraphResult): Positioned {
  const rects = new Map<string, Rect>(result.rects)
  const edgePoints = new Map<string, readonly number[]>(result.edgePoints)
  const junctions: Point[] = []
  return { rects, edgePoints, ...(junctions.length > 0 ? { junctions } : {}) }
}

function layout(spec: SceneSpec, sizes: SizeMap, params: CallFlowParams): Positioned {
  const key = cacheKeyOf(spec, sizes, params)
  if (cache && cache.key === key) return cache.positioned

  if (inFlightKey !== key) {
    inFlightKey = key
    layoutGraph(toElkGraphInput(spec, sizes))
      .then((result) => {
        cache = { key, positioned: toPositioned(result) }
        if (inFlightKey === key) inFlightKey = null
        notifyLayoutReady()
      })
      .catch((error: unknown) => {
        console.error('[call-flow] elk layout failed', error)
        if (inFlightKey === key) inFlightKey = null
      })
  }
  return EMPTY_POSITIONED
}

/** Colour per role.  Entry points are the loudest thing on screen, because
 *  the overview is about where execution starts. */
export function nodeStyleFor(data: FlowNodeData): NodeStyle {
  if (data.role === 'external') {
    return { fill: THEME.surface2, stroke: THEME.edge, accent: THEME.textFaint, draggable: true }
  }
  const accent =
    data.size > 1 || data.recursive
      ? THEME.cycle
      : data.role === 'framework-entry' || data.role === 'entry'
        ? KIND_COLOR.function
        : KIND_COLOR.method
  return { fill: THEME.surface2, stroke: THEME.line, accent, draggable: true }
}

function style(spec: SceneSpec): StyleMap {
  const nodes = new Map<string, NodeStyle>()
  for (const node of spec.root.children) {
    nodes.set(node.id, nodeStyleFor(node.data as FlowNodeData))
  }
  const edges = new Map<string, EdgeStyle>()
  for (const edge of spec.edges) {
    const external = (edge.data as FlowEdgeData | undefined)?.external ?? false
    edges.set(
      edge.id,
      external
        ? { stroke: THEME.textFaint, strokeWidth: 1, dash: [4, 4], opacity: 0.5 }
        : { stroke: THEME.edge, strokeWidth: 1.4, opacity: 0.9 },
    )
  }
  return { nodes, groups: new Map(), edges }
}

export const callFlowMode: VizMode<CallFlowParams> = {
  id: CALL_FLOW_MODE_ID,
  label: 'Call Flow',
  defaultParams: { depth: 1, entryLimit: 25, showExternals: true, includeTests: false },
  paramToggles: [
    { key: 'showExternals', label: 'External calls' },
    { key: 'includeTests', label: 'Test entry points' },
  ],
  paramNumbers: [
    { key: 'depth', label: 'Depth', min: 0, max: 3, step: 1 },
    { key: 'entryLimit', label: 'Entries', min: 1, max: 200, step: 10 },
  ],
  select,
  measure,
  layout,
  style,
}
