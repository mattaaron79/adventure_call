/**
 * What the READS/WRITES edges are for (tic-675a): the blast radius of a
 * change, and the state a function touches.
 *
 * ## Why this is not a union of two lookups
 *
 * "Who reads X" is a map lookup. "Who breaks if X changes" is a different and
 * much more useful question, because a function that calls a reader is
 * affected without ever naming X. Composing the two edge types is the whole
 * point, and it is the first place in this codebase where a traversal spans
 * more than one kind of edge -- so {@link closureFrom} takes its step function
 * as a parameter and knows nothing about which edges it is walking. CALLS +
 * READS is what this module uses it for; CALLS + IMPORTS would work unchanged.
 *
 * ## Impact walks CALLERS, never callees
 *
 * If `f` reads X and `g` calls `f`, then changing X can change what `g` does,
 * so `g` belongs in the blast radius. The functions `f` CALLS do not, at least
 * not on this evidence: a value derived from X reaching them would require
 * following arguments through the call, and nothing in the export does that.
 *
 * Note which way the cost runs. Summed over every variable on ../carnot the
 * caller closure is 21699 symbols against the callee closure's 5548, so
 * walking callers is the EXPENSIVE direction, not the safe one -- it is chosen
 * because it is what the question means, and the budget below exists because
 * of what that costs.
 *
 * ## The direction reverses for the other question
 *
 * "What state does this function touch" composes the other way: the variables
 * it accesses directly, plus those accessed by everything it transitively
 * CALLS. Same traversal, opposite adjacency, which is exactly why the
 * traversal takes the adjacency as an argument.
 *
 * ## Read these next to tic-171f's coverage
 *
 * Every answer here rests on the resolved graph twice over -- once for the
 * access edges and once for the call edges -- so both are lower bounds. A
 * function missing from a blast radius has not been cleared; it has not been
 * seen. The vocabulary keeps that visible: `reached` never becomes "affected",
 * and a truncated walk says so.
 */
import type { CallGraph, SymbolIndex } from './derive'
import type { GraphEdge } from './types'

/**
 * READS and WRITES edges indexed in all four directions.
 *
 * Both directions of both edge types, because the two questions this module
 * answers need opposite ones and neither is derivable from the other without a
 * scan of every edge.
 */
export interface AccessIndex {
  /** Variable id -> the symbols that read it. */
  readersOf: ReadonlyMap<string, readonly string[]>
  /** Variable id -> the symbols that write it. */
  writersOf: ReadonlyMap<string, readonly string[]>
  /** Symbol id -> the variables it reads. */
  readsBy: ReadonlyMap<string, readonly string[]>
  /** Symbol id -> the variables it writes. */
  writesBy: ReadonlyMap<string, readonly string[]>
  /**
   * Module-level variables with more than one writer, in export order --
   * shared mutable state, which needs no analysis beyond counting and is the
   * cheapest finding in the module.
   *
   * Module-level only. A class attribute written by three methods is ordinary
   * object state and flagging it would cry wolf on every class in the project;
   * a module-level variable written from two places is a global being mutated,
   * which is worth a second look whatever the project.
   */
  sharedState: readonly string[]
}

const accessCache = new WeakMap<readonly GraphEdge[], WeakMap<SymbolIndex, AccessIndex>>()

/**
 * Index the READS and WRITES edges (tic-13d7). Memoised per (edges, index).
 *
 * Endpoints are resolved through the index like every other derivation here,
 * so an edge touching something the excludes or the file query removed is
 * dropped rather than left dangling -- the guard whose absence crashed elk in
 * tic-56b2.
 */
export function deriveAccesses(
  edges: readonly GraphEdge[],
  index: SymbolIndex,
): AccessIndex {
  let perIndex = accessCache.get(edges)
  if (!perIndex) {
    perIndex = new WeakMap()
    accessCache.set(edges, perIndex)
  }
  const cached = perIndex.get(index)
  if (cached) return cached

  const readersOf = new Map<string, string[]>()
  const writersOf = new Map<string, string[]>()
  const readsBy = new Map<string, string[]>()
  const writesBy = new Map<string, string[]>()

  const add = (map: Map<string, string[]>, key: string, value: string): void => {
    const known = map.get(key)
    if (!known) map.set(key, [value])
    else if (!known.includes(value)) known.push(value)
  }

  for (const edge of edges) {
    const reads = edge.types.includes('READS')
    const writes = edge.types.includes('WRITES')
    if (!reads && !writes) continue
    if (!index.byId.has(edge.source) || !index.byId.has(edge.target)) continue
    if (edge.source === edge.target) continue
    if (reads) {
      add(readersOf, edge.target, edge.source)
      add(readsBy, edge.source, edge.target)
    }
    if (writes) {
      add(writersOf, edge.target, edge.source)
      add(writesBy, edge.source, edge.target)
    }
  }

  const sharedState: string[] = []
  for (const [variable, writers] of writersOf) {
    if (writers.length < 2) continue
    const node = index.byId.get(variable)
    if (node?.kind === 'variable') sharedState.push(variable)
  }

  const result: AccessIndex = { readersOf, writersOf, readsBy, writesBy, sharedState }
  perIndex.set(index, result)
  return result
}

