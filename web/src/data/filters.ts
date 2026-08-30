/**
 * Path exclusion.
 *
 * The exports cover everything the parser walked, which for most projects
 * includes throwaway trees -- pytest tmpdirs, scratch pads, bytecode caches --
 * that would otherwise dominate the layout.  Excludes are expressed as
 * path globs against a module's `file_path` (always forward-slashed and
 * relative to the graph root) and are applied before any derivation runs, so
 * an excluded file never reaches the tree, the symbol index or the edges.
 */

export const DEFAULT_EXCLUDES: readonly string[] = [
  '.pytest_tmp/**',
  'scratch/**',
  '**/__pycache__/**',
]

export const EXCLUDES_STORAGE_KEY = 'adventure-call:excludes'

const SPECIAL = /[.+^${}()|[\]\\]/g

/** `*` stops at a separator, `?` is one non-separator char, `**` spans segments. */
function segmentToSource(segment: string): string {
  let out = ''
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += ch.replace(SPECIAL, '\\$&')
  }
  return out
}

/**
 * Compile one glob to an anchored RegExp.
 *
 * A `**` segment matches zero or more path segments, so the pattern
 * `a` + `**` + `b` matches both `a/b` and `a/x/y/b`; a trailing `**` matches the
 * whole remaining path.
 */
export function globToRegExp(pattern: string): RegExp {
  const segments = normalizePath(pattern).split('/')
  let source = '^'
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1
    if (segment === '**') {
      // Each alternative below already carries its own separator, so this
      // branch never appends one of its own.
      source += last ? '.*' : '(?:[^/]*/)*'
    } else {
      source += segmentToSource(segment)
      if (!last) source += '/'
    }
  })
  return new RegExp(source + '$')
}

/** Windows paths and stray leading `./` slip in from both JSON and user input. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Build the predicate for a pattern list.  Returns `true` when a path should be
 * *excluded*.  Blank patterns are ignored so a textarea-shaped editor can round
 * trip without producing a match-everything rule.
 */
export function compileExcludes(patterns: readonly string[]): (path: string) => boolean {
  const regexes = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map(globToRegExp)
  if (regexes.length === 0) return () => false
  return (path: string) => {
    const normalized = normalizePath(path)
    return regexes.some((re) => re.test(normalized))
  }
}

/** Keep only the items whose `file_path` survives `patterns`. */
export function applyExcludes<T extends { file_path: string }>(
  items: readonly T[],
  patterns: readonly string[],
): T[] {
  const excluded = compileExcludes(patterns)
  return items.filter((item) => !excluded(item.file_path))
}

// -- persistence -------------------------------------------------------------

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // private-mode / blocked site data
  }
}

/** The persisted list, or {@link DEFAULT_EXCLUDES} when nothing is stored. */
export function readExcludes(): string[] {
  try {
    const raw = storage()?.getItem(EXCLUDES_STORAGE_KEY)
    if (!raw) return [...DEFAULT_EXCLUDES]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) {
      return [...DEFAULT_EXCLUDES]
    }
    return parsed as string[]
  } catch {
    return [...DEFAULT_EXCLUDES]
  }
}

export function writeExcludes(patterns: readonly string[]): void {
  try {
    storage()?.setItem(EXCLUDES_STORAGE_KEY, JSON.stringify(patterns))
  } catch {
    // Persistence is a convenience; the in-memory list still applies.
  }
}

/** Forget the override so {@link readExcludes} falls back to the defaults. */
export function clearExcludes(): void {
  try {
    storage()?.removeItem(EXCLUDES_STORAGE_KEY)
  } catch {
    // as above
  }
}
