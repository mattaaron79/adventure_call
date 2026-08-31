/**
 * Fetching the adventure-call exports.
 *
 * `codebase_graph.json` is the startup path -- it carries every module and
 * symbol node plus the CALLS/IMPORTS edges, which is everything the layout
 * modes need.  `symbol_registry.json` is ~2x larger because it embeds full
 * function bodies, so it is fetched lazily the first time something actually
 * wants source, external imports or the unresolved-call list.
 *
 * In dev both are served by the `outData` Vite plugin, which also pushes a
 * change event when they are rewritten; `onDataChanged` wires the refetch.
 */
import { DATA_CHANGED_EVENT } from './events'
import type { CodebaseGraph, SymbolRegistry } from './types'

const GRAPH_URL = '/data/codebase_graph.json'
const REGISTRY_URL = '/data/symbol_registry.json'
const META_URL = '/data/meta.json'

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText} fetching ${url}\n${detail}`.trim())
  }
  return (await res.json()) as T
}

export function loadGraph(): Promise<CodebaseGraph> {
  return getJSON<CodebaseGraph>(GRAPH_URL)
}

let registryPromise: Promise<SymbolRegistry> | null = null

/** Lazy, memoised.  Safe to call from anywhere; only one request is made. */
export function loadRegistry(): Promise<SymbolRegistry> {
  registryPromise ??= getJSON<SymbolRegistry>(REGISTRY_URL).catch((err) => {
    registryPromise = null // let a later call retry
    throw err
  })
  return registryPromise
}

/** True once the registry has been requested -- the UI uses this to decide
 *  whether source is available without triggering the download itself. */
export function registryRequested(): boolean {
  return registryPromise !== null
}

/** The dev-server meta document (tic-4b0a): the absolute analysed root, so the
 *  inspector can build `vscode://file/...` links the browser could not resolve
 *  on its own.  Null when unavailable -- a static build without the `outData`
 *  middleware, or an export that never wrote a root -- and the caller then
 *  degrades to plain text. */
export async function loadAbsoluteRoot(): Promise<string | null> {
  try {
    const meta = await getJSON<{ root: string | null }>(META_URL)
    return meta.root || null
  } catch {
    return null
  }
}

/**
 * Subscribe to dev-server notifications that `/out` was rewritten.
 * Returns an unsubscribe function; a no-op outside dev.
 */
export function onDataChanged(handler: (file: string) => void): () => void {
  if (!import.meta.hot) return () => {}
  const listener = (data: { file: string }) => {
    registryPromise = null // the file on disk is new; drop the cached copy
    handler(data.file)
  }
  import.meta.hot.on(DATA_CHANGED_EVENT, listener)
  return () => import.meta.hot?.off(DATA_CHANGED_EVENT, listener)
}
