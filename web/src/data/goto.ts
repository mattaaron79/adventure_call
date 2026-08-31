/**
 * Browser side of the camera-goto event (tic-bee0).  Any surface that names a
 * node -- the file tree, the inspector, a future imports list -- calls
 * {@link emitGoto}; the workspace canvas subscribes with {@link onGoto} and
 * owns the resolution and the flight.  Kept out of ./events.ts because that
 * module is also compiled by the node-side Vite plugin, which has no DOM.
 */
import { GOTO_EVENT } from './events'

/** Detail of the goto event. */
export interface GotoEventDetail {
  /** A file/dir path, scene element id, or symbol id the scene can resolve. */
  target: string
}

/** Ask the workspace to centre the camera on `target`. */
export function emitGoto(target: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<GotoEventDetail>(GOTO_EVENT, { detail: { target } }))
}

/** Subscribe to goto requests; returns an unsubscribe. */
export function onGoto(handler: (target: string) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<GotoEventDetail>).detail
    if (detail) handler(detail.target)
  }
  window.addEventListener(GOTO_EVENT, listener)
  return () => window.removeEventListener(GOTO_EVENT, listener)
}
