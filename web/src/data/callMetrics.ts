/**
 * Per-callable numbers over the call graph (tic-1ecc): where a function sits,
 * how much it can set in motion, how much depends on it, what shape it has,
 * and how much of its own outgoing flow the export could actually resolve.
 *
 * These are what mode 3 styles and sorts by, and what an LLM summariser will
 * eventually read.  Everything here is computed from tic-a8a6's condensed DAG
 * and tic-22db's entry points plus data already in the export -- no new
 * extraction.
 *
 * ## Everything runs over the CONDENSED graph
 *
 * Reach and rank are only well defined on a DAG.  On the raw call graph a
 * cycle makes "what can this reach" self-referential and any memoised walk
 * unsound, so every traversal here runs over `callGraph.condensed` and the
 * answer is then shared by every member of a component.  That sharing is a
 * real statement, not an approximation: mutually recursive functions can each
 * reach everything the other can, so their reach genuinely is identical.  A
 * UI should say so rather than implying the members were measured apart.
 *
 * The walks lean on the ordering `stronglyConnectedComponents` documents --
 * component ids ascend in reverse topological order -- so a single pass from
 * 0 upwards has every callee's answer ready before it needs it, and a single
 * pass downwards does the same for callers.  No topological sort, no
 * recursion, no repeated work.
 */
import type { CallGraph, SymbolIndex } from './derive'
import type { EntryPoints } from './entryPoints'
import { isTestPath } from './roles'
import type { SymbolRegistry } from './types'

/**
 * The rough role a function's wiring gives it.
 *
 * - `leaf` -- calls nothing.  READ THIS ALONGSIDE {@link CallMetrics.coverage}:
 *   the export resolves only about half of all non-builtin call sites, so a
 *   great many "leaves" are really functions whose calls could not be
 *   followed.  On ../carnot, 972 nodes have no resolved callees but 719 of
 *   them do have unresolved call sites -- so most leaves are opaque, not
 *   terminal, and a UI that draws them as endpoints without the coverage
 *   figure beside them is lying.
 * - `pipe` -- exactly one caller and one callee.  A candidate for inlining.
 * - `hub` -- heavily called AND calling heavily.
 * - `facade` -- heavily called, calls little.
 * - `orchestrator` -- called by little, calls heavily.
 * - `plain` -- none of the above, which is most code.
 */
export type CallShape = 'leaf' | 'pipe' | 'hub' | 'facade' | 'orchestrator' | 'plain'

/** How much of one function's outgoing flow the export actually resolved. */
export interface CallCoverage {
  /** Call sites that resolved to an in-project symbol. */
  resolved: number
  /** Call sites the resolver could not place, builtins included. */
  unresolved: number
  /** `resolved + unresolved`; 0 means the function makes no calls at all. */
  total: number
}

export interface CallMetrics {
  /**
   * Layers from the nearest entry point, over the condensed DAG; 0 for an
   * entry itself.  Null when no entry reaches this function at all -- an
   * orphan, or something only reachable from one.  Null is deliberate rather
   * than a sentinel number: "unreachable" is not a large distance, and a
   * consumer that sorts by rank must decide where to put it rather than
   * having it silently land at one end.
   */
  rank: number | null
  /** Distinct callables reachable by following calls, excluding this one --
   *  the blast radius of running it. */
  reachDown: number
  /** Distinct callables that can reach this one, excluding it -- who is
   *  affected if it breaks. */
  reachUp: number
  /** In-project callers (edges, not call sites). */
  fanIn: number
  /** In-project callees (edges, not call sites). */
  fanOut: number
  shape: CallShape
  /**
   * Every in-project caller lives in a test file.  False for a function with
   * no callers at all: that is "nothing calls this", which {@link EntryPoints}
   * already says better, and reporting it as test-only would be a vacuous
   * truth dressed up as a finding.
   */
  testOnly: boolean
  /** Null until the registry has been loaded; see {@link deriveCallMetrics}. */
  coverage: CallCoverage | null
}

export interface CallMetricsIndex {
  metricOf: ReadonlyMap<string, CallMetrics>
  /**
   * The fan-in and fan-out at which this codebase counts as "many", derived
   * from its own 90th percentile rather than fixed, because the two
   * distributions are not alike and neither is portable: on ../carnot fan-in
   * runs to 67 with a long tail while fan-out tops out at 13.  A constant
   * tuned here would mislabel the next project.  Exposed so a UI can explain
   * what it means by "hub" instead of asserting it.
   */
  highFanIn: number
  highFanOut: number
  /** The deepest rank reached, for a consumer laying ranks out in bands. */
  maxRank: number
}

