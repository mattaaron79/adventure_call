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
import {
  destinationOf,
  deriveCallMetrics,
  type CallCoverage,
  type CallMetricsIndex,
} from '../data/callMetrics'
import {
  deriveControlFlowTags,
  edgeTagsOf,
  type ControlFlowTags,
  type EdgeTags,
  type NodeControlTags,
} from '../data/controlFlow'
import { deriveEntryPoints, type EntryPoints } from '../data/entryPoints'
import { isTestPath } from '../data/roles'
import { KIND_COLOR, THEME } from '../canvas/theme'
import type { Point, Rect, Size } from '../canvas/viewport'
import type { GraphStats, SymbolRegistry } from '../data/types'
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
  role: 'entry' | 'framework-entry' | 'referenced' | 'internal' | 'orphan' | 'external'
  /** Members of a cyclic component; 1 for an ordinary function. */
  size: number
  /** The function calls itself directly (tic-a8a6). */
  recursive: boolean
  /** Layers from the nearest entry point, or null when unreachable. */
  rank: number | null
  /**
   * The complexity proxy of the hairiest member (tic-d7d1), or null when the
   * element carries none -- an external sink, or a symbol from an export
   * that predates the field.  A condensed knot takes its members' max: the
   * knot is as hairy as its worst member.
   */
  complexity: number | null
}

