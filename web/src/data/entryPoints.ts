/**
 * Where execution enters the codebase (tic-22db) -- the roots mode 3 hangs
 * off, and the classification that keeps "nothing calls this" from being read
 * as "this is dead".
 *
 * Built on tic-a8a6's call graph plus the decorators and names already in the
 * export.  No new extraction; this is pure classification over data the app
 * already holds.
 *
 * ## Why in-degree zero is not enough on its own
 *
 * Measured on the ../carnot export: 1660 of 2574 callables (64%) have no
 * in-project caller.  Taking that at face value would nominate two thirds of
 * the codebase as entry points, which is useless as a root set and actively
 * misleading as a dead-code signal.  Two different things produce it:
 *
 * 1. Something outside the project calls them -- the test runner, a web
 *    framework's router, the language's own dunder protocol.  These are real
 *    entry points and {@link ../data/roles} is the evidence that identifies
 *    them.
 * 2. The caller exists but its call site did not resolve.  The export
 *    resolves only about half of all non-builtin call sites, so a function
 *    can look uncalled purely because the resolver could not follow the
 *    receiver.  Nothing here can distinguish that case from genuine disuse,
 *    which is exactly why {@link SymbolRole} tops out at "possibly unused"
 *    and never claims dead code.
 *
 * A caller has to keep those apart, and the role vocabulary is shaped so it
 * can: `framework-entry` is evidence-backed, `entry` and `orphan` are the
 * absence of evidence and inherit all of the export's uncertainty.
 */
import type { CallGraph, SymbolIndex } from './derive'
import { DEFAULT_ROLE_RULES, matchRole, type RoleRule } from './roles'

/**
 * How execution reaches a symbol.
 *
 * - `internal` -- something in the project calls it.  The ordinary case.
 * - `framework-entry` -- nothing in the project calls it, but a rule explains
 *   why: a decorator, a test-runner naming convention, the dunder protocol.
 *   A real root, with evidence.
 * - `entry` -- nothing calls it and no rule explains it, but it does call
 *   things, so it is the top of some flow.  A `__main__` block's helper, a
 *   script, or a function whose only callers went unresolved.
 * - `orphan` -- nothing calls it, it calls nothing, and no rule explains it.
 *   POSSIBLY unused; never state it more strongly than that.
 */
export type EntryRole = 'internal' | 'framework-entry' | 'entry' | 'orphan'

export interface SymbolRole {
  role: EntryRole
  /**
   * The framework contact a rule named -- 'test', 'route', 'dunder' and so on
   * -- or null when no rule matched.  Set whenever a rule matches, INCLUDING
   * on an `internal` symbol: that a method is a `@property` stays true and
   * worth showing even when the project also calls it directly.  Only combine
   * it with `role === 'framework-entry'` when you specifically mean "reached
   * from outside and from nowhere else".
   */
  framework: string | null
  /** Why the rule matched, e.g. `decorator @pytest.fixture`, for a UI that
   *  explains itself rather than asserting.  Null when no rule matched. */
  reason: string | null
}

export interface EntryPoints {
  /** Every node of {@link CallGraph.nodes}, classified. */
  roleOf: ReadonlyMap<string, SymbolRole>
  /**
   * The root set: everything reached from outside the project, in call-graph
   * order.  Both `framework-entry` and `entry`, because a mode wanting "where
   * does execution start" wants both -- the evidence-backed roots and the
   * unexplained ones.  Sort or split by `roleOf` when the difference matters.
   */
  entries: readonly string[]
  /** Symbols with no callers, no callees and no explanation. Possibly unused. */
  orphans: readonly string[]
  /** How many caller-less symbols a rule rescued from looking orphaned --
   *  the number that justifies the role map existing at all. */
  rescued: number
}

const entryPointCache = new WeakMap<CallGraph, WeakMap<readonly RoleRule[], EntryPoints>>()

/**
 * Classify every node of the call graph by how execution reaches it.
 *
 * `rules` is the framework-role map; it defaults to
 * {@link DEFAULT_ROLE_RULES} but is a parameter rather than a hardcoded
 * reference precisely so a project can supply its own without this module
 * changing.  Memoised per (callGraph, rules) pair, like every derivation in
 * this layer -- so a caller must hold its rule array stable rather than
 * rebuilding it per render.
 */
export function deriveEntryPoints(
  callGraph: CallGraph,
  index: SymbolIndex,
  rules: readonly RoleRule[] = DEFAULT_ROLE_RULES,
): EntryPoints {
  let perRules = entryPointCache.get(callGraph)
  if (!perRules) {
    perRules = new WeakMap()
    entryPointCache.set(callGraph, perRules)
  }
  const cached = perRules.get(rules)
  if (cached) return cached

  const roleOf = new Map<string, SymbolRole>()
  const entries: string[] = []
  const orphans: string[] = []
  let rescued = 0

  for (const id of callGraph.nodes) {
    const symbol = index.byId.get(id)
    const match = symbol ? matchRole(symbol, rules) : null
    const framework = match?.role ?? null
    const reason = match?.reason ?? null

    // An implicit class -> __init__ edge counts as a caller here on purpose:
    // constructing the class really does reach __init__, and treating it as
    // caller-less would nominate every constructor as an entry point.
    // A SELF-edge is not a caller (tic-d8a8).  A directly recursive function
    // is its own caller in the graph, but calling yourself is not something
    // reaching you: a recursive function nothing else calls is still a root,
    // and counting the self-edge classifies it `internal` and hides it from
    // the entry set entirely.  Found by mode 3 failing to draw one.
    if (hasCallerOtherThanItself(callGraph, id)) {
      roleOf.set(id, { role: 'internal', framework, reason })
      continue
    }

    if (match) {
      roleOf.set(id, { role: 'framework-entry', framework, reason })
      entries.push(id)
      rescued++
      continue
    }

    if (callsSomethingOtherThanItself(callGraph, id)) {
      roleOf.set(id, { role: 'entry', framework: null, reason: null })
      entries.push(id)
      continue
    }

    roleOf.set(id, { role: 'orphan', framework: null, reason: null })
    orphans.push(id)
  }

  const result: EntryPoints = { roleOf, entries, orphans, rescued }
  perRules.set(rules, result)
  return result
}

/** Whether anything OTHER than the symbol itself calls it. */
function hasCallerOtherThanItself(callGraph: CallGraph, id: string): boolean {
  return (callGraph.callers.get(id) ?? []).some((edge) => edge.source !== id)
}

/** Whether it calls anything OTHER than itself -- the difference between an
 *  `entry` that heads some flow and a self-recursive `orphan` that heads
 *  none. */
function callsSomethingOtherThanItself(callGraph: CallGraph, id: string): boolean {
  return (callGraph.callees.get(id) ?? []).some((edge) => edge.target !== id)
}
