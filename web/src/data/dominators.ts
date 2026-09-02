/**
 * Dominator-based chokepoints (tic-d8f2) -- the load-bearing walls.
 *
 * X dominates Y when every path from an entry point to Y passes through X, so
 * the set X strictly dominates is exactly what becomes unreachable if X is
 * removed. That is the honest form of "chokepoint", and it is a different
 * question from the fan-in and reach figures in {@link ./callMetrics}.
 *
 * ## Why fan-in is not a proxy for this
 *
 * Measured on the ../carnot export, the top twenty by dominated-subtree size
 * and the top twenty by fan-in overlap in exactly ONE symbol; against the top
 * twenty by reach they overlap in none. The shapes behind that:
 *
 *     fan-in  70  gates  5  reach 42   Session
 *     fan-in  59  gates  0  reach  0   ToolResult.success
 *     fan-in  11  gates 28  reach 30   audit_source
 *     fan-in   0  gates 15  reach 73   test_disabled_plugins_are_skipped
 *
 * `ToolResult.success` is called from 59 places, which is exactly why deleting
 * it disconnects nobody: everything reaching it either gets there some other
 * way too, or goes no further. Fan-in ranks POPULARITY. Reach ranks BLAST
 * RADIUS. Dominance ranks EXCLUSIVITY, and only the third answers "what breaks
 * if this goes". hypermenu reproduces all three, at overlap 1 and 2.
 *
 * ## The root set is entries UNION sources, and the union is load-bearing
 *
 * Rooting at tic-22db's entry set alone is not enough. An entry symbol has no
 * caller other than itself, but its COMPONENT can still have one: two mutually
 * recursive functions where something calls only the second form a component
 * with an inbound edge and no entry member. If that component heads a
 * subgraph, rooting only at entries never reaches it -- and worse, it would
 * let this claim dominance along paths the real graph contradicts. So every
 * source of the condensation is a root too.
 *
 * Measured, the union is currently free: ../carnot has 1586 entry components
 * and 1747 sources, and every one of the 161 sources with no entry member is
 * ISOLATED -- an orphan, gating nothing (hypermenu: 360, 390, and all 30
 * likewise isolated). Sources with outgoing edges and no entry member: zero on
 * both. So the rule changes no answer today. It is here for the shape that
 * makes the answer WRONG rather than merely incomplete, and that shape is one
 * mutual-recursion pair away.
 *
 * Because every node of a finite DAG is reachable from some source, that union
 * also means nothing is left unreachable and every component gets an idom.
 *
 * ## Read the numbers next to tic-171f's coverage
 *
 * Dominance is computed over the RESOLVED call graph, and ../carnot resolves
 * about 41% of its non-builtin call sites. One unresolved call into the middle
 * of a dominated region breaks the claim, so the phrasing a UI owes the reader
 * is "in the resolved call graph, everything reaching X goes through Y", never
 * "X is the only way in".
 *
 * That uncertainty also FLATTENS the tree, which is worth stating because the
 * numbers come out small. 2197 of ../carnot's 2716 components (81%) have the
 * super-root as their immediate dominator -- 1747 because they are sources at
 * all, the rest because more than one root reaches them -- and every caller
 * the resolver could not follow promotes its callee to a root. So 309 of 2718
 * symbols gate anything at all, median 1, maximum 28 (hypermenu: 487 of 584
 * under the super-root, 58 symbols gating, median 1, maximum 12).
 *
 * Those are real chokepoints. They are also the ceiling this export's
 * resolution allows rather than the codebase's, and a UI should not read the
 * flatness as "this codebase has no load-bearing walls".
 */
import type { CallGraph } from './derive'
import type { EntryPoints } from './entryPoints'

/**
 * The synthetic super-root every root component's idom points at.
 *
 * A call graph has no single entry, so dominance is computed against a node
 * standing in for "outside the project". It is not a component and never
 * appears in a ranking; it exists so that "dominated by nothing above it" and
 * "not in the tree at all" stay different states.
 */
export const SUPER_ROOT = -1

/** One load-bearing wall, as a whole component. */
export interface Chokepoint {
  /**
   * The component's members, in call-graph order. More than one means mutual
   * recursion, and then the claim is about the GROUP: every path goes through
   * one of these, not through any particular one.
   */
  members: readonly string[]
  /** How many OTHER symbols become unreachable from every entry without it. */
  gated: number
}

