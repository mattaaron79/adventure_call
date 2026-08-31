/** Shared between the Vite plugin (node) and the client -- keep them in sync. */
export const DATA_CHANGED_EVENT = 'adventure-call:data-changed'

/**
 * Client-side camera navigation (tic-bee0).  The workspace canvas owns the
 * scene, so any surface that names a node -- the file tree, the inspector --
 * asks it to fly the camera there through this event instead of reaching into
 * the canvas.  Only the event *name* lives here (this module is also compiled
 * by the node-side Vite plugin, which has no DOM); the browser-side emit and
 * subscribe helpers live in ./goto.
 */
export const GOTO_EVENT = 'adventure-call:goto'
