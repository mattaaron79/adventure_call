/**
 * Type flow (tic-59b1): the pipeline the annotations imply, over the same
 * nodes as the call graph.
 *
 * `A` returns `ToolResult` and `B` accepts `ToolResult`, so data can move
 * A -> B whether or not A ever calls B. That is a second kind of flow drawn
 * over the same node set, and the interesting reading is where the two
 * DISAGREE: two functions that pass the same type and never call each other
 * are either an unfinished pipeline or a missing abstraction, and the gap is
 * what a human is looking for.
 *
 * ## Coverage is partial, and the UI must not imply otherwise
 *
 * Measured on the ../carnot export, 1094 of 2528 callables carry a return
 * annotation and 1270 of 3539 parameters are annotated. That is enough to be
 * useful and nowhere near enough to be authoritative, and it improves on its
 * own as a codebase gets typed. Every count here is a floor.
 *
 * ## A string match on a normalised name is the right altitude
 *
 * No real type resolution, no generics, no variance. The failure mode of
 * matching too little is a link nobody sees; the failure mode of matching too
 * much is a line that asserts a relationship the code does not have. Only one
 * of those is recoverable by a reader, so everything here is built to miss
 * rather than to guess:
 *
 * - `Optional[T]` and `T | None` reduce to their members, `None` dropped.
 * - `Union[A, B]` and `A | B` reduce to BOTH members, because either can flow.
 * - the obvious containers unwrap to their type arguments, ALL of them:
 *   `dict[str, ToolResult]` yields `str` and `ToolResult`, and `str` costs
 *   nothing because it resolves to no project symbol and is dropped a step
 *   later. Picking "the" element type of a mapping would be a guess.
 * - a forward reference (`"ToolResult"`) loses its quotes.
 * - a dotted name keeps only its last segment, which is what the module's
 *   bindings are keyed by.
 * - anything left that does not resolve to a CLASS this project defines is
 *   dropped without trace. Builtins, stdlib and third-party types would
 *   otherwise link half the codebase to the other half through `str`.
 */
import type { SymbolIndex } from './derive'
import type { GraphNode, SymbolRegistry } from './types'

/**
 * Containers whose type arguments carry the payload.
 *
 * Written as bare last segments, so `collections.abc.Sequence` and
 * `typing.Sequence` both match. `Optional` and `Union` are handled separately
 * because they reduce to their members rather than unwrapping to a payload.
 */
const CONTAINERS = new Set([
  'list',
  'set',
  'frozenset',
  'tuple',
  'dict',
  'Sequence',
  'Iterable',
  'Iterator',
  'Collection',
  'Mapping',
  'MutableMapping',
  'List',
  'Set',
  'Dict',
  'Tuple',
  'Awaitable',
  'Coroutine',
  'AsyncIterator',
  'AsyncIterable',
])

/** Reduce to members rather than unwrapping to a payload. */
const UNIONS = new Set(['Optional', 'Union'])

/** Names that never carry a project type and are dropped before resolution. */
const EMPTY_TYPES = new Set(['None', 'Any', 'object', 'Self', '', '...'])

/** How deep the normaliser will unwrap before giving up on a nested generic. */
const MAX_DEPTH = 6

/**
 * The bare type names an annotation can stand for, deduplicated.
 *
 * `list[Optional[ToolResult]]` gives `['ToolResult']`; `dict[str, Result]`
 * gives `['str', 'Result']`; `int` gives `['int']`. Order is stable so a
 * caller can rely on it for display.
 */
export function normaliseAnnotation(annotation: string | null | undefined): string[] {
  const found: string[] = []
  walk(annotation ?? '', 0, found)
  return [...new Set(found)]
}

function walk(text: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return
  const source = text.trim()
  if (source === '') return

  // PEP 604 unions bind loosest, so they split before anything else -- but
  // only at the TOP level, or `dict[str | int, X]` would split wrongly.
  const alternatives = splitTop(source, '|')
  if (alternatives.length > 1) {
    for (const alternative of alternatives) walk(alternative, depth + 1, out)
    return
  }

  const open = source.indexOf('[')
  if (open === -1) {
    const bare = lastSegment(source)
    if (!EMPTY_TYPES.has(bare)) out.push(bare)
    return
  }

  const head = lastSegment(source.slice(0, open).trim())
  const inner = source.slice(open + 1, source.lastIndexOf(']'))
  if (UNIONS.has(head) || CONTAINERS.has(head)) {
    for (const argument of splitTop(inner, ',')) walk(argument, depth + 1, out)
    return
  }
  // An unknown generic keeps its head: `Result[int]` is a `Result`, and its
  // arguments are the project's business rather than this module's.
  if (!EMPTY_TYPES.has(head)) out.push(head)
}

/** Split on `separator` at bracket depth zero only. */
function splitTop(source: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < source.length; i++) {
    const character = source[i]
    if (character === '[' || character === '(') depth++
    else if (character === ']' || character === ')') depth--
    else if (character === separator && depth === 0) {
      parts.push(source.slice(start, i))
      start = i + 1
    }
  }
  parts.push(source.slice(start))
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * `types.ToolResult` -> `ToolResult`, which is what bindings are keyed by.
 *
 * This is also where a forward reference loses its quotes.  Stripping them
 * earlier, before the generic is unwrapped, reads more obviously -- but every
 * path through `walk` ends here, so an earlier strip changed nothing at all
 * and a mutation test proved it.
 */