export interface DominatorIndex {
  /**
   * Component -> its immediate dominator, {@link SUPER_ROOT} for a root.
   * Every component of the call graph has an entry.
   */
  idomOf: ReadonlyMap<number, number>
  /**
   * The dominator tree downward: component -> the components it immediately
   * dominates, ascending. {@link SUPER_ROOT} keys the root set. Walk it to
   * enumerate what a chokepoint gates; {@link DominatorIndex.gatesOf} is that
   * walk's size, precomputed.
   */
  childrenOf: ReadonlyMap<number, readonly number[]>
  /**
   * Symbol -> how many other symbols are unreachable without it. 0 for most of
   * the codebase, and that is the finding rather than a gap.
   *
   * Members of a mutually recursive component share one figure, because the
   * figure belongs to the component: removing one member of a cycle leaves the
   * others standing, so the number is what the GROUP gates. The same sharing
   * {@link ./effects} and tic-1ecc's reach counts rest on.
   */
  gatesOf: ReadonlyMap<string, number>
  /**
   * Symbol -> the members of the component that immediately dominates it: the
   * last thing that must happen before this can. Empty for a root, and more
   * than one member means the answer is a mutually recursive group.
   */
  immediateDominatorOf: ReadonlyMap<string, readonly string[]>
  /**
   * Everything that gates at least one symbol, most first; ties broken by
   * component id, which is stable across renders. Short, by design and by
   * measurement: 307 of ../carnot's 2716 components appear here.
   */
  chokepoints: readonly Chokepoint[]
}

const dominatorCache = new WeakMap<CallGraph, WeakMap<EntryPoints, DominatorIndex>>()

/**
 * Dominators of tic-a8a6's condensed DAG, rooted at a super-root over
 * tic-22db's entries and every source (see the module comment).
 *
 * Cooper-Harvey-Kennedy: seed the root, then repeatedly set each node's idom
 * to the intersection of its already-computed predecessors' idoms, in reverse
 * postorder, until nothing changes. `intersect` walks two nodes up the partial
 * tree until they meet, comparing by reverse-postorder index.
 *
 * On a DAG reverse postorder puts every predecessor before its successor, so
 * the first pass is already the fixpoint and the second only confirms it --
 * measured at exactly 2 passes on both codebases. The loop stays because it is
 * the algorithm, and because one pass is exact only while the input is a DAG:
 * the condensation always is, but this module should not be the place that
 * silently depends on it.
 *
 * Memoised per (callGraph, entryPoints) pair, like every derivation in this
 * layer -- so a caller must hold its entry points stable rather than
 * rederiving them per render.
 */
export function deriveDominators(
  callGraph: CallGraph,
  entryPoints: EntryPoints,
): DominatorIndex {
  let perEntries = dominatorCache.get(callGraph)
  if (!perEntries) {
    perEntries = new WeakMap()
    dominatorCache.set(callGraph, perEntries)
  }
  const cached = perEntries.get(entryPoints)
  if (cached) return cached

  const roots = rootComponents(callGraph, entryPoints)
  const successors = (component: number): readonly number[] =>
    component === SUPER_ROOT ? roots : (callGraph.condensed.get(component) ?? [])

  const order = reversePostorder(successors)
  const predecessors = predecessorsOf(callGraph, roots)

  const idom = new Map<number, number>([[SUPER_ROOT, SUPER_ROOT]])
  const intersect = (a: number, b: number): number => {
    let x = a
    let y = b
    while (x !== y) {
      while (order.get(x)! > order.get(y)!) x = idom.get(x)!
      while (order.get(y)! > order.get(x)!) y = idom.get(y)!
    }
    return x
  }

  let changed = true
  while (changed) {
    changed = false
    for (const component of order.keys()) {
      if (component === SUPER_ROOT) continue
      let candidate: number | null = null
      for (const caller of predecessors.get(component) ?? []) {
        if (!idom.has(caller)) continue
        candidate = candidate === null ? caller : intersect(candidate, caller)
      }
      if (candidate !== null && idom.get(component) !== candidate) {
        idom.set(component, candidate)
        changed = true
      }
    }
  }

  const result = finish(callGraph, idom, order)
  perEntries.set(entryPoints, result)
  return result
}