/** Below this, "many" is not a meaningful claim however thin the tail is. */
const MIN_HIGH_DEGREE = 3

/** WeakMap needs an object key; this stands in for "no registry yet". */
const NO_REGISTRY: object = {}

const metricsCache = new WeakMap<CallGraph, WeakMap<EntryPoints, WeakMap<object, CallMetricsIndex>>>()

/**
 * Compute every metric for every node of the call graph.
 *
 * `registry` is optional because it is fetched lazily: startup runs on
 * `codebase_graph.json` alone.  Without it every `coverage` is null and the
 * other metrics are unaffected; pass it once it lands and coverage fills in.
 * Memoised per (callGraph, entryPoints, registry).
 */
export function deriveCallMetrics(
  callGraph: CallGraph,
  index: SymbolIndex,
  entryPoints: EntryPoints,
  registry: SymbolRegistry | null = null,
): CallMetricsIndex {
  let perEntries = metricsCache.get(callGraph)
  if (!perEntries) {
    perEntries = new WeakMap()
    metricsCache.set(callGraph, perEntries)
  }
  let perRegistry = perEntries.get(entryPoints)
  if (!perRegistry) {
    perRegistry = new WeakMap()
    perEntries.set(entryPoints, perRegistry)
  }
  const registryKey = registry ?? NO_REGISTRY
  const cached = perRegistry.get(registryKey)
  if (cached) return cached

  const memberCount = new Map<number, number>()
  for (const [id, members] of callGraph.members) memberCount.set(id, members.length)

  const rankOf = rankComponents(callGraph, entryPoints)
  const down = reachCounts(callGraph, memberCount, 'down')
  const up = reachCounts(callGraph, memberCount, 'up')

  const fanIn = new Map<string, number>()
  const fanOut = new Map<string, number>()
  for (const id of callGraph.nodes) {
    fanIn.set(id, callGraph.callers.get(id)?.length ?? 0)
    fanOut.set(id, callGraph.callees.get(id)?.length ?? 0)
  }
  const highFanIn = highDegree([...fanIn.values()])
  const highFanOut = highDegree([...fanOut.values()])

  const coverageOf = registry ? callCoverage(callGraph, registry) : null

  const metricOf = new Map<string, CallMetrics>()
  let maxRank = 0
  for (const id of callGraph.nodes) {
    const component = callGraph.componentOf.get(id)!
    const rank = rankOf.get(component) ?? null
    if (rank !== null && rank > maxRank) maxRank = rank

    const inDegree = fanIn.get(id)!
    const outDegree = fanOut.get(id)!
    // Reach counts the component's whole reachable membership; the node
    // itself is one of those members, so drop it to answer "how much OTHER
    // code is involved".
    const reachDown = Math.max(0, (down.get(component) ?? 0) - 1)
    const reachUp = Math.max(0, (up.get(component) ?? 0) - 1)

    metricOf.set(id, {
      rank,
      reachDown,
      reachUp,
      fanIn: inDegree,
      fanOut: outDegree,
      shape: shapeOf(inDegree, outDegree, highFanIn, highFanOut),
      testOnly: isTestOnly(callGraph, index, id),
      coverage: coverageOf?.get(id) ?? null,
    })
  }

  const result: CallMetricsIndex = { metricOf, highFanIn, highFanOut, maxRank }
  perRegistry.set(registryKey, result)
  return result
}

/**
 * Breadth-first layers from the entry components.  BFS rather than a DFS
 * depth because the metric is distance from the NEAREST entry: with several
 * roots reaching the same function by paths of different lengths, the short
 * one is the answer, and BFS settles that by construction.
 */
function rankComponents(callGraph: CallGraph, entryPoints: EntryPoints): Map<number, number> {
  const rank = new Map<number, number>()
  let frontier: number[] = []
  for (const id of entryPoints.entries) {
    const component = callGraph.componentOf.get(id)
    if (component === undefined || rank.has(component)) continue
    rank.set(component, 0)
    frontier.push(component)
  }

  let depth = 0
  while (frontier.length > 0) {
    depth++
    const next: number[] = []
    for (const component of frontier) {
      for (const target of callGraph.condensed.get(component) ?? []) {
        if (rank.has(target)) continue
        rank.set(target, depth)
        next.push(target)
      }
    }
    frontier = next
  }
  return rank
}

