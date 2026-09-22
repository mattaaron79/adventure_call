import { describe, expect, it } from 'vitest'
import { DEFAULT_MODE_ID } from '../modes/registry'
import { getProjectKey, setProjectKey } from './persist'

/**
 * The project key has to be set before the store module is evaluated, because the
 * store hydrates at import time (tic-168b).  The bootstrap in src/main.tsx does
 * exactly this -- `setProjectKey` first, the dynamic `import('./App')` second --
 * and the top-level statements below replay that order: the static imports above
 * run first, then `setProjectKey`, then the awaited import of './store'.
 */
const KEY = 'carnot-70249695'

const SCOPED = {
  viewport: { x: -300, y: 120, scale: 2 },
  overrides: { 'a.py': { x: 5, y: 6 } },
  expanded: {},
  params: {},
  filterVisible: false,
  focusPath: 'src/app',
}
/** What a build that never knew the project would have left behind. */
const LEGACY = { ...SCOPED, viewport: { x: 0, y: 0, scale: 1 }, focusPath: 'legacy' }

const scoped = (suffix: string) => `adventure-call:${KEY}:${suffix}`
const MODE = DEFAULT_MODE_ID

const map = new Map<string, string>([
  [scoped(`workspace:${MODE}`), JSON.stringify(SCOPED)],
  [scoped('ui'), JSON.stringify({ inspectorCollapsed: true, animateAllEdges: false })],
  [scoped('excursion'), JSON.stringify({ modeId: MODE, focusPath: 'src' })],
  // The unnamespaced entries an earlier session left behind: not read.
  [`adventure-call:workspace:${MODE}`, JSON.stringify(LEGACY)],
  ['adventure-call:ui', JSON.stringify({ inspectorCollapsed: false, animateAllEdges: false })],
  ['adventure-call:excursion', JSON.stringify({ modeId: 'call-graph', focusPath: '' })],
])

globalThis.localStorage = {
  get length() {
    return map.size
  },
  clear: () => map.clear(),
  getItem: (key: string) => map.get(key) ?? null,
  key: (index: number) => [...map.keys()][index] ?? null,
  removeItem: (key: string) => void map.delete(key),
  setItem: (key: string, value: string) => void map.set(key, String(value)),
} as Storage

setProjectKey(KEY)

const { activeMode, flushWorkspaceState, selectViewport, useWorkspace } = await import('./store')

describe('the project key at hydration (tic-168b)', () => {
  it('hydrates the active mode from the project key, not the unnamespaced one', () => {
    const state = useWorkspace.getState()
    // `restored` is what the canvas reads to choose between a saved camera and
    // framing the scene; a key that arrived after the import would leave it false.
    expect(state.restored).toBe(true)
    expect(selectViewport(state)).toEqual(SCOPED.viewport)
    expect(activeMode(state).focusPath).toBe('src/app')
  })

  it('hydrates the chrome preferences and the excursion under the project too', () => {
    expect(useWorkspace.getState().inspectorCollapsed).toBe(true)
    expect(useWorkspace.getState().origin).toEqual({ modeId: MODE, focusPath: 'src' })
  })

  it('writes back under the project key, leaving the old entries alone', () => {
    useWorkspace.getState().setViewport({ x: 1, y: 2, scale: 1 })
    flushWorkspaceState()
    expect(JSON.parse(localStorage.getItem(`adventure-call:workspace:${MODE}`)!)).toEqual(LEGACY)
    expect(JSON.parse(localStorage.getItem(scoped(`workspace:${MODE}`))!).viewport).toEqual({
      x: 1,
      y: 2,
      scale: 1,
    })
    expect(getProjectKey()).toBe(KEY)
  })
})
