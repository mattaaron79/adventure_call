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
 * ## Two states, one mode
 *
 * `focusPath === ''` is the mode's index: the entry points, ranked, with what
 * they immediately reach.  A purely rooted mode has a discovery problem --
 * you can only use it if you already know which function to ask about -- so
 * the unfocused state doubles as an architecture overview, and every chip in
 * it offers to become the root of the other state.
 *
 * A non-empty `focusPath` names a SYMBOL ID and gives the rooted view
 * (tic-7a5e): one function, what it can set in motion, and what can reach it.
 * That is a third meaning for the same per-mode field -- fs-tree reads it as
 * a directory, the import graph as a file -- and `UiState.focusPath`
 * documents the divergence and the fallback that makes it safe: a focus this
 * mode cannot resolve draws the overview rather than nothing.
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
 *
 * The rooted view has the same problem in a different shape, and the same
 * answer: see {@link coneOf} for what was measured and what it settled.
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

/**
 * Which way the rooted view (tic-7a5e) looks from its root.
 *
 * Two genuinely different questions, asked at different moments: `down` is
 * "what does this set in motion", `up` is "who can reach this, and so who
 * breaks if I change it".  `both` draws each as its own cone -- see
 * {@link coneOf}, where the distinction turns out to be what makes the view
 * drawable at all.
 */
export type FlowDirection = 'down' | 'up' | 'both'

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

  // -- the rooted view (tic-7a5e) -------------------------------------------

  /**
   * How many call hops the rooted view walks from its root, in each active
   * direction.
   *
   * A separate knob from {@link CallFlowParams.depth} rather than a shared
   * one, because the two states want opposite values and the measurements say
   * so: the overview at depth 2 draws 2286 of carnot's 2574 nodes, while the
   * rooted view at depth 1 draws a median of 3.  One number cannot serve
   * both without being wrong for one of them.  Default 2; see {@link coneOf}.
   */
  rootDepth: number
  /** Which way the rooted view looks; see {@link FlowDirection}. */
  direction: FlowDirection
  /**
   * Draw a mutual-recursion knot as its member functions rather than as one
   * condensed chip.
   *
   * Off by default: the condensation is what makes the picture layerable
   * (see the module docstring), and expanding a knot puts a cycle back into
   * the drawn graph, which elk lays out but cannot layer meaningfully.  It is
   * worth having anyway -- once the view is rooted ON a knot, "which of these
   * four functions calls which" is precisely the question, and a chip reading
   * "4 functions (cycle)" refuses to answer it.
   */
  expandCycles: boolean
}

const CHIP_HEIGHT = 34
/** Elk spacing for a rooted view, against the 64/12 default the overview
 *  keeps; the same pair the import graph's Local View settled on. */
const ROOTED_LAYER_GAP = 48
const ROOTED_NODE_GAP = 10
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

/** What a rooted scene records on its spec root for `layout` and `style`,
 *  neither of which ever sees the ui state.  Absent on the overview. */
interface RootedView {
  /** Element ids drawn for the root's component. */
  rootIds: readonly string[]
}

/** The element ids a rooted scene is rooted on, empty for the overview and
 *  for a spec built by another mode. */
