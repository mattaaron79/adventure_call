/**
 * The Filter Files query language (tic-9098).
 *
 * Four forms, distinguished by prefix. `>` always comes first, so exactly
 * three prefix forms are legal -- `>`, `r:`, `>r:` -- and anything else is
 * literal text:
 *
 * - `text`        case-insensitive substring match on the file's path.
 * - `r:<expr>`    the rest is a regular expression (case-insensitive) on the
 *                 path. An invalid expression parses to an {@link QueryError};
 *                 it must surface as an inline error on the input, not throw.
 * - `>text`       widen the match from the path to ALL properties of the file
 *                 and its symbols: symbol names, signatures, docstrings,
 *                 decorators, bases, and the module docstring.
 * - `>r:<expr>`   the regex form across all of those properties.
 *
 * Because `>` searches symbol properties, an all-properties query can match a
 * file through a symbol deep inside it; that file still appears as a file in
 * the tree and on the canvas.
 *
 * Everything here is pure: parse once, then test files against the parsed
 * query. No React, no store, no I/O.
 */
import { normalizePath } from './filters'
import type { GraphNode } from './types'

export type Query =
  | { kind: 'empty' }
  | { kind: 'text'; text: string; all: boolean }
  | { kind: 'regex'; source: string; re: RegExp; all: boolean }
  | { kind: 'error'; message: string }

/**
 * Parse a raw query string. Never throws: an unparsable regex comes back as
 * `{ kind: 'error' }` so the caller can render it inline.
 */
export function parseQuery(input: string): Query {
  const trimmed = input.trim()
  if (!trimmed) return { kind: 'empty' }

  let all = false
  let rest = trimmed
  if (rest.startsWith('>')) {
    all = true
    rest = rest.slice(1)
  }
  if (rest.startsWith('r:')) {
    const source = rest.slice(2)
    try {
      return { kind: 'regex', source, re: new RegExp(source, 'i'), all }
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }
  return { kind: 'text', text: rest.toLowerCase(), all }
}

/** The properties of one symbol an all-properties query searches. */
type SymbolFacts = Pick<GraphNode, 'name' | 'signature' | 'docstring' | 'decorators' | 'bases'>

/** The properties of one file an all-properties query searches. */
export interface FileFacts {
  /** Root-relative path, e.g. `src/app/loop.py`. */
  path: string
  /** The module's docstring, or null. */
  docstring: string | null
  /** Every symbol the file contains, at any nesting depth. */
  symbols: readonly SymbolFacts[]
}

/** Collect {@link FileFacts} from a module node and its symbols. */
export function fileFacts(module: GraphNode, symbols: readonly GraphNode[]): FileFacts {
  return {
    path: normalizePath(module.file_path),
    docstring: module.docstring,
    symbols: symbols.map(({ name, signature, docstring, decorators, bases }) => ({
      name,
      signature,
      docstring,
      decorators,
      bases,
    })),
  }
}

function matchesText(haystack: string | null | undefined, needle: string): boolean {
  return haystack !== null && haystack !== undefined && haystack.toLowerCase().includes(needle)
}

function matchesRegex(haystack: string | null | undefined, re: RegExp): boolean {
  return haystack !== null && haystack !== undefined && re.test(haystack)
}

/**
 * Does one file match a parsed query?
 *
 * A path-only query looks at `facts.path`; an all-properties query also looks
 * at the module docstring and every symbol's name, signature, docstring,
 * decorators and bases. An error query matches nothing -- the UI shows the
 * inline error instead of results.
 */
export function matchFile(query: Query, facts: FileFacts): boolean {
  switch (query.kind) {
    case 'empty':
      return true
    case 'error':
      return false
    case 'text':
      if (matchesText(facts.path, query.text)) return true
      if (!query.all) return false
      return (
        matchesText(facts.docstring, query.text) ||
        facts.symbols.some(
          (symbol) =>
            matchesText(symbol.name, query.text) ||
            matchesText(symbol.signature, query.text) ||
            matchesText(symbol.docstring, query.text) ||
            symbol.decorators.some((d) => matchesText(d, query.text)) ||
            symbol.bases.some((b) => matchesText(b, query.text)),
        )
      )
    case 'regex':
      if (query.re.test(facts.path)) return true
      if (!query.all) return false
      return (
        matchesRegex(facts.docstring, query.re) ||
        facts.symbols.some(
          (symbol) =>
            matchesRegex(symbol.name, query.re) ||
            matchesRegex(symbol.signature, query.re) ||
            matchesRegex(symbol.docstring, query.re) ||
            symbol.decorators.some((d) => matchesRegex(d, query.re)) ||
            symbol.bases.some((b) => matchesRegex(b, query.re)),
        )
      )
  }
}
