/**
 * localStorage for the per-mode workspace state.
 *
 * Keyed by mode id, because a viewport and a set of dragged positions only
 * mean anything relative to the scene that produced them: switching modes must
 * not drag one mode's camera into another's, and a preset (tic-83ec) is just
 * another mode id here.
 *
 * Everything read back is validated.  Stored state is user-editable and
 * survives across versions of the app, so a stale or hand-mangled entry has to
 * degrade to "no saved state" rather than take the canvas down with it.
 */
import { DEFAULT_VIEWPORT, clampScale, type Point, type Viewport } from '../canvas/viewport'

export interface ModeState {
  viewport: Viewport
  /** Node id -> world position, written by dragging; cleared by 'Relayout'. */
  overrides: Record<string, Point>
  /** Node id -> expanded, for modes with expandable containers. */
  expanded: Record<string, boolean>
  /**
   * The active mode's params (tic-83ec), as a JSON-safe record.  Opaque here:
   * the mode's `defaultParams` fill any key this record leaves out.
   */
  params: Record<string, unknown>
  /**
   * Whether the Filter Files query also drives what the canvas shows
   * (tic-9098).  Default false: the query prunes the sidebar tree only.
   */
  filterVisible: boolean
  /**
   * The directory path the mode's scene is currently drilled into (tic-e7d2);
   * the empty string means the whole graph.  The mode's select phase scopes
   * its scene to this subtree, so it has to survive reloads like the camera.
   */
  focusPath: string
}

/** The prefix every persisted key shares; the project namespace slots in after it. */
const APP_PREFIX = 'adventure-call:'

/**
 * The project this browser's saved state belongs to (tic-168b), or null.
 *
 * One origin can host several projects -- two `vcall serve` runs on two ports, or
 * one Vite dev server pointed at another store -- and a camera, a focus path or a
 * dragged position only means anything for the project whose scene produced it.
 * An exclude list is worse than meaningless in the wrong project: it hides files.
 * So every key below is namespaced by the id `/data/meta.json` reports for the
 * analysed root, which the app sets during bootstrap (src/main.tsx) -- before the
 * store hydrates at import time, so the first read is already scoped.
 *
 * Null -- a static build with no meta document, or one that failed to load --
 * keeps the unnamespaced keys of tic-168b's predecessors, so those deployments
 * behave exactly as they did before.
 */
let projectKey: string | null = null

/** Name the project the saved state belongs to; null or '' forgets it again. */
export function setProjectKey(key: string | null | undefined): void {
  projectKey = key ? key : null
}

/** The current project namespace, or null when there is none. */
export function getProjectKey(): string | null {
  return projectKey
}

/**
 * `legacyKey` namespaced by the current project, or unchanged without one.
 *
 * The namespace goes straight after the app prefix, so a mode slice reads
 * `adventure-call:<project>:workspace:<modeId>` and the chrome keys become
 * `adventure-call:<project>:ui` and friends.
 *
 * The keys written before tic-168b -- `adventure-call:workspace:<modeId>` and the
 * rest of the unsuffixed set -- are deliberately neither migrated nor deleted:
 * with a project known they stop being read, which is the intended cleanup, and
 * the app never deletes user data it does not understand.  Without a project they
 * are still the keys in use, which is what makes a static build work.
 */
export function scopedKey(legacyKey: string): string {
  if (projectKey === null) return legacyKey
  const rest = legacyKey.startsWith(APP_PREFIX) ? legacyKey.slice(APP_PREFIX.length) : legacyKey
  return `${APP_PREFIX}${projectKey}:${rest}`
}

/** The unsuffixed key for a mode: what a build with no project still uses. */
export const STORAGE_PREFIX = 'adventure-call:workspace:'

export const storageKey = (modeId: string) => scopedKey(`${STORAGE_PREFIX}${modeId}`)

export function emptyModeState(): ModeState {
  return {
    viewport: { ...DEFAULT_VIEWPORT },
    overrides: {},
    expanded: {},
    params: {},
    filterVisible: false,
    focusPath: '',
  }
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // private-mode / blocked site data
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parseViewport(raw: unknown): Viewport {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_VIEWPORT }
  const { x, y, scale } = raw as Record<string, unknown>
  if (!isNum(x) || !isNum(y) || !isNum(scale)) return { ...DEFAULT_VIEWPORT }
  return { x, y, scale: clampScale(scale) }
}

function parsePoints(raw: unknown): Record<string, Point> {
  const out: Record<string, Point> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const { x, y } = value as Record<string, unknown>
    if (isNum(x) && isNum(y)) out[id] = { x, y }
  }
  return out
}

function parseFlags(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'boolean') out[id] = value
  }
  return out
}

/** Keep the JSON-safe scalar params; anything else never came from us. */
function parseParams(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = value
    }
  }
  return out
}

/** The saved state for a mode, or null when there is nothing usable stored. */
export function readModeState(modeId: string): ModeState | null {
  let raw: string | null | undefined
  try {
    raw = storage()?.getItem(storageKey(modeId))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    return {
      viewport: parseViewport(record.viewport),
      overrides: parsePoints(record.overrides),
      expanded: parseFlags(record.expanded),
      params: parseParams(record.params),
      filterVisible: record.filterVisible === true,
      focusPath: typeof record.focusPath === 'string' ? record.focusPath : '',
    }
  } catch {
    return null
  }
}

