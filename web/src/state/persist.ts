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
}

export const STORAGE_PREFIX = 'adventure-call:workspace:'

export const storageKey = (modeId: string) => `${STORAGE_PREFIX}${modeId}`

export function emptyModeState(): ModeState {
  return {
    viewport: { ...DEFAULT_VIEWPORT },
    overrides: {},
    expanded: {},
    params: {},
    filterVisible: false,
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
