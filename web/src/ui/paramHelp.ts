/**
 * Whether the mode panel's control explanations are pinned open (tic-ec97).
 *
 * A reading preference, not part of any view: it should not travel inside a
 * preset and it should not reset when the mode changes, so it gets its own
 * localStorage key rather than a field on the per-mode
 * {@link ../state/persist.ModeState}.
 *
 * Reads degrade to `false` on anything unusable -- a blocked or private-mode
 * store, a key some other tool wrote a number into -- because the failure of
 * a reading preference must be "the help is closed", never a broken sidebar.
 */

/** The localStorage key.  Shares the app's prefix, outside the per-mode space. */
export const HELP_PINNED_KEY = 'adventure-call:ui:help-pinned'

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // private-mode / blocked site data
  }
}

/** Whether the explanations were left pinned open; false when nothing usable
 *  is stored. */
export function readHelpPinned(): boolean {
  try {
    return storage()?.getItem(HELP_PINNED_KEY) === 'true'
  } catch {
    return false
  }
}

/** Remembers the choice.  A write that cannot land is not worth an error:
 *  the session still works, it just forgets. */
export function writeHelpPinned(pinned: boolean): void {
  try {
    storage()?.setItem(HELP_PINNED_KEY, pinned ? 'true' : 'false')
  } catch {
    /* quota, or a store that refuses writes */
  }
}