/**
 * Transitive reach per component, counted in member callables.
 *
 * Runs in one pass over the components in id order -- ascending for callees,
 * descending for callers -- which the reverse-topological id assignment makes
 * enough: by the time a component is visited, everything it depends on has
 * been done.  The intermediate sets are component ids, so the working memory
 * is bounded by the number of components rather than by the number of nodes.
 */
function reachCounts(
  callGraph: CallGraph,
  memberCount: Map<number, number>,
  direction: 'down' | 'up',
): Map<number, number> {
  const adjacency = new Map<number, number[]>()
  if (direction === 'down') {
    for (const [from, targets] of callGraph.condensed) adjacency.set(from, [...targets])
  } else {
    for (const id of callGraph.members.keys()) adjacency.set(id, [])
    for (const [from, targets] of callGraph.condensed) {
      for (const to of targets) adjacency.get(to)!.push(from)
    }
  }

  const ids = [...callGraph.members.keys()].sort((a, b) =>
    direction === 'down' ? a - b : b - a,
  )
  const reach = new Map<number, Set<number>>()
  for (const id of ids) {
    const seen = new Set<number>([id])
    for (const next of adjacency.get(id) ?? []) {
      // Always already computed: the id order is reverse topological, so a
      // callee's id is lower than its caller's (and vice versa going up).
      // derive.test.ts pins that property; if it ever broke, this would throw
      // rather than quietly return a number that is too small.
      for (const member of reach.get(next)!) seen.add(member)
    }
    reach.set(id, seen)
  }

  const counts = new Map<number, number>()
  for (const [id, components] of reach) {
    let total = 0
    for (const component of components) total += memberCount.get(component) ?? 0
    counts.set(id, total)
  }
  return counts
}

/** The degree at which this codebase counts as "many": its own 90th
 *  percentile, floored so a flat distribution cannot make "many" mean 1. */
function highDegree(degrees: number[]): number {
  if (degrees.length === 0) return MIN_HIGH_DEGREE
  const sorted = [...degrees].sort((a, b) => a - b)
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.9))]
  return Math.max(MIN_HIGH_DEGREE, p90)
}

function shapeOf(fanIn: number, fanOut: number, highIn: number, highOut: number): CallShape {
  // Leaf first: "flow stops here" is the dominant fact about a node in a
  // call-flow view, ahead of how popular it is.
  if (fanOut === 0) return 'leaf'
  if (fanIn === 1 && fanOut === 1) return 'pipe'
  const busyIn = fanIn >= highIn
  const busyOut = fanOut >= highOut
  if (busyIn && busyOut) return 'hub'
  if (busyIn) return 'facade'
  if (busyOut) return 'orchestrator'
  return 'plain'
}

function isTestOnly(callGraph: CallGraph, index: SymbolIndex, id: string): boolean {
  const callers = callGraph.callers.get(id)
  if (!callers || callers.length === 0) return false
  return callers.every((edge) => {
    const node = index.byId.get(edge.source)
    return node !== undefined && isTestPath(node.file_path)
  })
}

/**
 * Resolved and unresolved call sites per calling function.
 *
 * Resolved sites come from the edges' own `count`, which the exporter already
 * folded per caller/callee pair; the derived class -> `__init__` edge is
 * skipped because no call site produced it.  Unresolved sites come from the
 * registry, one entry per site, keyed by `caller_id` -- verified against the
 * real export to match graph node ids exactly (1793 of 1793 distinct
 * caller_ids resolve to a node).
 */
function callCoverage(
  callGraph: CallGraph,
  registry: SymbolRegistry,
): Map<string, CallCoverage> {
  const unresolved = new Map<string, number>()
  for (const call of registry.unresolved_calls) {
    unresolved.set(call.caller_id, (unresolved.get(call.caller_id) ?? 0) + 1)
  }

  const coverage = new Map<string, CallCoverage>()
  for (const id of callGraph.nodes) {
    let resolved = 0
    for (const edge of callGraph.callees.get(id) ?? []) {
      if (!edge.implicit) resolved += edge.count
    }
    const missed = unresolved.get(id) ?? 0
    coverage.set(id, { resolved, unresolved: missed, total: resolved + missed })
  }
  return coverage
}