/**
 * How far a composed traversal will walk before it stops and says so.
 *
 * Larger than mode 3's rooted budget (80) because this produces a LIST rather
 * than a drawing, and a list of two hundred is still readable where a canvas
 * of two hundred chips is not.
 *
 * It is reached in earnest, not as a guard: on ../carnot the blast radius has
 * a median of 9 but a p90 of 202, and 68 of 496 variables saturate the cap
 * (hypermenu: median 2, p90 67, none saturating). That distribution is itself
 * the finding -- most state is local to a handful of functions, and a tenth of
 * it reaches everything -- so a UI must render a truncated count as `200+`
 * and never as `200`.
 */
export const CLOSURE_BUDGET = 200

export interface Closure {
  /** Everything reached from the seeds, excluding the seeds themselves. */
  reached: readonly string[]
  /** True when the budget stopped the walk, so the list is a floor. */
  truncated: boolean
}

/**
 * Breadth-first closure from `seeds`, expanding through `step`.
 *
 * Deliberately knows nothing about edges. This is the generic half tic-675a
 * asked for: it composes CALLS with READS here, and would compose CALLS with
 * IMPORTS unchanged.
 *
 * Terminates on a cyclic graph because the visited set is seeded with the
 * seeds and every node enters it before it is expanded -- mutual recursion in
 * the call graph is ordinary, not exotic, and a traversal that hung on it
 * would be useless on any real codebase.
 */
export function closureFrom(
  seeds: Iterable<string>,
  step: (id: string) => Iterable<string>,
  budget: number = CLOSURE_BUDGET,
): Closure {
  const seen = new Set<string>(seeds)
  const reached: string[] = []
  let frontier = [...seen]
  let truncated = false

  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      for (const target of step(id)) {
        if (seen.has(target)) continue
        if (reached.length >= budget) {
          truncated = true
          break
        }
        seen.add(target)
        reached.push(target)
        next.push(target)
      }
      if (truncated) break
    }
    if (truncated) break
    frontier = next
  }

  return { reached, truncated }
}

/** Callers of a symbol, excluding itself: the step function impact walks. */
export function callersStep(callGraph: CallGraph): (id: string) => string[] {
  return (id) =>
    (callGraph.callers.get(id) ?? [])
      .map((edge) => edge.source)
      .filter((source) => source !== id)
}

/** Callees of a symbol, excluding itself. */
export function calleesStep(callGraph: CallGraph): (id: string) => string[] {
  return (id) =>
    (callGraph.callees.get(id) ?? [])
      .map((edge) => edge.target)
      .filter((target) => target !== id)
}

export interface VariableImpact {
  /** Symbols that read the variable directly. */
  readers: readonly string[]
  /** Symbols that write it directly. */
  writers: readonly string[]
  /**
   * Symbols that reach a reader or a writer through CALLS, and so are
   * affected without naming the variable at all. Excludes the direct sets.
   */
  reached: readonly string[]
  /** True when {@link CLOSURE_BUDGET} stopped the walk. */
  truncated: boolean
  /** More than one function writes it, and it is module-level. */
  shared: boolean
}

/**
 * The blast radius of changing one variable or attribute.
 *
 * `readers` and `writers` are what the edges say directly; `reached` is the
 * composition, and is the part no single edge type could answer. A variable
 * nothing touches comes back with three empty lists rather than null, because
 * "nothing reads this" is a finding worth rendering, not an absence.
 */
export function variableImpact(
  callGraph: CallGraph,
  accesses: AccessIndex,
  variableId: string,
  budget: number = CLOSURE_BUDGET,
): VariableImpact {
  const readers = accesses.readersOf.get(variableId) ?? []
  const writers = accesses.writersOf.get(variableId) ?? []
  const direct = new Set([...readers, ...writers])
  const { reached, truncated } = closureFrom(direct, callersStep(callGraph), budget)
  return {
    readers,
    writers,
    reached,
    truncated,
    shared: accesses.sharedState.includes(variableId),
  }
}

export interface TouchedState {
  /** Variables the symbol reads itself. */
  reads: readonly string[]
  /** Variables it writes itself. */
  writes: readonly string[]
  /**
   * Variables reached only through what it calls, transitively. Excludes
   * anything already in `reads` or `writes`, so the three lists partition.
   */
  throughCalls: readonly string[]
  /** True when {@link CLOSURE_BUDGET} stopped the walk. */
  truncated: boolean
}

/**
 * The state one function touches, directly and through everything it calls.
 *
 * The mirror of {@link variableImpact}, and the reason `closureFrom` takes its
 * adjacency as an argument: this walks CALLEES where impact walks callers.
 *
 * `throughCalls` is the answer a reader cannot get by looking at the function's
 * body, and it is where the surprises live -- a function that looks pure
 * because it touches nothing itself, five calls above something that mutates a
 * module global.
 */
export function stateTouchedBy(
  callGraph: CallGraph,
  accesses: AccessIndex,
  symbolId: string,
  budget: number = CLOSURE_BUDGET,
): TouchedState {
  const reads = accesses.readsBy.get(symbolId) ?? []
  const writes = accesses.writesBy.get(symbolId) ?? []
  const own = new Set([...reads, ...writes])

  const { reached, truncated } = closureFrom([symbolId], calleesStep(callGraph), budget)
  const indirect = new Set<string>()
  for (const callee of reached) {
    for (const variable of accesses.readsBy.get(callee) ?? []) {
      if (!own.has(variable)) indirect.add(variable)
    }
    for (const variable of accesses.writesBy.get(callee) ?? []) {
      if (!own.has(variable)) indirect.add(variable)
    }
  }

  return { reads, writes, throughCalls: [...indirect], truncated }
}