/**
 * Every component execution can start at: one holding an entry symbol, plus
 * every source of the condensation. See the module comment for why the second
 * half is a correctness requirement rather than belt-and-braces.
 */
function rootComponents(callGraph: CallGraph, entryPoints: EntryPoints): number[] {
  const roots = new Set<number>()
  for (const id of entryPoints.entries) {
    const component = callGraph.componentOf.get(id)
    if (component !== undefined) roots.add(component)
  }
  for (const [component, callers] of callGraph.condensedCallers) {
    if (callers.length === 0) roots.add(component)
  }
  return [...roots].sort((a, b) => a - b)
}

/** The condensation reversed, with the super-root wired to the root set. */
function predecessorsOf(
  callGraph: CallGraph,
  roots: readonly number[],
): Map<number, number[]> {
  const predecessors = new Map<number, number[]>()
  for (const [component, callers] of callGraph.condensedCallers) {
    predecessors.set(component, [...callers])
  }
  for (const root of roots) {
    const into = predecessors.get(root)
    if (into) into.push(SUPER_ROOT)
    else predecessors.set(root, [SUPER_ROOT])
  }
  return predecessors
}

/**
 * Components in reverse postorder from the super-root, mapped to their index.
 *
 * Iterative rather than recursive: ../carnot condenses to 2716 components and
 * a deep chain of them would blow the stack -- the same reason
 * `stronglyConnectedComponents` is iterative.
 */
function reversePostorder(
  successors: (component: number) => readonly number[],
): Map<number, number> {
  const postorder: number[] = []
  const seen = new Set<number>([SUPER_ROOT])
  const stack: { component: number; next: number }[] = [{ component: SUPER_ROOT, next: 0 }]
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    const out = successors(frame.component)
    let descended = false
    while (frame.next < out.length) {
      const child = out[frame.next++]
      if (seen.has(child)) continue
      seen.add(child)
      stack.push({ component: child, next: 0 })
      descended = true
      break
    }
    if (!descended) {
      postorder.push(frame.component)
      stack.pop()
    }
  }

  const order = new Map<number, number>()
  for (let i = 0; i < postorder.length; i++) {
    order.set(postorder[postorder.length - 1 - i], i)
  }
  return order
}

/** Turn the component-level idom map into the per-symbol answers a UI wants. */
function finish(
  callGraph: CallGraph,
  idom: ReadonlyMap<number, number>,
  order: ReadonlyMap<number, number>,
): DominatorIndex {
  const childrenOf = new Map<number, number[]>()
  for (const [component, parent] of idom) {
    if (component === SUPER_ROOT) continue
    const siblings = childrenOf.get(parent)
    if (siblings) siblings.push(component)
    else childrenOf.set(parent, [component])
  }
  for (const siblings of childrenOf.values()) siblings.sort((a, b) => a - b)

  // Subtree sizes bottom-up. Descending reverse-postorder index visits every
  // child before its parent, because a dominator always precedes what it
  // dominates in reverse postorder.
  const deepestFirst = [...order.keys()].sort((a, b) => order.get(b)! - order.get(a)!)
  const subtree = new Map<number, number>()
  for (const component of deepestFirst) {
    let size = component === SUPER_ROOT ? 0 : (callGraph.members.get(component)?.length ?? 0)
    for (const child of childrenOf.get(component) ?? []) size += subtree.get(child) ?? 0
    subtree.set(component, size)
  }

  const gatesOf = new Map<string, number>()
  const immediateDominatorOf = new Map<string, readonly string[]>()
  const chokepoints: Chokepoint[] = []
  // Ascending component id, so the stable sort below leaves ties in that
  // order -- `members` is keyed in node order, which is not the same thing.
  const byId = [...callGraph.members.keys()].sort((a, b) => a - b)
  for (const component of byId) {
    const members = callGraph.members.get(component)!
    const gated = (subtree.get(component) ?? members.length) - members.length
    const parent = idom.get(component) ?? SUPER_ROOT
    const above = parent === SUPER_ROOT ? [] : (callGraph.members.get(parent) ?? [])
    for (const member of members) {
      gatesOf.set(member, gated)
      immediateDominatorOf.set(member, above)
    }
    if (gated > 0) chokepoints.push({ members, gated })
  }
  chokepoints.sort((a, b) => b.gated - a.gated)

  return { idomOf: idom, childrenOf, gatesOf, immediateDominatorOf, chokepoints }
}
