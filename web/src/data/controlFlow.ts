/**
 * Control-flow tags over the call graph (tic-5069): does A always call B,
 * sometimes call B, or both.
 *
 * tic-b47a put a breadcrumb on every call site -- the constructs between the
 * call and its enclosing definition, outermost first -- and shipped it on
 * every edge in the export. This turns those per-SITE breadcrumbs into
 * per-EDGE tags, and then rolls the edges up into per-NODE ones. No new
 * extraction: the parser already did the walk.
 *
 * ## The word is `unguarded`, and it is not negotiable
 *
 * A call at guard depth 0 is UNGUARDED, which is not "unconditional" and is
 * much less "always runs": an early `return` or `raise` above it kills it,
 * and the caller may itself be conditional. Anything user-facing has to say
 * unguarded too, or the UI repeats a claim the data cannot support. A true
 * "this call is unavoidable" needs a CFG and dominators, which is tic-3a20.
 *
 * ## What the tags are worth, measured
 *
 * The ticket set a kill switch: if nearly every edge came out `unguarded` the
 * tag would not be earning its ink and tic-23eb should not spend visual
 * budget on it. It clears, but not by as much as the ticket assumed, and two
 * of the six tags turn out to be near-dead:
 *
 * ```
 *                        carnot (3505 edges)   hypermenu (613 edges)
 *   unguarded                 77.9%                 74.2%
 *   guarded                   19.8%                 24.3%
 *   mixed                      2.2%                  1.5%
 *   looped                     8.6%                  9.3%
 *   error-path                 1.3%                  0.3%
 *   type-checking-only         0.0%                  0.0%
 * ```
 *
 * So roughly one edge in four carries something other than the default --
 * worth drawing. But `mixed`, which the ticket called "genuinely common", is
 * 2% and 1.5%; and `type-checking-only` fires ZERO times on both codebases,
 * because `if TYPE_CHECKING` guards imports rather than calls. Both are still
 * computed here, because they are correct and cost nothing, but tic-23eb
 * should know that a design leaning on either will look like it does nothing.
 *
 * The node roll-ups are the part that pays. On carnot 83 of 914 called
 * symbols are only ever called inside a loop, and 7 are only ever called from
 * an `except`/`finally` -- and those 7 are `_repair_json`, `_loose_load`,
 * `_closest`, `PluginError`. The tag found the error-recovery layer by its
 * wiring, which is exactly what it was for.
 */
import type { CallEdge, CallGraph } from './derive'
import { GUARD_TOKENS } from './types'

/**
 * Tokens whose call may run more than once. Mirrors `LOOP_TOKENS` in
 * adventure_call/models.py.
 *
 * `while:test` and `comprehension:test` are in here and are NOT in
 * {@link GUARD_TOKENS}: a while condition runs whenever the loop is reached,
 * so it is a loop position without being a guarded one.
 */
export const LOOP_TOKENS: ReadonlySet<string> = new Set([
  'for',
  'while',
  'while:test',
  'comprehension',
  'comprehension:if',
  'comprehension:test',
])

/** Tokens putting a call on an error-handling path. */
const ERROR_TOKENS: ReadonlySet<string> = new Set(['try:except', 'try:finally'])

/** The `if TYPE_CHECKING:` token the parser emits for a block that never runs. */
const TYPE_CHECKING_TOKEN = 'type-checking'

/**
 * How the call sites behind one edge relate to their enclosing bodies.
 *
 * - `unguarded` -- every site sits at guard depth 0.
 * - `guarded`   -- every site sits inside at least one guard.
 * - `mixed`     -- both, i.e. the same pair is reached two different ways.
 */
export type EdgeGuard = 'unguarded' | 'guarded' | 'mixed'

export interface EdgeTags {
  guard: EdgeGuard
  /** Some site sits in a loop, so the edge can fire more than once. */
  looped: boolean
  /**
   * EVERY site sits in a loop.  Kept apart from {@link looped} because the
   * node roll-up needs it: "this function is only ever called in a loop" is a
   * claim about every call site, and building it out of `looped` would let an
   * edge with one looped site and three ordinary ones vote yes.  Measured on
   * carnot the difference is 83 hot functions against 97.
   */
  allLooped: boolean
  /** EVERY site is in an `except` or `finally`: this call is error handling. */
  errorPath: boolean
  /** Every site is under `if TYPE_CHECKING`, so none of them is runtime flow.
   *  Measured at zero on both available codebases; see the module docstring. */
  typeCheckingOnly: boolean
  /**
   * EVERY site lies on every path through its caller (tic-3a20): if the
   * caller runs, this call runs.
   *
   * The honest form of `guard === 'unguarded'`, and a strictly stronger
   * claim -- an early `return` above a call leaves it unguarded and not
   * certain. Measured on ../carnot, 887 of 3313 unguarded drawn sites (27%)
   * fail it; on hypermenu 113 of 535 (21%). Null on a pre-v9 export, which is
   * different from false: `certain === null` means the export could not say,
   * and a UI must not read it as "no".
   */
  certain: boolean | null
  /** Call sites behind the edge. */
  sites: number
}

