/**
 * Effect propagation (tic-7189): which functions transitively touch I/O.
 *
 * A function's effect set is its own direct effects -- calls out to known
 * effectful external targets -- unioned with the effect sets of everything it
 * can reach.  The result is one of the strongest inputs a summariser (human or
 * LLM) can have: "this function transitively touches the filesystem and the
 * network" decides whether something is safe to call, cache or reorder.
 *
 * ## Where direct effects come from
 *
 * `codebase_graph.json` keeps only calls that resolved to an in-project
 * symbol, so every call into stdlib or a third-party package survives only in
 * the registry's `unresolved_calls` with a reason of `external: <dotted
 * target>` -- the same channel the `deriveExternalCalls` layer of
 * {@link ../data/derive} reads.  No new extraction; this is pure
 * classification over data the app already holds, exactly as tic-22db's
 * entry points are.
 *
 * ## The seed list is DATA, and the caller may replace it
 *
 * Like tic-22db's decorator map, the seed list is a flat array a human edits,
 * and every consumer takes it as a parameter defaulting to
 * {@link DEFAULT_EFFECT_RULES}.  Every codebase has its own I/O wrappers --
 * `db.execute`, `s3.upload_file`, a project-local `http` helper -- and half
 * the value of the derivation comes from someone adding theirs as one line.
 *
 * Matching is by dotted-path SEGMENT prefix: the rule `subprocess` matches the
 * targets `subprocess` and `subprocess.run` but not `subprocess_only`.  All
 * matching rules contribute; their kinds are unioned.
 *
 * ## What the export cannot see (read before trusting a purity claim)
 *
 * - Builtin calls (`open`, `print`) are excluded from `unresolved_calls` as
 *   noise by the resolver, so those rules match nothing today.  They stay in
 *   the list because they are correct and the list is data: a future export
 *   that records builtins per caller lights them up with no change here.
 * - `import os` collapses every `os.*` call to the target `os`, and `os` also
 *   carries pure calls (`os.path.join`), so the defaults deliberately do NOT
 *   claim `os`.  `from os import environ` records as `os.environ` and IS
 *   matched.  A codebase that reads the environment through `os.` can add
 *   `{ target: 'os', kinds: ['env'] }` and accept the over-match.
 * - `datetime.now()` records as its binding target `datetime.datetime`, so
 *   that is the entry that fires; the `datetime.now` spelling is kept for
 *   exports where the full chain survives.
 * - Attribute reads (`os.environ["X"]`), and any call the resolver could not
 *   follow, contribute nothing.  An empty effect set therefore means
 *   PROBABLY pure -- never pure -- and {@link EffectIndex.probablyPure} is
 *   named to keep the UI honest about it.
 */

import type { CallGraph } from './derive'
import type { SymbolRegistry } from './types'

/**
 * The vocabulary of effects.  Fixed on purpose: consumers branch on these
 * (an LLM summariser weighs `network` differently from `console`), so a
 * freeform string would trade compile-time safety for nothing.
 */
export type EffectKind =
  | 'filesystem'
  | 'network'
  | 'process'
  | 'env'
  | 'console'
  | 'nondeterminism'

/** Canonical display order -- filesystem first, whimsy last. */
const KIND_ORDER: readonly EffectKind[] = [
  'filesystem',
  'network',
  'process',
  'env',
  'console',
  'nondeterminism',
]

/**
 * One seed entry: an external target prefix and the effects calling into it
 * produces.  `target` is the dotted path exactly as the resolver writes it
 * after `external: ` -- a module (`subprocess`), a dotted symbol
 * (`pathlib.Path`), or a dotted attribute (`os.environ`).
 */
export interface EffectRule {
  target: string
  kinds: readonly EffectKind[]
}

/**
 * The default seed list.  Aimed at what a Python codebase actually touches:
 * the stdlib's I/O surfaces and the two dominant HTTP clients.  Measured on
 * the ../carnot export, the entries that fire are `pathlib` (81 sites),
 * `time` (27), `datetime.datetime` (12), `subprocess` (5) and `httpx` (5);
 * the rest are here for the codebases that need them.
 */
export const DEFAULT_EFFECT_RULES: readonly EffectRule[] = [
  // Filesystem.  `open` is a builtin and never reaches the matcher today (see
  // the module comment); kept because the entry is correct and the list is
  // data a future export can light up without a code change.
  { target: 'open', kinds: ['filesystem'] },
  { target: 'pathlib', kinds: ['filesystem'] },
  { target: 'shutil', kinds: ['filesystem'] },

  // Network.
  { target: 'socket', kinds: ['network'] },
  { target: 'requests', kinds: ['network'] },
  { target: 'httpx', kinds: ['network'] },
  { target: 'urllib', kinds: ['network'] },

  // Process.
  { target: 'subprocess', kinds: ['process'] },

  // Environment.  `os.environ`, not `os`: `os.path.join` is pure, and an
  // `import os` codebase collapses every os.* call to the target `os`.
  { target: 'os.environ', kinds: ['env'] },

  // Console.
  { target: 'print', kinds: ['console'] },
  { target: 'logging', kinds: ['console'] },

  // Nondeterminism.  `datetime.datetime` is the binding target the resolver
  // records for `datetime.now()`; see the module comment.
  { target: 'random', kinds: ['nondeterminism'] },
  { target: 'time', kinds: ['nondeterminism'] },
  { target: 'datetime.datetime', kinds: ['nondeterminism'] },
  { target: 'datetime.now', kinds: ['nondeterminism'] },
]