export function writeModeState(modeId: string, state: ModeState): void {
  try {
    storage()?.setItem(storageKey(modeId), JSON.stringify(state))
  } catch {
    // Persistence is a convenience; the in-memory state still applies.  A
    // quota error here also means the next write is likely to fail, and that
    // is fine: nothing downstream depends on it.
  }
}

export function clearModeState(modeId: string): void {
  try {
    storage()?.removeItem(storageKey(modeId))
  } catch {
    // as above
  }
}

// -- standalone UI preferences ----------------------------------------------

/**
 * Chrome around the visualisation, as opposed to per-mode workspace state
 * (tic-88ac): whether the inspector card is collapsed to its identifying bar.
 * Unlike the mode slices, these preferences are global to the app and describe
 * the chrome, not what is visualised, so they live under their own key --
 * never inside a mode's `ModeState` and never inside a saved preset
 * (src/modes/presets.ts).
 *
 * The name is the pre-tic-168b key; the reads and writes below go through
 * [`scopedKey()`], so the entry belongs to the project that set it.
 */
export const UI_STORAGE_KEY = 'adventure-call:ui'

export interface UiPrefs {
  /** The inspector card is collapsed to its compact identifying bar. */
  inspectorCollapsed: boolean
  /**
   * Exploratory Marching-ants toggle (tic-5196): when true the canvas runs the
   * moving-dash animation on every edge, not only highlighted directional
   * (import) lines.  Stored as chrome state, not per-mode, because it is a
   * display preference rather than what is being visualised.
   */
  animateAllEdges: boolean
}

export function emptyUiPrefs(): UiPrefs {
  return { inspectorCollapsed: false, animateAllEdges: false }
}

export function readUiPrefs(): UiPrefs {
  let raw: string | null | undefined
  try {
    raw = storage()?.getItem(scopedKey(UI_STORAGE_KEY))
  } catch {
    return emptyUiPrefs()
  }
  if (!raw) return emptyUiPrefs()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return emptyUiPrefs()
    const record = parsed as Record<string, unknown>
    return {
      inspectorCollapsed: record.inspectorCollapsed === true,
      animateAllEdges: record.animateAllEdges === true,
    }
  } catch {
    return emptyUiPrefs()
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    storage()?.setItem(scopedKey(UI_STORAGE_KEY), JSON.stringify(prefs))
  } catch {
    // Persistence is a convenience; the in-memory state still applies.
  }
}

/**
 * Where a cross-mode jump came from (tic-53f7), so it can be undone.
 *
 * Its own key, and neither a `ModeState` nor a `UiPrefs`.  A mode slice is
 * keyed BY mode and this is a relationship BETWEEN two of them -- storing it
 * in either end would make the way home disappear the moment that end's slice
 * was reset, and put a fact about the origin inside the destination's record.
 * It is not chrome either: it describes navigation, not how the app looks.
 * The same reasoning that gave the UI preferences their own key gives this
 * one, and it must never reach a saved preset, which captures a view rather
 * than the trip taken to it.
 *
 * The name is the pre-tic-168b key; the reads and writes below go through
 * [`scopedKey()`], so a return path recorded in one project is never offered
 * in another.
 */
export const EXCURSION_STORAGE_KEY = 'adventure-call:excursion'

export interface Excursion {
  /** The mode the jump started in. */
  modeId: string
  /** That mode's focus path at the moment of the jump; '' for its whole graph. */
  focusPath: string
}

/** The recorded excursion, or null when there is none or it is unreadable. */
export function readExcursion(): Excursion | null {
  let raw: string | null | undefined
  try {
    raw = storage()?.getItem(scopedKey(EXCURSION_STORAGE_KEY))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { modeId, focusPath } = parsed as Record<string, unknown>
    // A mode id is required; a missing focus path is the whole graph, which is
    // a perfectly good place to return to.
    if (typeof modeId !== 'string' || modeId === '') return null
    return { modeId, focusPath: typeof focusPath === 'string' ? focusPath : '' }
  } catch {
    return null
  }
}

/** Record an excursion, or clear it with null. */
export function writeExcursion(excursion: Excursion | null): void {
  try {
    if (excursion === null) storage()?.removeItem(scopedKey(EXCURSION_STORAGE_KEY))
    else storage()?.setItem(scopedKey(EXCURSION_STORAGE_KEY), JSON.stringify(excursion))
  } catch {
    // Persistence is a convenience; the in-memory state still applies.
  }
}

/**
 * Coalesce the writes.  A pan is one state update per pointer move, and
 * `JSON.stringify` over a few thousand position overrides is not something to
 * do at that rate.
 */
export function createDebouncedWriter(delay = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: [string, ModeState] | null = null

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!pending) return
    const [modeId, state] = pending
    pending = null
    writeModeState(modeId, state)
  }

  return {
    write(modeId: string, state: ModeState) {
      // A mode switch must not let the previous mode's write be dropped.
      if (pending && pending[0] !== modeId) flush()
      pending = [modeId, state]
      if (timer === undefined) timer = setTimeout(flush, delay)
    },
    flush,
  }
}
