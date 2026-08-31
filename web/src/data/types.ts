/**
 * TypeScript mirrors of the adventure-call JSON exports (schema_version 1).
 *
 * Written from adventure_call/models.py and adventure_call/writer.py.  Two
 * kinds -- `variable` and `attribute` -- are declared ahead of the parser that
 * emits them (see tic-82b0); consumers must tolerate their absence.
 */

export const SCHEMA_VERSION = 1

export type SymbolKind =
  | 'module'
  | 'class'
  | 'function'
  | 'method'
  | 'variable'
  | 'attribute'

export type EdgeType = 'CALLS' | 'IMPORTS' | 'CONTAINS'
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
  signature: string
  docstring: string | null
  decorators: string[]
  bases: string[]
  is_async: boolean
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
