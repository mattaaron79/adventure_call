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
 * change event when they are rewritten; `onDataChanged` wires the refetch.  A
 * served build (`vcall serve`) has no HMR client, so the same notification
 * arrives over Server-Sent Events from `/data/events` instead (tic-70f3).
 */
import { DATA_CHANGED_EVENT } from './events'
import type { CodebaseGraph, SymbolRegistry } from './types'

const GRAPH_URL = '/data/codebase_graph.json'
const REGISTRY_URL = '/data/symbol_registry.json'
const META_URL = '/data/meta.json'
const EVENTS_URL = '/data/events'

/** Reconnect backoff for the event stream: doubling from a second, capped, so a
 *  deployment with no endpoint is retried rarely instead of never (tic-70f3). */
export const RETRY_MIN_MS = 1000
export const RETRY_MAX_MS = 30_000

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

/** The bootstrap document both servers answer, as the client reads it
 *  (tic-4b0a, tic-168b). */
export interface MetaDocument {
  /** The absolute analysed root, for the inspector's `vscode://` links. */
  root: string | null
  /**
   * The project the persisted state belongs to (tic-168b), or null when the
   * server named none -- a static build, or an export predating the field --
   * in which case the storage layer keeps its unnamespaced keys.
   */
  project: string | null
}

/** What an unreadable meta document means: no root, no project. */
const NO_META: MetaDocument = { root: null, project: null }

/**
 * `/data/meta.json`, served by the dev server's plugin and by `vcall serve`.
 *
 * Never rejects: a static deployment without either server 404s, and both callers
 * -- the `vscode://` links and the bootstrap that names the project -- have a
 * sane answer for "the server told us nothing".
 */
export async function loadMeta(): Promise<MetaDocument> {
  try {
    const meta = await getJSON<{ root?: unknown; project?: unknown }>(META_URL)
    return {
      root: typeof meta.root === 'string' && meta.root ? meta.root : null,
      project: typeof meta.project === 'string' && meta.project ? meta.project : null,
    }
  } catch {
    return NO_META
  }
}

/** The absolute analysed root alone (tic-4b0a), so the inspector can build
 *  `vscode://file/...` links the browser could not resolve on its own.  Null when
 *  unavailable, and the caller then degrades to plain text. */
export async function loadAbsoluteRoot(): Promise<string | null> {
  return (await loadMeta()).root
}

/** The slice of `EventSource` the fallback uses, so a test can stand in for it:
 *  vitest runs in node, where a real `EventSource` does not exist (tic-70f3). */
export interface DataEventSource {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  close(): void
}

export type EventSourceFactory = (url: string) => DataEventSource

const defaultEventSourceFactory: EventSourceFactory = (url) =>
  // The DOM type is wider than the two members above; the cast is only to tell
  // the compiler what the runtime already satisfies.
  new EventSource(url) as unknown as DataEventSource

let eventSourceFactory: EventSourceFactory = defaultEventSourceFactory

/** Swap in a stand-in for `EventSource`; `null` restores the real one. */
export function setEventSourceFactory(factory: EventSourceFactory | null): void {
  eventSourceFactory = factory ?? defaultEventSourceFactory
}

/** The `file` field of one `data:` frame; empty when the frame is unreadable. */
function fileFromFrame(data: string): string {
  try {
    const parsed = JSON.parse(data) as { file?: unknown }
    if (parsed && typeof parsed.file === 'string') return parsed.file
  } catch {
    // A malformed frame is the server's problem, not a reason to break the page.
  }
  return ''
}

/**
 * The no-HMR fallback: the same change notification over Server-Sent Events.
 *
 * The stream is only one notification per re-analysis, so a transport failure is
 * handled by closing the source and reconnecting on a backoff of our own: a
 * browser retries a failed EventSource by itself, which for an endpoint that does
 * not exist (a static-only deployment) means a console error every few seconds
 * forever.  Nothing here logs or throws -- the page keeps working, just without
 * live updates -- and the returned unsubscribe always closes what is open.
 */
function connectEvents(handler: (file: string) => void): () => void {
  let source: DataEventSource | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let delay = RETRY_MIN_MS
  let closed = false

  const drop = (): void => {
    source?.close()
    source = null
  }

  const schedule = (): void => {
    if (closed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      open()
    }, delay)
    delay = Math.min(delay * 2, RETRY_MAX_MS)
  }

  const open = (): void => {
    if (closed) return
    try {
      source = eventSourceFactory(EVENTS_URL)
    } catch {
      schedule() // a transport that cannot even be constructed is a failed attempt
      return
    }
    source.addEventListener('open', () => {
      delay = RETRY_MIN_MS
    })
    source.addEventListener(DATA_CHANGED_EVENT, (event) => {
      registryPromise = null // the file on disk is new; drop the cached copy
      handler(fileFromFrame(event.data))
    })
    source.addEventListener('error', () => {
      drop()
      schedule()
    })
  }

  open()
  return () => {
    closed = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    drop()
  }
}

/**
 * Subscribe to notifications that the exports were rewritten: HMR under the Vite
 * dev server, `/data/events` under `vcall serve`.  Returns an unsubscribe
 * function, which is safe to call when nothing is subscribed.
 */
export function onDataChanged(handler: (file: string) => void): () => void {
  if (!import.meta.hot) return connectEvents(handler)
  const listener = (data: { file: string }) => {
    registryPromise = null // the file on disk is new; drop the cached copy
    handler(data.file)
  }
  import.meta.hot.on(DATA_CHANGED_EVENT, listener)
  return () => import.meta.hot?.off(DATA_CHANGED_EVENT, listener)
}
