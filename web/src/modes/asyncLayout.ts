/**
 * Cache-and-notify bridge for a VizMode whose `layout` phase needs an async
 * computation (tic-7e6d), e.g. import-graph's worker-based elk layout.
 *
 * `VizMode.layout()` (./types.ts) is a synchronous phase, called inside a
 * synchronous `useMemo` in App.tsx, so a mode backed by a worker cannot
 * simply await its result. The pattern such a mode follows: keep its own
 * result cache, return a synchronous fallback on a cache miss, kick off the
 * async work, and on resolution call {@link notifyLayoutReady} here so
 * App.tsx's `useSyncExternalStore` subscription fires a re-render that
 * re-runs `layout()` -- which this time hits the now-warm cache.
 *
 * Deliberately not part of the app's zustand store: that store's `modes`
 * slice is durable, persisted, per-mode state (camera, drags, expand state),
 * and this is neither -- just a ping that "some mode's cache changed,
 * re-render". Keeping it here means App.tsx subscribes once, generically,
 * regardless of which (if any) active mode needs it.
 */

type Listener = () => void

let version = 0
const listeners = new Set<Listener>()

/** A resolved async layout landed in some mode's cache; trigger a re-render. */
export function notifyLayoutReady(): void {
  version++
  for (const listener of listeners) listener()
}

/** `useSyncExternalStore` subscribe function. */
export function subscribeLayoutReady(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** `useSyncExternalStore` snapshot function. */
export function getLayoutVersion(): number {
  return version
}
