/**
 * Workspace state.
 *
 * Split in two on purpose: `modes` is the durable, per-mode state that is
 * mirrored to localStorage (camera, dragged positions, what is expanded),
 * while selection and hover are ephemeral -- restoring a selection from a
 * previous session would be surprising, and hover changes far too often to
 * serialise.
 */
import { create } from 'zustand'
import {
  clampScale,
  fitToRect,
  translate,
  zoomAt,
  type Point,
  type Rect,
  type Size,
  type Viewport,
} from '../canvas/viewport'
import {
  createDebouncedWriter,
  emptyModeState,
  readModeState,
  type ModeState,
} from './persist'

/** The only mode that exists today; tic-83ec turns this into a registry. */
export const DEFAULT_MODE_ID = 'fs-tree'

export interface WorkspaceState {
  modeId: string
  modes: Record<string, ModeState>
  /** Whether the active mode's state came back from localStorage. The canvas
   *  uses it to decide between restoring a camera and framing the scene. */
  restored: boolean
  /** Selected node ids. Replaced, never mutated, so React sees the change. */
  selection: ReadonlySet<string>
  hovered: string | null

  setMode: (modeId: string) => void
  setViewport: (viewport: Viewport) => void
  zoomAtPointer: (pointer: Point, factor: number) => void
  panBy: (dx: number, dy: number) => void
  fitTo: (rect: Rect, size: Size, padding?: number) => void

  moveNodes: (positions: Readonly<Record<string, Point>>) => void
  clearOverrides: () => void
  toggleExpanded: (id: string) => void

  select: (ids: readonly string[], additive?: boolean) => void
  toggleSelected: (id: string) => void
  clearSelection: () => void
  setHovered: (id: string | null) => void
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set()

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const initial = readModeState(DEFAULT_MODE_ID)

  /** Apply `fn` to the active mode's slice, leaving the others untouched. */
  const patchMode = (fn: (state: ModeState) => ModeState | null) =>
    set((state) => {
      const current = state.modes[state.modeId] ?? emptyModeState()
      const next = fn(current)
      if (next === null || next === current) return state
      return { modes: { ...state.modes, [state.modeId]: next } }
    })

  return {
    modeId: DEFAULT_MODE_ID,
    modes: { [DEFAULT_MODE_ID]: initial ?? emptyModeState() },
    restored: initial !== null,
    selection: EMPTY_SELECTION,
    hovered: null,

    setMode: (modeId) =>
      set((state) => {
        if (state.modeId === modeId) return state
        const known = state.modes[modeId]
        const saved = known ? null : readModeState(modeId)
        return {
          modeId,
          modes: known ? state.modes : { ...state.modes, [modeId]: saved ?? emptyModeState() },
          restored: known ? true : saved !== null,
          selection: EMPTY_SELECTION,
          hovered: null,
        }
      }),

    setViewport: (viewport) =>
      patchMode((mode) => ({ ...mode, viewport: { ...viewport, scale: clampScale(viewport.scale) } })),

    zoomAtPointer: (pointer, factor) =>
      patchMode((mode) => {
        const viewport = zoomAt(mode.viewport, pointer, factor)
        return viewport === mode.viewport ? null : { ...mode, viewport }
      }),

    panBy: (dx, dy) =>
      patchMode((mode) =>
        dx === 0 && dy === 0 ? null : { ...mode, viewport: translate(mode.viewport, dx, dy) },
      ),

    fitTo: (rect, size, padding) =>
      patchMode((mode) => ({ ...mode, viewport: fitToRect(rect, size, padding) })),

    moveNodes: (positions) =>
      patchMode((mode) => ({ ...mode, overrides: { ...mode.overrides, ...positions } })),

    clearOverrides: () =>
      patchMode((mode) => (Object.keys(mode.overrides).length === 0 ? null : { ...mode, overrides: {} })),

    toggleExpanded: (id) =>
      patchMode((mode) => ({ ...mode, expanded: { ...mode.expanded, [id]: !mode.expanded[id] } })),

    select: (ids, additive = false) =>
      set((state) => {
        const next = new Set(additive ? state.selection : undefined)
        for (const id of ids) next.add(id)
        return sameSet(state.selection, next) ? state : { selection: next }
      }),

    toggleSelected: (id) =>
      set((state) => {
        const next = new Set(state.selection)
        if (!next.delete(id)) next.add(id)
        return { selection: next }
      }),

    clearSelection: () =>
      set((state) => (state.selection.size === 0 ? state : { selection: EMPTY_SELECTION })),

    setHovered: (id) => {
      if (get().hovered !== id) set({ hovered: id })
    },
  }
})

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

// -- selectors ---------------------------------------------------------------

export const activeMode = (state: WorkspaceState): ModeState =>
  state.modes[state.modeId] ?? emptyModeState()

export const selectViewport = (state: WorkspaceState) => activeMode(state).viewport
export const selectOverrides = (state: WorkspaceState) => activeMode(state).overrides
export const selectExpanded = (state: WorkspaceState) => activeMode(state).expanded

/** Forget the drags for the active mode; the debounced writer persists it. */
export function relayout(): void {
  useWorkspace.getState().clearOverrides()
}

// -- persistence -------------------------------------------------------------

const writer = createDebouncedWriter()

useWorkspace.subscribe((state, previous) => {
  const mode = activeMode(state)
  if (state.modeId === previous.modeId && mode === activeMode(previous)) return
  writer.write(state.modeId, mode)
})

/** Write the pending state out now, rather than when the debounce expires. */
export function flushWorkspaceState(): void {
  writer.flush()
}

if (typeof window !== 'undefined') {
  // 'pagehide' fires on reload, navigation and tab discard, where
  // 'beforeunload' is unreliable on mobile Safari and blocks the bfcache.
  window.addEventListener('pagehide', flushWorkspaceState)
}
