import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { loadMeta } from './data/load'
import { setProjectKey } from './state/persist'
import './styles.css'

/**
 * Name the project before the app's module graph is evaluated (tic-168b).
 *
 * Every persisted key is namespaced by the project the server reports, and the
 * workspace store hydrates from localStorage while its module is *evaluated* --
 * which happens the moment `./App` is imported, since that pulls in
 * src/state/store.ts.  The key therefore has to be known first.  The ticket's
 * other route was to re-hydrate every consumer (the store's mode slices, UI prefs
 * and excursion, App's excludes, ModePicker's presets and help pin) once the
 * document arrived; setting the key first is the choice, recorded here: one
 * `await` of a tiny same-origin JSON document, no second read path anywhere, and
 * `restored` -- the flag the canvas uses to choose between a saved camera and
 * framing the scene -- correct on the first render instead of one render later.
 *
 * A build with no `/data/meta.json` (a static deployment, a 404) resolves to no
 * project and keeps the unnamespaced keys, so its behaviour is unchanged.
 */
async function bootstrap(): Promise<void> {
  setProjectKey((await loadMeta()).project)
  // Deliberately a dynamic import: a static one at the top of this file would
  // evaluate the store before the key was set, which is the bug this prevents.
  const { App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