/** What every incoming edge agrees on about a called symbol. */
export interface NodeControlTags {
  /** Every caller calls it from an error path, whatever it is named. */
  errorHandler: boolean
  /** Every incoming call site is inside a loop. */
  hot: boolean
  /**
   * No caller ever reaches it unguarded.
   *
   * True of about a quarter of called symbols on both codebases, which makes
   * it too common to badge but perfectly good to filter or sort on -- so it
   * is derived and left for a consumer to decide about.
   */
  alwaysGuarded: boolean
  /** In-project edges into this symbol that carried breadcrumbs. */
  callers: number
}

export interface ControlFlowTags {
  /** Edge key (see {@link edgeKey}) -> its tags. Edges with no breadcrumbs --
   *  the implicit `class -> __init__` edge, or a pre-v3 export -- are absent. */
  edgeOf: ReadonlyMap<string, EdgeTags>
  /** Callee symbol id -> what its incoming edges agree on. */
  nodeOf: ReadonlyMap<string, NodeControlTags>
}

/** The key an edge's tags are stored under. NUL-separated because a symbol id
 *  can contain almost anything else. */
export function edgeKey(source: string, target: string): string {
  return `${source}\u0000${target}`
}

/**
 * The tags for one edge, from its per-site breadcrumbs.
 *
 * `errorPath` and `typeCheckingOnly` require EVERY site to qualify, because
 * they are claims about the edge ("this call is error handling"); `looped`
 * requires only one, because it is a claim about what can happen ("this can
 * fire N times"). An edge with no sites gets nothing -- there is no honest
 * tag for a call that was never made.
 */
export function edgeTagsOf(
  controls: readonly (readonly string[])[] | undefined,
  certains?: readonly boolean[],
): EdgeTags | null {
  if (!controls || controls.length === 0) return null

  // Every site or nothing, like `allLooped` and for the same reason: an edge
  // is only unavoidable if all of its sites are, and letting one certain site
  // vote for three uncertain ones would restate the claim the CFG exists to
  // replace. A pre-v9 export has no `certains` and gets null, not false.
  const certain =
    certains === undefined || certains.length === 0 ? null : certains.every(Boolean)

  let unguarded = 0
  let guarded = 0
  let looped = false
  let allLooped = true
  let errorPath = true
  let typeCheckingOnly = true

  for (const control of controls) {
    let depth = 0
    let inLoop = false
    let inError = false
    let inTypeChecking = false
    for (const token of control) {
      if (GUARD_TOKENS.has(token)) depth++
      if (LOOP_TOKENS.has(token)) inLoop = true
      if (ERROR_TOKENS.has(token)) inError = true
      if (token === TYPE_CHECKING_TOKEN) inTypeChecking = true
    }
    if (depth === 0) unguarded++
    else guarded++
    if (inLoop) looped = true
    else allLooped = false
    if (!inError) errorPath = false
    if (!inTypeChecking) typeCheckingOnly = false
  }

  return {
    guard: unguarded > 0 && guarded > 0 ? 'mixed' : guarded > 0 ? 'guarded' : 'unguarded',
    looped,
    allLooped,
    errorPath,
    typeCheckingOnly,
    certain,
    sites: controls.length,
  }
}

const cache = new WeakMap<CallGraph, ControlFlowTags>()

/**
 * Tag every edge in the call graph, then roll the edges up onto their callees.
 *
 * A node's tags are what ALL its incoming edges agree on, so one ordinary
 * caller is enough to stop a symbol being called an error handler -- which is
 * the point. A symbol nothing calls has no entry: "every one of no callers"
 * is a vacuous truth and reporting it as a finding would be the same mistake
 * `testOnly` avoids in callMetrics.
 *
 * Memoised on the call graph, like every other derivation here.
 */
export function deriveControlFlowTags(callGraph: CallGraph): ControlFlowTags {
  const cached = cache.get(callGraph)
  if (cached) return cached

  const edgeOf = new Map<string, EdgeTags>()
  const incoming = new Map<string, EdgeTags[]>()

  for (const edges of callGraph.callees.values()) {
    for (const edge of edges as readonly CallEdge[]) {
      const tags = edgeTagsOf(edge.controls)
      if (tags === null) continue
      edgeOf.set(edgeKey(edge.source, edge.target), tags)
      const bucket = incoming.get(edge.target)
      if (bucket) bucket.push(tags)
      else incoming.set(edge.target, [tags])
    }
  }

  const nodeOf = new Map<string, NodeControlTags>()
  for (const [target, tags] of incoming) {
    nodeOf.set(target, {
      errorHandler: tags.every((edge) => edge.errorPath),
      hot: tags.every((edge) => edge.allLooped),
      alwaysGuarded: tags.every((edge) => edge.guard === 'guarded'),
      callers: tags.length,
    })
  }

  const result: ControlFlowTags = { edgeOf, nodeOf }
  cache.set(callGraph, result)
  return result
}