function lastSegment(name: string): string {
  const cleaned = name.replace(/["']/g, '').trim()
  const dot = cleaned.lastIndexOf('.')
  return dot === -1 ? cleaned : cleaned.slice(dot + 1)
}

/**
 * Resolve a bare type name, as seen from one module, to a project class.
 *
 * Two places, in order: a class of that name defined in the module itself,
 * then the module's import bindings from the registry. Nothing else -- a
 * project-wide name search would resolve `Config` to whichever of four
 * same-named classes happened to be indexed first, and a wrong link is worse
 * than a missing one.
 *
 * Returns null for anything that is not an in-project CLASS, which is what
 * keeps `str` and `Path` and `httpx.Response` out of the graph.
 */
export function resolveTypeName(
  name: string,
  module: string,
  index: SymbolIndex,
  registry: SymbolRegistry | null,
): string | null {
  const local = `${module}.${name}`
  if (index.byId.get(local)?.kind === 'class') return local

  const binding = registry?.bindings?.[module]?.[name]
  if (binding && binding.kind === 'symbol' && binding.target) {
    if (index.byId.get(binding.target)?.kind === 'class') return binding.target
  }
  return null
}

/** The project classes one annotation can stand for, as symbol ids. */
export function typesOf(
  annotation: string | null | undefined,
  module: string,
  index: SymbolIndex,
  registry: SymbolRegistry | null,
): string[] {
  const found: string[] = []
  for (const name of normaliseAnnotation(annotation)) {
    const resolved = resolveTypeName(name, module, index, registry)
    if (resolved !== null && !found.includes(resolved)) found.push(resolved)
  }
  return found
}

export interface TypeFlowIndex {
  /** Class id -> the callables whose return annotation mentions it. */
  producersOf: ReadonlyMap<string, readonly string[]>
  /** Class id -> the callables that accept it as a parameter. */
  consumersOf: ReadonlyMap<string, readonly string[]>
  /** Callable id -> the classes it returns. */
  returnsOf: ReadonlyMap<string, readonly string[]>
  /** Callable id -> the classes it accepts. */
  acceptsOf: ReadonlyMap<string, readonly string[]>
  /**
   * How much of the annotation surface this rests on: annotated over total,
   * for returns and for parameters. Carried so a UI can state the coverage
   * rather than implying the picture is complete.
   */
  coverage: {
    annotatedReturns: number
    totalReturns: number
    annotatedParams: number
    totalParams: number
  }
}

const CALLABLE_KINDS = new Set(['function', 'method'])

const typeFlowCache = new WeakMap<SymbolIndex, WeakMap<object, TypeFlowIndex>>()

/** WeakMap needs an object key; this stands in for "no registry yet". */
const NO_REGISTRY: object = {}

/**
 * Index every annotated callable by the project classes it produces and
 * consumes (tic-59b1).
 *
 * A CONSTRUCTOR is not a producer of its own class here, and deliberately: the
 * call graph already draws `Foo()` reaching `Foo`, so adding a type-flow line
 * for it would restate a call edge in a second voice. Type flow earns its keep
 * on the pairs the call graph cannot see.
 *
 * `self` and `cls` are skipped -- a method accepting its own class as the
 * receiver would make every method of a class a consumer of it, which is a
 * mesh rather than a finding.
 *
 * Memoised per (index, registry). The registry is optional because it arrives
 * late; without it only same-module types resolve, which is a smaller graph
 * and not a wrong one.
 */
export function deriveTypeFlow(
  index: SymbolIndex,
  registry: SymbolRegistry | null = null,
): TypeFlowIndex {
  let perRegistry = typeFlowCache.get(index)
  if (!perRegistry) {
    perRegistry = new WeakMap()
    typeFlowCache.set(index, perRegistry)
  }
  const key = registry ?? NO_REGISTRY
  const cached = perRegistry.get(key)
  if (cached) return cached

  const producersOf = new Map<string, string[]>()
  const consumersOf = new Map<string, string[]>()
  const returnsOf = new Map<string, readonly string[]>()
  const acceptsOf = new Map<string, readonly string[]>()
  let annotatedReturns = 0
  let totalReturns = 0
  let annotatedParams = 0
  let totalParams = 0

  const add = (map: Map<string, string[]>, key_: string, value: string): void => {
    const known = map.get(key_)
    if (!known) map.set(key_, [value])
    else if (!known.includes(value)) known.push(value)
  }

  for (const node of index.byId.values()) {
    if (!CALLABLE_KINDS.has(node.kind)) continue
    totalReturns++
    if (node.returns) annotatedReturns++

    const produced = typesOf(node.returns, node.module, index, registry)
    // A constructor returning its own class restates the call edge `Foo()`
    // already draws; type flow is for the pairs calls cannot see.
    const own = ownClassOf(node, index)
    const returns = produced.filter((id) => id !== own)
    if (returns.length > 0) {
      returnsOf.set(node.id, returns)
      for (const id of returns) add(producersOf, id, node.id)
    }

    const accepts: string[] = []
    for (const param of node.params) {
      if (param.name === 'self' || param.name === 'cls') continue
      totalParams++
      if (param.annotation) annotatedParams++
      for (const id of typesOf(param.annotation, node.module, index, registry)) {
        if (id !== own && !accepts.includes(id)) accepts.push(id)
      }
    }
    if (accepts.length > 0) {
      acceptsOf.set(node.id, accepts)
      for (const id of accepts) add(consumersOf, id, node.id)
    }
  }

  const result: TypeFlowIndex = {
    producersOf,
    consumersOf,
    returnsOf,
    acceptsOf,
    coverage: { annotatedReturns, totalReturns, annotatedParams, totalParams },
  }
  perRegistry.set(key, result)
  return result
}

/** The class a method belongs to, or null for a plain function. */
function ownClassOf(node: GraphNode, index: SymbolIndex): string | null {
  if (node.parent && index.byId.get(node.parent)?.kind === 'class') return node.parent
  return null
}