export function rootedElementIds(spec: SceneSpec): readonly string[] {
  return (spec.root.data as RootedView | undefined)?.rootIds ?? []
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
 *  a spec built by another mode, and for a ROOTED scene, which shows no entry
 *  set at all -- ask {@link callFlowRoot} about one of those. */
export function callFlowSummary(spec: SceneSpec): CallFlowSummary | undefined {
  return summaries.get(spec)
}

/**
 * What a rooted scene is rooted on (tic-7a5e), and how much of the
 * neighbourhood it had to leave out.
 *
 * Two accessors rather than one union-typed summary because the two states
 * report different things and nothing sensibly asks both at once: a scene is
 * either the overview or a rooted view, and a consumer holding a
 * `CallFlowRoot` already knows which.  It rides on a WeakMap for the same
 * reason the overview's summary does -- the framework's `SceneSpec` has no
 * field for a mode's own findings, and inventing one for a single mode is
 * the wrong seam.
 */
export interface CallFlowRoot {
  /** The symbol id the view is rooted on. */
  root: string
  /** Element ids drawn for the root's component: one, or one per member when
   *  {@link CallFlowParams.expandCycles} split a knot open. */
  rootIds: readonly string[]
  direction: FlowDirection
  depth: number
  /** Components drawn, the root's included. */
  drawn: number
  /**
   * Distinct components one step outside the drawn set, in the directions
   * being looked -- "there is more this way".  The root chip wears this, so
   * a depth-limited picture cannot pass for a complete one.
   */
  beyond: number
  /** A whole level was refused because it would not fit the node budget;
   *  see {@link coneOf}. */
  truncated: boolean
}

const roots = new WeakMap<SceneSpec, CallFlowRoot>()

/** The root of a rooted call-flow scene, or undefined for the overview and
 *  for a spec built by another mode. */
export function callFlowRoot(spec: SceneSpec): CallFlowRoot | undefined {
  return roots.get(spec)
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
 * The most components a rooted view will draw before it stops growing.
 *
 * A depth limit alone does not bound the picture: carnot's `ConfigError` has
 * 9 callers at one hop, 42 at two and 135 at three, and `Transcript` is
 * worse.  Measured over all 1196 non-test roots at the default depth 2, a
 * budget of 80 refuses a level for 6 of them (0.5%) and 40 refuses one for 26
 * (2.2%) -- so 80 buys the tail without costing the ordinary case anything,
 * since the median root draws 4 components and the 90th percentile 18.
 *
 * The budget can never refuse the FIRST level: the widest one-hop cone in
 * carnot is 69 components.  So a rooted view always shows its immediate
 * neighbourhood, whatever it has to give up beyond that.
 */
export const ROOTED_BUDGET = 80

/** The neighbourhood a rooted view draws: which components, how far out, and
 *  what it had to leave at the edge. */
export interface CallCone {
  /** Every component drawn, the root's included. */
  components: Set<number>
  /** Hops from the root, 0 for the root itself. */
  depthOf: Map<number, number>
  /** Distinct components one step outside `components`, in the directions
   *  being looked. */
  beyond: number
  /** A level was refused for the budget rather than for the depth limit. */
  truncated: boolean
}

/**
 * The rooted view's neighbourhood (tic-7a5e): two independent cones from one
 * component, up through callers and down through callees.
 *
 * ## Two cones, not one walk -- and this is the whole design
 *
 * The obvious reading of "upstream and down" is a breadth-first walk over the
 * undirected call graph.  It is unusable, and the numbers are not close.
 * Measured over carnot's 1196 non-test callables, components drawn:
 *
 * ```
 *              depth 1        depth 2         depth 3         depth 4
 * mixed walk   med 3 p90 8    med 12 p90 47   med 42 p90 160  med 121 p90 431
 * two cones    med 3 p90 8    med  4 p90 18   med  5 p90  28  med   5 p90  38
 * ```
 *
 * The mixed walk explodes because one step up to a caller drags in every
 * OTHER thing that caller calls, and the step after that drags in their
 * callers.  Those siblings are not part of either question being asked --
 * "what does this set in motion" and "who can reach this" -- so a walk that
 * collects them is answering neither, at ten times the size.  Two cones keep
 * strictly to ancestors and descendants: the condensation is a DAG, so those
 * two sets cannot overlap, and their union is the picture.
 *
 * (Edges are a separate matter: `select` draws every call edge with both ends
 * on screen, so an ancestor that also calls a descendant directly shows that
 * shortcut.  What the cone decides is which NODES exist, not which lines.)
 *
 * ## Depth 2 is the default, and the median is not why
 *
 * The median root draws 3 components at depth 1, 4 at depth 2, 5 at depth 3:
 * most functions simply do not have much around them and the depth knob
 * barely moves them.  The tail is what the default has to survive, and at
 * depth 2 the 90th percentile is 18 components and the 99th is 57 -- a
 * picture.  Depth 3's 99th percentile is 93 and depth 4's is 232.
 *
 * ## Growth is by whole levels
 *
 * A level that would breach {@link ROOTED_BUDGET} is refused entirely rather
 * than taken in part, and `truncated` says so.  Taking part of a level would
 * mean picking which callers of a hub to believe in, and there is no honest
 * basis for that choice; refusing the level and reporting `beyond` says the
 * true thing instead.  Each direction stops on its own, so a root with a
 * thousand ancestors and three descendants still shows the descendants.
 *
 * Downstream is offered each level's budget first, which matters only when
 * one direction fits and the other would not have if it went second.  The
 * asymmetry is deliberate and small: "what does this set in motion" is the
 * question the mode is named for, and an arbitrary rule beats a rule that
 * depends on map iteration order.
 */
export function coneOf(
  graph: CallGraph,
  root: number,
  direction: FlowDirection,
  depth: number,
  budget: number = ROOTED_BUDGET,
): CallCone {
  const components = new Set<number>([root])
  const depthOf = new Map<number, number>([[root, 0]])
  /** Which side of the root each drawn component is on, so the `beyond`
   *  count below looks the right way from it.  Disjoint, because the
   *  condensation is a DAG. */
  const descendants = new Set<number>()
  const ancestors = new Set<number>()
  let truncated = false

  const wantDown = direction === 'down' || direction === 'both'
  const wantUp = direction === 'up' || direction === 'both'

  /** One level along `adjacency`, committed only if the whole level fits. */
  const advance = (
    adjacency: ReadonlyMap<number, readonly number[]>,
    side: Set<number>,
    frontier: readonly number[],
    step: number,
  ): number[] => {
    const next = new Set<number>()
    for (const component of frontier) {
      for (const target of adjacency.get(component) ?? []) {
        if (!components.has(target)) next.add(target)
      }
    }
    if (next.size === 0) return []
    if (components.size + next.size > budget) {
      truncated = true
      return []
    }
    for (const component of next) {
      components.add(component)
      depthOf.set(component, step)
      side.add(component)
    }
    return [...next]
  }

  // The two frontiers advance independently, so a root with a thousand
  // ancestors and three descendants still shows the descendants.
  let down = wantDown ? [root] : []
  let up = wantUp ? [root] : []
  for (let step = 1; step <= Math.max(0, depth); step++) {
    if (down.length === 0 && up.length === 0) break
    const nextDown = down.length > 0 ? advance(graph.condensed, descendants, down, step) : []
    const nextUp = up.length > 0 ? advance(graph.condensedCallers, ancestors, up, step) : []
    down = nextDown
    up = nextUp
  }

  // What sits just past the edge of the picture, counted once however many
  // drawn components lead to it.  Only in directions being looked: under
  // `direction: 'up'` the root's callees are not beyond the edge, they are
  // outside the question.
  const outside = new Set<number>()
  const look = (
    adjacency: ReadonlyMap<number, readonly number[]>,
    component: number,
  ): void => {
    for (const next of adjacency.get(component) ?? []) {
      if (!components.has(next)) outside.add(next)
    }
  }
  for (const component of components) {
    const atRoot = component === root
    if (wantDown && (atRoot || descendants.has(component))) look(graph.condensed, component)
    if (wantUp && (atRoot || ancestors.has(component))) look(graph.condensedCallers, component)
  }

  return { components, depthOf, beyond: outside.size, truncated }
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

/**
 * The chips one component contributes, and the symbol-to-element mapping they
 * imply -- one chip for the condensed component, or one per member when a
 * knot is being expanded.
 *
 * Both states draw a component the same way, so what separates the overview
 * from the rooted view is which components they choose, not how one looks.
 */
function drawComponent(
  data: Workspace,
  graph: CallGraph,
  entryPoints: EntryPoints,
  metrics: CallMetricsIndex,
  component: number,
  expand: boolean,
  children: SpecNode[],
  elementOf: Map<string, string>,
  goto: Map<string, string>,
): string[] {
  const members = graph.members.get(component) ?? []
  if (members.length === 0) return []
  const groups = expand && members.length > 1 ? members.map((member) => [member]) : [members]
  const ids: string[] = []

  for (const group of groups) {
    const id = componentId(group)
    ids.push(id)
    const representative = data.index.byId.get(group[0])
    const role = entryPoints.roleOf.get(group[0])
    const metric = metrics.metricOf.get(group[0])
    // Drawn apart, only a real self-call earns the recursion badge; the lines
    // between the members say the rest, which is the whole point of expanding.
    const recursive = group.some((member) => graph.recursive.has(member))

    children.push({
      id,
      role: 'call',
      label: componentLabel(group, data.index),
      sublabel: sublabelFor(
        group,
        representative ? moduleTail(representative.module) : null,
        role?.framework ?? null,
        metric?.reachDown ?? 0,
        recursive,
      ),
      symbolId: group.length === 1 ? group[0] : null,
      expandable: false,
      // Every chip offers to become the root of its own view (tic-7a5e).
      // This is the mode's own navigation and needs nothing from tic-e738's
      // cross-mode machinery: re-rooting is a plain focusPath change, and the
      // canvas already hides the button on the element that IS the focus.
      focusTo: id,
      focusIcon: 'local-view',
      focusLabel: 'Trace call flow',
      children: [],
      data: {
        role: role?.role ?? 'internal',
        size: group.length,
        recursive,
        rank: metric?.rank ?? null,
      } satisfies FlowNodeData,
    })

    for (const member of group) {
      elementOf.set(member, id)
      // Goto targets: the symbol itself, and the file it lives in, so the
      // camera can reach a function from the sidebar or another mode.
      goto.set(member, id)
    }
    if (representative) goto.set(representative.file_path, id)
  }
  return ids
}

/**
 * The call edges between the drawn elements, deduplicated.
 *
 * Built from the raw per-symbol edges rather than from the condensation, so
 * one function serves both states: with a knot condensed, mapping both ends
 * through `elementOf` and dropping the self-edges reproduces the condensation
 * exactly; with one expanded, the same pass draws the calls BETWEEN its
 * members, which is the only thing an expanded knot is for.
 *
 * A self-edge is never drawn.  Direct recursion has nowhere to go on a chip,
 * and the recursion badge already says it.
 */
function callEdgesBetween(
  graph: CallGraph,
  elementOf: ReadonlyMap<string, string>,
): SpecEdge[] {
  const edges: SpecEdge[] = []
  const seen = new Set<string>()
  for (const [source, outgoing] of graph.callees) {
    const from = elementOf.get(source)
    if (from === undefined) continue
    for (const edge of outgoing) {
      const to = elementOf.get(edge.target)
      if (to === undefined || to === from) continue
      const id = `call:${from}->${to}`
      if (seen.has(id)) continue
      seen.add(id)
      edges.push({
        id,
        from,
        to,
        kind: 'call',
        route: 'center',
        directional: true,
        data: { external: false } satisfies FlowEdgeData,
      })
    }
  }
  return edges
}

function select(data: Workspace, params: CallFlowParams, ui: UiState): SceneSpec {
  const graph = data.callGraph
  const entryPoints = deriveEntryPoints(graph, data.index)
  const metrics = deriveCallMetrics(graph, data.index, entryPoints)

  // The focus path names a SYMBOL here (see the module docstring).  One the
  // call graph does not hold -- a stale id, a directory from something that
  // mistook this mode for the fs-tree, a symbol the excludes or the file
  // query dropped -- falls back to the overview, which is the contract
  // `UiState.focusPath` states rather than this mode's own politeness.
  const focusPath = ui.focusPath ?? ''
  const rootComponent = focusPath === '' ? undefined : graph.componentOf.get(focusPath)
  return rootComponent === undefined
    ? selectOverview(data, params, graph, entryPoints, metrics)
    : selectRooted(data, params, graph, entryPoints, metrics, focusPath, rootComponent)
}

function selectOverview(
  data: Workspace,
  params: CallFlowParams,
  graph: CallGraph,
  entryPoints: EntryPoints,
  metrics: CallMetricsIndex,
): SceneSpec {
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
  const goto = new Map<string, string>()
  const elementOf = new Map<string, string>()
  for (const component of frontier) {
    drawComponent(data, graph, entryPoints, metrics, component, false, children, elementOf, goto)
  }

  const edges = callEdgesBetween(graph, elementOf)
  if (params.showExternals) appendExternalSinks(data.externalCalls, elementOf, children, edges)

  const spec: SceneSpec = {
    root: { id: 'root', role: 'root', label: '', symbolId: null, expandable: false, children },
    groups: [],
    edges,
    goto,
  }
  summaries.set(spec, { shown: seeds.length, total: ranked.length, hiddenTests })
  return spec
}

/**
 * The rooted view (tic-7a5e): one function, what it can set in motion, and
 * what can reach it.
 *
 * Conceptually the README's `get_room_context` -- callers on one side,
 * callees on the other -- generalised from one hop to N and given a picture.
 * {@link coneOf} decides which components those are and what it had to leave
 * out; everything here is the drawing.
 */
function selectRooted(
  data: Workspace,
  params: CallFlowParams,
  graph: CallGraph,
  entryPoints: EntryPoints,
  metrics: CallMetricsIndex,
  focusPath: string,
  rootComponent: number,
): SceneSpec {
  const depth = Math.max(0, params.rootDepth)
  const cone = coneOf(graph, rootComponent, params.direction, depth)

  const children: SpecNode[] = []
  const goto = new Map<string, string>()
  const elementOf = new Map<string, string>()
  let rootIds: string[] = []
  for (const component of cone.components) {
    const ids = drawComponent(
      data,
      graph,
      entryPoints,
      metrics,
      component,
      params.expandCycles,
      children,
      elementOf,
      goto,
    )
    if (component === rootComponent) rootIds = ids
  }

  // The root chip wears what is missing.  A rooted view is a claim about a
  // neighbourhood, and a depth- or budget-limited one that looks complete
  // makes a false claim -- the same failure the overview's shown-of-total
  // count exists to prevent, carried in the one place here that can carry it
  // without a framework change.
  const isRoot = new Set(rootIds)
  for (const node of children) {
    if (!isRoot.has(node.id)) continue
    const members = graph.members.get(rootComponent) ?? []
    const group = params.expandCycles && members.length > 1 ? [node.id] : members
    const representative = data.index.byId.get(group[0])
    node.sublabel = rootSublabelFor(
      group,
      representative ? moduleTail(representative.module) : null,
      entryPoints.roleOf.get(group[0])?.framework ?? null,
      group.some((member) => graph.recursive.has(member)),
      cone.beyond,
      cone.truncated,
    )
  }

  const edges = callEdgesBetween(graph, elementOf)
  if (params.showExternals) appendExternalSinks(data.externalCalls, elementOf, children, edges)

  const spec: SceneSpec = {
    root: {
      id: 'root',
      role: 'root',
      label: '',
      symbolId: null,
      expandable: false,
      children,
      // The root rides on the spec rather than on the ui state, because
      // `layout` and `style` never see the latter -- the channel importGraph's
      // Local View centre uses, for the same two consumers: tighter elk
      // spacing, and an accent border on the thing the view is about.
      data: { rootIds } satisfies RootedView,
    },
    groups: [],
    edges,
    goto,
  }
  roots.set(spec, {
    root: focusPath,
    rootIds,
    direction: params.direction,
    depth,
    drawn: cone.components.size,
    beyond: cone.beyond,
    truncated: cone.truncated,
  })
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
  const parts = identityParts(members, module, framework, recursive)
  parts.push(`reaches ${reachDown}`)
  return parts.join(' · ')
}

/** Where a node lives and what it is, without any claim about its reach --
 *  the half of {@link sublabelFor} both states share. */
function identityParts(
  members: readonly string[],
  module: string | null,
  framework: string | null,
  recursive: boolean,
): string[] {
  const parts: string[] = []
  if (module) parts.push(module)
  if (members.length > 1) parts.push(`${members.length} mutually recursive`)
  else if (recursive) parts.push('recursive')
  if (framework) parts.push(framework)
  return parts
}

/**
 * The second row of the chip a rooted view is rooted on (tic-7a5e): what it
 * is, and how much of its neighbourhood is missing.
 *
 * Deliberately NOT `reaches N`.  That figure is the overview's vocabulary --
 * it exists to rank entry points by blast radius -- and on a root it is
 * either redundant or actively misleading: carnot's `ConfigError` has 283
 * things that can reach it and reaches nothing itself, so an upward-looking
 * view of it read `reaches 0 · +93 more`, which invites the reader to
 * subtract two numbers that measure opposite directions.  The picture already
 * shows the reach.  What it cannot show is what it left out, so that is what
 * the root says.
 */
export function rootSublabelFor(
  members: readonly string[],
  module: string | null,
  framework: string | null,
  recursive: boolean,
  beyond: number,
  truncated: boolean,
): string {
  const parts = identityParts(members, module, framework, recursive)
  if (beyond > 0) {
    parts.push(truncated ? `${beyond} not shown (depth capped)` : `${beyond} not shown`)
  }
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
  elementOf: ReadonlyMap<string, string>,
  children: SpecNode[],
  edges: SpecEdge[],
): void {
  const pairs = new Map<string, { from: string; target: string; count: number }>()
  for (const call of externalCalls) {
    // A caller that is not drawn contributes no sink: the same guard every
    // derivation applies, and the one whose absence crashed elk in tic-56b2.
    const from = elementOf.get(call.source)
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

/**
 * The single-slot layout cache's key.
 *
 * The root ids are in for the reason importGraph's Local View centre is in
 * (tic-d7d7): re-rooting usually changes the node set, so the ids would
 * mostly catch it -- but not always.  Re-rooting from a function onto its
 * only caller, with `direction: 'both'` and nothing else nearby, can draw the
 * identical two chips with identical sizes while the elk spacing and the
 * accent border differ, and the roomy cached layout would be silently reused.
 */
export function cacheKeyOf(spec: SceneSpec, sizes: SizeMap, params: CallFlowParams): string {
  const nodes = spec.root.children.map((node) => node.id).join(',')
  const dims = spec.root.children
    .map((node) => {
      const size = sizes.get(node.id)
      return size ? `${size.width}x${size.height}` : '?'
    })
    .join(',')
  const rooted = rootedElementIds(spec).join(',')
  return `${nodes}|${spec.edges.map((e) => e.id).join(',')}|${dims}|${JSON.stringify(params)}|${rooted}`
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
    // A rooted view lays out tighter than the overview, as the import graph's
    // Local View does (tic-d7d7): it draws a median of 4 chips against the
    // overview's 168, and at that size the default gaps read as a scattering
    // rather than a neighbourhood.
    const rooted = rootedElementIds(spec).length > 0
    layoutGraph(
      toElkGraphInput(spec, sizes),
      rooted ? { layerGap: ROOTED_LAYER_GAP, nodeGap: ROOTED_NODE_GAP } : undefined,
    )
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
  // The chip a rooted view is about wears the accent border (as the import
  // graph's Local View centre does), so it is obvious which of a dozen
  // look-alike chips the neighbourhood hangs off.  It outranks the cycle
  // colour on the border, which is not lost: the accent BAR still carries
  // the cycle's pink, so a root inside a knot says both things at once.
  const rootIds = new Set(rootedElementIds(spec))
  const nodes = new Map<string, NodeStyle>()
  for (const node of spec.root.children) {
    const base = nodeStyleFor(node.data as FlowNodeData)
    nodes.set(node.id, rootIds.has(node.id) ? { ...base, stroke: THEME.accent } : base)
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
  defaultParams: {
    depth: 1,
    entryLimit: 25,
    showExternals: true,
    includeTests: false,
    rootDepth: 2,
    direction: 'both',
    expandCycles: false,
  },
  paramToggles: [
    { key: 'showExternals', label: 'External calls' },
    { key: 'includeTests', label: 'Test entry points' },
    { key: 'expandCycles', label: 'Expand cycles' },
  ],
  paramOptions: [
    {
      key: 'direction',
      label: 'Trace',
      options: [
        { value: 'both', label: 'Both' },
        { value: 'down', label: 'Calls' },
        { value: 'up', label: 'Callers' },
      ],
    },
  ],
  paramNumbers: [
    { key: 'depth', label: 'Overview depth', min: 0, max: 3, step: 1 },
    { key: 'entryLimit', label: 'Entries', min: 1, max: 200, step: 10 },
    { key: 'rootDepth', label: 'Trace depth', min: 0, max: 4, step: 1 },
  ],
  select,
  measure,
  layout,
  style,
}