interface FlowEdgeData {
  /** An edge into an external sink rather than into project code. */
  external: boolean
  /**
   * At least one call site behind this line was resolved by a heuristic
   * rather than exactly (tic-171f): the line is partly conjecture and is
   * drawn so the reader can tell.  Collapsed element-to-element edges carry
   * the worst confidence of anything they stand for -- an honest "some of
   * this is a guess" beats a confident-looking line that is not.
   */
  heuristic: boolean
  /**
   * How this line's call sites sit in their callers' control flow (tic-5069).
   *
   * Carried on `data` rather than folded into {@link SpecEdge.kind}, which is
   * the field the cross-mode machinery keys on: selection highlighting and
   * marching ants both test for a `call` edge, and encoding a tag in the kind
   * would quietly stop these being recognised as call edges at all.
   *
   * Null for a line with no breadcrumbs behind it -- an external sink, the
   * implicit `class -> __init__` edge, or any edge on a pre-v3 export.
   * tic-23eb is what styles these; this ticket only has to derive and carry
   * them.
   */
  tags: EdgeTags | null
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
  control: ControlFlowTags,
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
        groupCoverage(group, metrics),
        groupControl(group, control),
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
        complexity: groupComplexity(group, data),
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
 *
 * A collapsed edge keeps the WORST confidence of the per-symbol edges behind
 * it (tic-171f): one heuristic call site among five exact ones still means
 * the drawn line is partly a guess, and saying so costs a dash pattern
 * rather than a reader's trust.
 */
interface CollapsedEdge {
  from: string
  to: string
  heuristic: boolean
  /** Every breadcrumb behind this line, from every call-graph edge that
   *  collapsed onto it (tic-5069). */
  controls: (readonly string[])[]
}

function callEdgesBetween(
  graph: CallGraph,
  elementOf: ReadonlyMap<string, string>,
): SpecEdge[] {
  const collapsed = new Map<string, CollapsedEdge>()
  for (const [source, outgoing] of graph.callees) {
    const from = elementOf.get(source)
    if (from === undefined) continue
    for (const edge of outgoing) {
      const to = elementOf.get(edge.target)
      if (to === undefined || to === from) continue
      const id = `call:${from}->${to}`
      const heuristic = !edge.implicit && edge.confidence === 'heuristic'
      const known = collapsed.get(id)
      if (known) {
        if (heuristic) known.heuristic = true
        // Breadcrumbs POOL rather than the first winning.  A drawn element
        // can stand for several symbols -- a condensed knot most obviously --
        // so one line can carry two functions' calls to the same target, and
        // if one of them is guarded and the other is not, `mixed` is the true
        // answer for the line.  Tagging each edge separately and picking one
        // would report a fact about a call the reader cannot see.
        if (edge.controls) known.controls.push(...edge.controls)
        continue
      }
      collapsed.set(id, { from, to, heuristic, controls: [...(edge.controls ?? [])] })
    }
  }
  return [...collapsed].map(([id, edge]) => ({
    id,
    from: edge.from,
    to: edge.to,
    kind: 'call',
    route: 'center',
    directional: true,
    data: {
      external: false,
      heuristic: edge.heuristic,
      tags: edgeTagsOf(edge.controls),
    } satisfies FlowEdgeData,
  }))
}

function select(data: Workspace, params: CallFlowParams, ui: UiState): SceneSpec {
  const graph = data.callGraph
  const entryPoints = deriveEntryPoints(graph, data.index, undefined, data.references)
  // The registry rides on the workspace (tic-171f), so coverage fills in the
  // moment it has been fetched and is null -- visibly absent, never zero --
  // before that.
  const metrics = deriveCallMetrics(graph, data.index, entryPoints, data.registry)
  const control = deriveControlFlowTags(graph)

  // The focus path names a SYMBOL here (see the module docstring).  One the
  // call graph does not hold -- a stale id, a directory from something that
  // mistook this mode for the fs-tree, a symbol the excludes or the file
  // query dropped -- falls back to the overview, which is the contract
  // `UiState.focusPath` states rather than this mode's own politeness.
  const focusPath = ui.focusPath ?? ''
  const rootComponent = focusPath === '' ? undefined : graph.componentOf.get(focusPath)
  return rootComponent === undefined
    ? selectOverview(data, params, graph, entryPoints, metrics, control)
    : selectRooted(data, params, graph, entryPoints, metrics, control, focusPath, rootComponent)
}

function selectOverview(
  data: Workspace,
  params: CallFlowParams,
  graph: CallGraph,
  entryPoints: EntryPoints,
  metrics: CallMetricsIndex,
  control: ControlFlowTags,
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
    drawComponent(
      data,
      graph,
      entryPoints,
      metrics,
      control,
      component,
      false,
      children,
      elementOf,
      goto,
    )
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
  control: ControlFlowTags,
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
      control,
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
      groupCoverage(group, metrics),
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

/**
 * Coverage summed over the members a chip stands for, or null when the
 * registry has not landed (every member's own coverage is still null).
 *
 * A condensed cycle chip speaks for several functions, so its coverage is
 * their SUM -- "these 2 functions resolved 3 of 9 call sites between them"
 * is the true statement about the chip, and per-member figures would not be
 * visible anywhere anyway until the knot is expanded.
 */
/**
 * Control tags shared by every member a chip stands for (tic-5069).
 *
 * A condensed knot speaks for several functions, and the honest claim about
 * the chip is what is true of ALL of them: a knot where one member is an
 * error handler and the other is not is not an error-handler chip.  A member
 * nothing calls has no tags at all, and one untagged member is enough to sink
 * the claim -- the same "no callers is not a vacuous yes" rule the roll-up
 * itself uses.
 */
export function groupControl(
  members: readonly string[],
  control: ControlFlowTags,
): NodeControlTags | null {
  const tags = members.map((member) => control.nodeOf.get(member))
  if (tags.length === 0 || tags.some((entry) => entry === undefined)) return null
  const present = tags as NodeControlTags[]
  return {
    errorHandler: present.every((entry) => entry.errorHandler),
    hot: present.every((entry) => entry.hot),
    alwaysGuarded: present.every((entry) => entry.alwaysGuarded),
    callers: present.reduce((total, entry) => total + entry.callers, 0),
  }
}

/**
 * The complexity proxy of the hairiest member (tic-d7d1), or null when no
 * member carries one -- a symbol from an export that predates the field.
 * The max, not the mean: a condensed knot is drawn as one thing, and it is
 * as hairy as its worst member.
 */
export function groupComplexity(
  members: readonly string[],
  data: Workspace,
): number | null {
  let max: number | null = null
  for (const member of members) {
    const complexity = data.index.byId.get(member)?.complexity
    if (complexity === undefined) continue
    max = max === null ? complexity : Math.max(max, complexity)
  }
  return max
}

export function groupCoverage(
  members: readonly string[],
  metrics: CallMetricsIndex,
): CallCoverage | null {
  let resolved = 0
  let unresolved = 0
  let dynamic = 0
  let any = false
  for (const member of members) {
    const coverage = metrics.metricOf.get(member)?.coverage
    if (!coverage) continue
    any = true
    resolved += coverage.resolved
    unresolved += coverage.unresolved
    dynamic += coverage.dynamic
  }
  return any ? { resolved, unresolved, total: resolved + unresolved, dynamic } : null
}

/**
 * The per-node honesty clause (tic-171f), appended to a chip's second row:
 * how many of this function's call sites actually resolved, and how many
 * were computed at runtime so flow provably leaves the map there.
 *
 * Wording is deliberately flat information rather than an apology or an
 * error state -- partial resolution is the normal condition of static
 * analysis on a dynamic language.  It never says "and nothing else"; it
 * says what resolved and what did not.  Silent when the registry has not
 * landed (nothing is known yet, so nothing is claimed) and when the
 * function makes no calls at all (`reaches 0` already says that, and there
 * are no sites to be honest about).
 */
function appendCoverage(parts: string[], coverage: CallCoverage | null): void {
  if (!coverage || coverage.total === 0) return
  parts.push(`${coverage.resolved}/${coverage.total} sites resolved`)
  if (coverage.dynamic > 0) parts.push(`${coverage.dynamic} computed`)
}

/** The one-line second row: where a node lives, what it is, how far it
 *  reaches, and how much of its own outgoing flow the export could follow
 *  (tic-171f).  The module comes first because it is what disambiguates two
 *  same-named functions, which is the common case rather than the exotic
 *  one. */
export function sublabelFor(
  members: readonly string[],
  module: string | null,
  framework: string | null,
  reachDown: number,
  recursive: boolean,
  coverage: CallCoverage | null = null,
  control: NodeControlTags | null = null,
): string {
  const parts = identityParts(members, module, framework, recursive, control)
  parts.push(`reaches ${reachDown}`)
  appendCoverage(parts, coverage)
  return parts.join(' · ')
}

/** Where a node lives and what it is, without any claim about its reach --
 *  the half of {@link sublabelFor} both states share. */
function identityParts(
  members: readonly string[],
  module: string | null,
  framework: string | null,
  recursive: boolean,
  control: NodeControlTags | null = null,
): string[] {
  const parts: string[] = []
  if (module) parts.push(module)
  if (members.length > 1) parts.push(`${members.length} mutually recursive`)
  else if (recursive) parts.push('recursive')
  if (framework) parts.push(framework)
  // A control roll-up goes in the same slot as the framework role, because it
  // is the same kind of claim -- what part does this play -- and because both
  // are short and rare enough not to crowd the chip.  `alwaysGuarded` is
  // deliberately not here: it is true of a quarter of called symbols on both
  // codebases, and a badge that common says nothing.
  if (control?.errorHandler) parts.push('error handler')
  else if (control?.hot) parts.push('hot')
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
  coverage: CallCoverage | null = null,
): string {
  const parts = identityParts(members, module, framework, recursive)
  if (beyond > 0) {
    parts.push(truncated ? `${beyond} not shown (depth capped)` : `${beyond} not shown`)
  }
  // The root is a node like any other, so it wears the same honesty clause:
  // a rooted view whose root reads "0/4 sites resolved" is telling the
  // reader that the downstream cone it drew stands on heuristic-free ground
  // -- or that it does not.
  appendCoverage(parts, coverage)
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
      data: {
        role: 'external',
        size: 1,
        recursive: false,
        rank: null,
        complexity: null,
      } satisfies FlowNodeData,
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
      // External calls are unresolved by definition, not by conjecture, so
      // they never wear the heuristic marking; their own faint dashed style
      // already says what they are.
      data: { external: true, heuristic: false, tags: null } satisfies FlowEdgeData,
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

/**
 * The stroke for a notably complex function (tic-d7d1), or null for an
 * ordinary one.  The threshold is a judgement call on a RELATIVE-ORDERING
 * proxy, not a measured constant: it marks the functions a reader would
 * want flagged before opening them, and the inspector carries the exact
 * number.  A cycle keeps its pink accent bar; this only warms the border.
 */
export const COMPLEXITY_SHADE_THRESHOLD = 10

export function complexityAccent(complexity: number | null | undefined): string | null {
  if (complexity === null || complexity === undefined) return null
  return complexity >= COMPLEXITY_SHADE_THRESHOLD ? THEME.hairy : null
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
      : data.role === 'framework-entry' || data.role === 'referenced' || data.role === 'entry'
        ? KIND_COLOR.function
        : KIND_COLOR.method
  return {
    fill: THEME.surface2,
    stroke: complexityAccent(data.complexity) ?? THEME.line,
    accent,
    draggable: true,
  }
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
    edges.set(edge.id, edgeStyleFor(edge.data as FlowEdgeData | undefined))
  }
  return { nodes, groups: new Map(), edges }
}

/**
 * The visual treatment of one call edge, from its mode-private payload.
 * Exported for the tests, which build payloads directly rather than standing
 * up whole graphs per tag.
 *
 * ## What gets a channel, and what does not (tic-23eb)
 *
 * The measured tag distribution (tic-5069) is lopsided: unguarded is 78%/74%
 * of edges on carnot/hypermenu, guarded 20%/24%, looped 9%/9%, error-path
 * 1.3%/0.3%, and type-checking-only fires ZERO times on both.  So the budget
 * goes to the two tags a reader will actually meet:
 *
 * - `guarded` (and `mixed`, which is partly guarded -- see below) draws
 *   dashed.  A dash's claim is "this call can be skipped", which is true of
 *   both: mixed means some sites are guarded, so drawing it solid would
 *   overclaim and drawing it a THIRD way would spend a second channel on 2%
 *   of edges.  The exact split stays a job for the inspector.
 * - `looped` draws a heavier stroke.  "This can fire more than once" is the
 *   one tag that changes how many times an edge's meaning is consumed, and
 *   weight is the channel that reads at any zoom without a legend.
 * - `errorPath` takes THEME.cycle, the palette's one warm colour: 1% of
 *   edges, so rarity is what makes it legible, and the chips already use the
 *   same warm accent for their 'error handler' badge -- one colour, one
 *   claim, both ends of the line.
 * - `typeCheckingOnly` is NOT drawn (opacity 0).  It fired zero times on
 *   both available codebases and structurally will on most -- `if
 *   TYPE_CHECKING` guards imports, not calls -- so it gets no param, no
 *   styling and no legend entry until an export exists where it fires.  The
 *   tags still ride on the data, so styling it later is a one-line change.
 * - `unguarded` is the default and gets nothing: styling the 78% majority is
 *   how a style phase becomes noise.
 *
 * Channels compose where they do not collide.  Heuristic confidence already
 * owns the dash channel on a heuristic edge, so a heuristic+guarded edge
 * keeps the fine heuristic dash -- "some of this is a guess" outranks "it
 * can be skipped" when one line must carry both -- and weight/colour still
 * apply to it.  External sinks predate all of this and keep their voice.
 */
export function edgeStyleFor(data: FlowEdgeData | undefined): EdgeStyle {
  const external = data?.external ?? false
  // Three edge voices (tic-171f): solid for exact resolutions, finely
  // dashed for lines standing partly on heuristic ones, and the faint
  // coarse dash an external sink already had.  The heuristic voice is
  // quieter but present -- an edge whose confidence is partial should
  // look slightly less certain than one that is not, without demanding a
  // legend to decode.
  const heuristic = data?.heuristic ?? false
  if (external) return { stroke: THEME.textFaint, strokeWidth: 1, dash: [4, 4], opacity: 0.5 }

  const tags = data?.tags ?? null
  if (tags?.typeCheckingOnly) return { stroke: THEME.edge, strokeWidth: 1, opacity: 0 }

  let style: EdgeStyle = heuristic
    ? { stroke: THEME.edge, strokeWidth: 1.1, dash: [2, 4], opacity: 0.55 }
    : { stroke: THEME.edge, strokeWidth: 1.4, opacity: 0.9 }
  if (tags?.errorPath) style = { ...style, stroke: THEME.cycle }
  if (tags?.looped) style = { ...style, strokeWidth: (style.strokeWidth ?? 1.4) + 0.6 }
  // `mixed` shares the guarded dash; the docstring above says why.  A
  // heuristic edge keeps its own, finer dash instead -- one dash channel,
  // and confidence is the louder claim on that line.
  if (!heuristic && (tags?.guard === 'guarded' || tags?.guard === 'mixed')) {
    style = { ...style, dash: [6, 4] }
  }
  return style
}

/**
 * The view-level coverage figure (tic-171f, rebuilt for tic-f21f): what the
 * export knows about where this codebase's calls go.
 *
 * Read LIVE from the export's stats so the number moves as the exporter
 * improves -- never a figure copied from a ticket at one point in time.
 *
 * ## Three buckets, because two were pessimistic
 *
 * The original split was "resolved" against "unresolved", which files a call
 * to `len()`, to `django.shortcuts.render` and to `lines.append` under the
 * same heading as a call we genuinely cannot place.  Those are not the same
 * thing: the first three have a destination we can NAME, and naming it is
 * most of what a reader wanted.  Since tic-97ce the resolver says which is
 * which, so:
 *
 * - `inProject`   -- landed on a project symbol; the edges the graph draws.
 * - `outOfProject`-- destination known, outside the project: builtins, plus
 *                    tic-97ce's `external:` / `stdlib method on` /
 *                    `foreign base:` classifications.
 * - `unknown`     -- destination not known, `computed` being the subset where
 *                    flow provably leaves the map rather than merely not
 *                    being followed.
 *
 * Measured, the difference is the whole story rather than a rounding:
 *
 *   carnot     12,405 sites   34% in project · 31% out of project · 34% unknown
 *   hypermenu   4,879 sites   19% in project · 36% out of project · 45% unknown
 *
 * Reported as "19% resolved", hypermenu looks like an analysis that failed.
 * It is not: a third of its calls go into django, and we can say so.
 *
 * ## The old figure also double-counted
 *
 * `stats.calls_heuristic` is a SUBSET of `stats.calls_resolved` (writer.py
 * counts `resolved` then filters it by confidence), so summing the two
 * inflated both halves of the fraction -- carnot read 38% where the honest
 * number is 34%, against a total 786 larger than the number of call sites
 * that exist.  `heuristic` is kept, as the subset it is.
 */
export interface FlowCoverage {
  /** Sites that landed on a project symbol -- the edges the graph draws. */
  inProject: number
  /** How many of {@link inProject} a heuristic resolved rather than a
   *  binding.  A SUBSET, never an addend. */
  heuristic: number
  /** Sites whose destination is known and is not in this project. */
  outOfProject: number
  /** Sites whose destination is not known. */
  unknown: number
  /** The subset of {@link unknown} whose callee is computed at runtime.
   *  Null until the registry has been fetched. */
  computed: number | null
  /** Every call site there is: `inProject + outOfProject + unknown`. */
  total: number
  /**
   * Whether the unresolved sites have been split by reason yet.
   *
   * False until the registry lands, and then everything unresolved sits in
   * `unknown` -- because nothing has said otherwise.  That understates
   * `outOfProject` rather than inventing a split, and the HUD says so rather
   * than showing a proportion that is about to change meaning.
   */
  classified: boolean
}

/** Read the coverage buckets out of the export (and the registry, if in). */
export function callFlowCoverage(
  stats: GraphStats,
  registry: SymbolRegistry | null,
): FlowCoverage {
  const inProject = stats.calls_resolved ?? 0
  const heuristic = stats.calls_heuristic ?? 0
  const unresolved = stats.calls_unresolved ?? 0
  const builtin = stats.calls_builtin ?? 0
  const total = inProject + unresolved + builtin

  if (!registry) {
    // Builtins are the one out-of-project bucket `codebase_graph.json` counts
    // on its own, so it is honest even before the reasons arrive.
    return {
      inProject,
      heuristic,
      outOfProject: builtin,
      unknown: unresolved,
      computed: null,
      total,
      classified: false,
    }
  }

  let out = 0
  let computed = 0
  for (const call of registry.unresolved_calls) {
    const destination = destinationOf(call.reason)
    if (destination === 'out-of-project') out++
    else if (destination === 'computed') computed++
  }
  return {
    inProject,
    heuristic,
    outOfProject: builtin + out,
    unknown: unresolved - out,
    computed,
    total,
    classified: true,
  }
}

/**
 * The one always-visible line the mode wears while it is active (tic-171f).
 *
 * States proportions, never excuses: partial resolution is the normal
 * condition of static analysis on a dynamic language, and the line reads as
 * a fact about the data rather than a fault in the tool.  Until the reasons
 * are in it shows the split it can stand behind and says the rest is coming,
 * instead of publishing an `unknown` share that will drop by half a second
 * later.
 */
export function formatCoverageHud(coverage: FlowCoverage): string {
  const share = (n: number): string =>
    coverage.total > 0 ? `${Math.round((n / coverage.total) * 100)}%` : '0%'
  const parts = [
    `${coverage.total.toLocaleString()} call sites`,
    `${share(coverage.inProject)} in project`,
  ]
  if (!coverage.classified) {
    parts.push(`${share(coverage.outOfProject + coverage.unknown)} elsewhere — classifying…`)
    return parts.join(' · ')
  }
  parts.push(`${share(coverage.outOfProject)} out of project`)
  parts.push(`${share(coverage.unknown)} unknown`)
  if (coverage.computed !== null && coverage.computed > 0) {
    parts.push(`${coverage.computed.toLocaleString()} computed callees`)
  }
  return parts.join(' · ')
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
