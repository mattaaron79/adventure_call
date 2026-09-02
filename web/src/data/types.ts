/**
 * TypeScript mirrors of the adventure-call JSON exports (schema_version 7).
 *
 * Written from adventure_call/models.py and adventure_call/writer.py.  Two
 * kinds -- `variable` and `attribute` -- are declared ahead of the parser that
 * emits them (see tic-82b0); consumers must tolerate their absence.
 *
 * Version history: 4 added `GraphEdge.controls`; 5 (tic-7189) carries no
 * field changes -- the effects layer reads the existing `unresolved_calls`
 * external reasons; 6 (tic-d7d1) added `GraphNode.complexity` and
 * `GraphNode.line_count`; 7 (tic-799e) added `GraphNode.locals`.  Bumped to
 * keep the two mirrors of this constant in lockstep with
 * adventure_call/writer.py.
 */

export const SCHEMA_VERSION = 7

export type SymbolKind =
  | 'module'
  | 'class'
  | 'function'
  | 'method'
  | 'variable'
  | 'attribute'

/**
 * `REFERENCES` (tic-89fa) is a callable NAMED without being called --
 * `path("...", views.menu_items)`, `Thread(target=worker)`, a dispatch table.
 * It is evidence that something can reach the target, never evidence that
 * anything does, so anything reasoning about FLOW must ignore it and anything
 * asking "is this dead" must not.
 *
 * `READS` and `WRITES` (tic-13d7) are data, not flow: a module variable or
 * class attribute whose value is taken or replaced.  Two edge types rather
 * than one with a flag because the questions differ -- "what does this depend
 * on" is READS, "what does changing this break" is WRITES -- and one pair can
 * carry both, which is what `x += 1` produces.
 *
 * These are the only edges that can join two methods of a class that never
 * call each other: on ../carnot 591 method pairs share an attribute with no
 * call between them, and a call graph cannot see any of them.
 */
export type EdgeType = 'CALLS' | 'IMPORTS' | 'CONTAINS' | 'REFERENCES' | 'READS' | 'WRITES'
export type Confidence = 'exact' | 'heuristic' | 'unresolved'
export type CallType = 'call' | 'constructor' | 'method'
export type ParamKind = 'positional' | 'posonly' | 'kwonly' | 'vararg' | 'kwarg'

export interface Param {
  name: string
  annotation: string | null
  default: string | null
  kind: ParamKind
}

/** A node in codebase_graph.json.  Identical to a registry symbol minus `code`. */
export interface GraphNode {
  id: string
  symbol_id: string
  name: string
  kind: SymbolKind
  file_path: string
  module: string
  parent: string | null
  start_byte: number
  end_byte: number
  start_line: number
  end_line: number
  params: Param[]
  /**
   * Return annotation exactly as written (tic-2255) -- `list[ToolResult]`,
   * the string forward reference `"Session"`, `None` the type.  Never
   * normalised or resolved; null means the source carried no annotation at
   * all, which is not the same as an annotation whose text is `"None"`.
   * Optional because the app reads whatever `out/` currently holds: a
   * schema_version 1 export predates the field entirely, so requiring it
   * would be a claim about data that may not be there.  Same reasoning as
   * `root_abs` (tic-7f0b).
   */
  returns?: string | null
  signature: string
  docstring: string | null
  decorators: string[]
  bases: string[]
  is_async: boolean
  /**
   * Cyclomatic-style complexity proxy (tic-d7d1): 1 + the branching
   * constructs in the callable's own body -- if/elif, match cases, for,
   * while, except handlers, boolean and/or, ternaries, comprehension
   * guards.  NOT textbook cyclomatic complexity: a relative-ordering
   * proxy, meant to be compared against other functions in the same
   * codebase, and consumers must not treat it as exact.  Nested defs are
   * excluded and carry their own number.  Optional: absent on a
   * schema_version < 6 export and on non-callables.
   */
  complexity?: number
  /**
   * Source lines the definition spans, header included (tic-d7d1).  The
   * unambiguous companion to {@link complexity}: a long simple function
   * and a short dense one are different problems.  Optional as above.
   */
  line_count?: number
  /**
   * Plain names bound anywhere in the callable's own body (tic-799e),
   * deduplicated, in source order of first binding: assignment targets
   * (tuple/starred included), `for` targets, `with ... as`, `except ... as`,
   * walrus and comprehension targets.  NOT params and NOT nested defs --
   * their locals are their own.  A name list, deliberately not a symbol
   * table: nothing here is resolved or typed (that is tic-97ce's business).
   * Optional: absent on a schema_version < 7 export and on non-callables.
   */
  locals?: string[]
  stub: string
}