/**
 * The effects of ONE external target, under these rules.
 *
 * Every rule whose `target` is the given target or a dotted-path prefix of it
 * contributes; the result is the union in {@link KIND_ORDER} order, so a UI
 * listing effects gets a stable sequence whatever order the rules came in.
 */
export function effectsForTarget(
  target: string,
  rules: readonly EffectRule[] = DEFAULT_EFFECT_RULES,
): EffectKind[] {
  const hit = new Set<EffectKind>()
  for (const rule of rules) {
    if (target === rule.target || target.startsWith(`${rule.target}.`)) {
      for (const kind of rule.kinds) hit.add(kind)
    }
  }
  return KIND_ORDER.filter((kind) => hit.has(kind))
}

export interface EffectIndex {
  /**
   * Every node of {@link CallGraph.nodes} mapped to its transitive effect
   * set, in {@link KIND_ORDER} order.  Empty means PROBABLY pure -- the
   * export resolves only about half of all call sites, so an unseen dynamic
   * call could do anything.
   */
  effectsOf: ReadonlyMap<string, readonly EffectKind[]>
  /**
   * The nodes whose effect set is empty, in call-graph order.  The name is
   * the claim: a UI may say "probably pure" about these and nothing stronger.
   */
  probablyPure: readonly string[]
  /** The rule list actually applied, so a UI can show what it matched on. */
  rules: readonly EffectRule[]
}

/** The reason prefix the resolver puts on a call into stdlib/third-party code. */
const EXTERNAL_REASON = 'external: '

/** WeakMap needs an object key; this stands in for "no registry yet". */
const NO_REGISTRY: object = {}

const effectsCache = new WeakMap<
  CallGraph,
  WeakMap<object, WeakMap<readonly EffectRule[], EffectIndex>>
>()

/**
 * Propagate effects upward through tic-a8a6's condensed DAG.
 *
 * One memoised pass over the components in id order -- which
 * `stronglyConnectedComponents` documents as reverse topological, so every
 * callee's set is finished before any caller reads it.  A cyclic component's
 * members all share the component's set, which is a real statement and not an
 * approximation: mutually recursive functions can each reach everything the
 * other can, so their effects genuinely are identical (the same sharing
 * tic-1ecc's reach counts rest on).
 *
 * `registry` is optional because it is fetched lazily: startup runs on
 * `codebase_graph.json` alone, where nothing is known about external calls
 * and every function is vacuously probably-pure.  Pass it once it lands.
 * Memoised per (callGraph, registry, rules) -- hold the rules array stable
 * rather than rebuilding it per render, like every derivation in this layer.
 */
export function deriveEffects(
  callGraph: CallGraph,
  registry: SymbolRegistry | null = null,
  rules: readonly EffectRule[] = DEFAULT_EFFECT_RULES,
): EffectIndex {
  let perRegistry = effectsCache.get(callGraph)
  if (!perRegistry) {
    perRegistry = new WeakMap()
    effectsCache.set(callGraph, perRegistry)
  }
  const registryKey = registry ?? NO_REGISTRY
  let perRules = perRegistry.get(registryKey)
  if (!perRules) {
    perRules = new WeakMap()
    perRegistry.set(registryKey, perRules)
  }
  const cached = perRules.get(rules)
  if (cached) return cached

  // Direct effects, per caller, from the registry's external call sites.
  // Callers the excludes or file query removed are not call-graph nodes and
  // are dropped, the same guard every derivation over the registry applies.
  const nodes = new Set(callGraph.nodes)
  const direct = new Map<string, Set<EffectKind>>()
  if (registry) {
    for (const call of registry.unresolved_calls) {
      if (!call.reason?.startsWith(EXTERNAL_REASON)) continue
      if (!nodes.has(call.caller_id)) continue
      const kinds = effectsForTarget(call.reason.slice(EXTERNAL_REASON.length), rules)
      if (kinds.length === 0) continue
      let own = direct.get(call.caller_id)
      if (!own) {
        own = new Set()
        direct.set(call.caller_id, own)
      }
      for (const kind of kinds) own.add(kind)
    }
  }

  // Upward propagation over the condensation.  Component ids ascend in
  // reverse topological order, so sorting ascending visits callees first and
  // each component reads only finished sets -- one pass, no recursion, no
  // topological sort.  derive.test.ts pins that ordering property; if it ever
  // broke, a missing callee set would surface as a silently small effect set,
  // which is why the lookup below tolerates absence rather than crashing on
  // it -- but the tests, not this guard, are what keep the answer honest.
  const componentIds = [...callGraph.members.keys()].sort((a, b) => a - b)
  const byComponent = new Map<number, Set<EffectKind>>()
  for (const component of componentIds) {
    const set = new Set<EffectKind>()
    for (const member of callGraph.members.get(component) ?? []) {
      const own = direct.get(member)
      if (own) for (const kind of own) set.add(kind)
    }
    for (const callee of callGraph.condensed.get(component) ?? []) {
      const calleeSet = byComponent.get(callee)
      if (calleeSet) for (const kind of calleeSet) set.add(kind)
    }
    byComponent.set(component, set)
  }

  const effectsOf = new Map<string, readonly EffectKind[]>()
  const probablyPure: string[] = []
  for (const id of callGraph.nodes) {
    const component = callGraph.componentOf.get(id)!
    const set = byComponent.get(component) ?? new Set<EffectKind>()
    const kinds = KIND_ORDER.filter((kind) => set.has(kind))
    effectsOf.set(id, kinds)
    if (kinds.length === 0) probablyPure.push(id)
  }

  const result: EffectIndex = { effectsOf, probablyPure, rules }
  perRules.set(rules, result)
  return result
}