export interface GraphEdge {
  source: string
  target: string
  type: EdgeType
  /** Parallel edge types collapsed onto one pair, e.g. both CALLS and IMPORTS. */
  types: EdgeType[]
  count: number
  lines: number[]
  confidence: Confidence
  call_types: CallType[]
  aliases: string[]
  /**
   * One control-flow breadcrumb per call site behind this edge (tic-b47a),
   * outermost construct first -- e.g. `[["if"], [], ["for", "try:except"]]`
   * for three sites.  Parallel to `count`, NOT to the de-duplicated `lines`:
   * an edge answers "what is true of this pair", but a breadcrumb answers
   * "how was this particular call reached", and two sites reaching the same
   * callee differently is the mixed case worth seeing.
   *
   * An empty inner array means that site sits directly in its function's
   * body.  Absent on a schema_version < 3 export.
   */
  controls?: string[][]
  /**
   * Per call site, whether it lies on every path from its enclosing scope's
   * entry to its exit (tic-3a20) -- the true form of the claim `unguarded`
   * only approximates, and a strict subset of it. Parallel to `count`, like
   * `controls`. Absent on a derived edge and on a pre-v9 export.
   */
  certains?: boolean[]
}

/**
 * Control-flow tokens that can SKIP a call (tic-b47a) -- the guards.
 *
 * The word is chosen carefully: a call at guard depth 0 is UNGUARDED, which
 * is not "unconditional" and much less "always runs".  An early return or
 * raise above it kills it, and the caller may itself be conditional.  Say
 * unguarded in anything user-facing, or the UI repeats a claim the data does
 * not support.
 *
 * A loop body is a guard because it may iterate zero times; a `try` body, a
 * `finally` and a `with` body are not, because reaching them runs them.
 * Mirrors `GUARD_TOKENS` in adventure_call/models.py.
 */
export const GUARD_TOKENS: ReadonlySet<string> = new Set([
  'if',
  'if:elif',
  'if:else',
  'try:else',
  'try:except',
  'for',
  'for:else',
  'while',
  'while:else',
  'match:case',
  'comprehension',
  'comprehension:if',
  'bool',
  'ternary',
  'lambda',
  'type-checking',
])

/** How many enclosing constructs could skip a call with this breadcrumb. */
export function guardDepth(control: readonly string[]): number {
  let depth = 0
  for (const token of control) if (GUARD_TOKENS.has(token)) depth++
  return depth
}

export interface GraphStats {
  files: number
  files_with_diagnostics: number
  symbols: number
  nodes: number
  edges: number
  node_kinds: Partial<Record<SymbolKind, number>>
  edge_types: Partial<Record<EdgeType, number>>
  calls_resolved: number
  calls_heuristic: number
  calls_unresolved: number
  calls_builtin: number
  diagnostics: number
}

/** NetworkX node-link export (`edges="edges"`). */
export interface CodebaseGraph {
  directed: boolean
  multigraph: boolean
  graph: {
    schema_version: number
    generated_at: string
    root: string
    /** Absolute, resolved analysed root (tic-7f0b); absent in older exports. */
    root_abs?: string
    stats: GraphStats
  }
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// -- symbol_registry.json ----------------------------------------------------

export interface SymbolRecord extends Omit<GraphNode, 'id'> {
  /** Present only when the export was written with source included. */
  code?: string
}

export interface ImportRecord {
  module: string
  alias: string
  target_module: string
  target_symbol: string | null
  is_relative: boolean
  level: number
  is_wildcard: boolean
  line: number
  /** Dotted path as written, e.g. `kernel.errors.PluginError`. */
  target: string
}

export interface ModuleRecord {
  file_path: string
  language: string
  docstring: string | null
  symbol_ids: string[]
  imports: ImportRecord[]
}

export interface BindingRecord {
  alias: string
  kind: string
  target: string
  line: number
  statement_module: string
  is_relative: boolean
}

export interface UnresolvedCall {
  caller_id: string
  raw_name: string
  line: number
  callee_id: string | null
  confidence: Confidence
  call_type: CallType
  reason: string
  file_path: string
  /** The call site's control-flow breadcrumb (tic-b47a); see
   *  {@link GraphEdge.controls}.  Absent on a schema_version < 3 export. */
  control?: string[]
}

export interface Diagnostic {
  kind: string
  detail: string
  file_path: string
  line: number
}

export interface SymbolRegistry {
  schema_version: number
  generated_at: string
  root: string
  /** Absolute, resolved analysed root (tic-7f0b); absent in older exports. */
  root_abs?: string
  includes_source: boolean
  stats: GraphStats
  symbols: Record<string, SymbolRecord>
  modules: Record<string, ModuleRecord>
  bindings: Record<string, Record<string, BindingRecord>>
  unresolved_calls: UnresolvedCall[]
  diagnostics: Diagnostic[]
}
