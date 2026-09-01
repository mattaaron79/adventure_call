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
  centerOn,
  clampScale,
  fitToRect,
  translate,
  zoomAt,
  type CenterOnOptions,
  type Point,
  type Rect,
  type Size,
  type Viewport,
} from '../canvas/viewport'
import {
  createDebouncedWriter,
  emptyModeState,
  readModeState,
  readUiPrefs,
  writeUiPrefs,
  type ModeState,
} from './persist'

import { DEFAULT_MODE_ID } from '../modes/registry'

export { DEFAULT_MODE_ID }

export interface WorkspaceState {
  modeId: string
  modes: Record<string, ModeState>
  /** Whether the active mode's state came back from localStorage. The canvas
   *  uses it to decide between restoring a camera and framing the scene. */
  restored: boolean
  /** Selected node ids. Replaced, never mutated, so React sees the change. */
  selection: ReadonlySet<string>
  hovered: string | null
  /** Whether the inspector card is collapsed to its identifying bar (tic-88ac). */
  inspectorCollapsed: boolean
  /** Exploratory marching-ants on every edge (tic-5196), not just lit imports. */
  animateAllEdges: boolean

  setMode: (modeId: string) => void
  /** Replace the active mode's params (a preset load, a picker toggle). */
  setParams: (params: Record<string, unknown>) => void
  /** Replace the active mode's expand state (a preset load). */
  setExpanded: (expanded: Record<string, boolean>) => void
  /**
   * Drill the active mode's scene into a directory path (tic-e7d2); the empty
   * string is the whole graph.  Changing the scope also drops stale drag
   * overrides, since dragged positions only mean anything for the view they
   * were made in.
   */
  setFocusPath: (path: string) => void
  /**
   * Switch to another mode AND open it at a focus, in one transition
   * (tic-e738).
   *
   * `setMode` deliberately preserves whatever the target mode last had, and
   * `setFocusPath` only ever touches the ACTIVE mode, so before this there
   * was no way to say "go look at this over there".  Doing it as two calls
   * would not be equivalent: the intermediate state -- new mode, old focus --
   * would render, so the canvas would lay out and frame a scene nobody asked
   * for before the focus landed.  One `set` means that state never exists.
   *
   * `target` is in the DESTINATION mode's focus vocabulary (see
   * modes/types.ts `UiState.focusPath`); a destination that cannot resolve it
   * opens unfocused rather than empty, which is that file's stated contract
   * rather than anything this action enforces.  Switching to the mode already
   * active is not a no-op -- it re-focuses it, exactly as `setFocusPath`
   * would.
   */
  openInMode: (modeId: string, target: string) => void
  setViewport: (viewport: Viewport) => void
  zoomAtPointer: (pointer: Point, factor: number) => void
  panBy: (dx: number, dy: number) => void
  fitTo: (rect: Rect, size: Size, padding?: number) => void
  /** Centre the camera on a world rect (tic-bee0); see viewport.centerOn. */
  centerOn: (rect: Rect, size: Size, opts?: CenterOnOptions) => void

  moveNodes: (positions: Readonly<Record<string, Point>>) => void
  clearOverrides: () => void
  toggleExpanded: (id: string) => void
  /** Fold every id in `dirIds` for the active mode (fs-tree `dir:<path>`
   *  folder keys, and expanded-file container keys for the object-expansion
   *  collapse), persisting like any other expand change. */
  collapseAllFolders: (dirIds: readonly string[]) => void
  /** Open every id in `dirIds` (fs-tree `dir:<path>` folder keys) for the
   *  active mode, persisting like any other expand change. */
  expandAllFolders: (dirIds: readonly string[]) => void

  /** Whether the Filter Files query also drives the canvas (tic-9098). */
  setFilterVisible: (visible: boolean) => void
  /** Whether the inspector card is collapsed to its identifying bar (tic-88ac). */
  setInspectorCollapsed: (collapsed: boolean) => void
  /** Toggle marching-ants on every edge (tic-5196); persisted as a UI pref. */
  setAnimateAllEdges: (animate: boolean) => void

  select: (ids: readonly string[], additive?: boolean) => void
  toggleSelected: (id: string) => void
  clearSelection: () => void
  setHovered: (id: string | null) => void
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set()

/**
 * One mode's state, focused on `path`; null when nothing would change.
 *
 * Shared by `setFocusPath` (focus the active mode) and `openInMode` (focus a
 * mode while switching to it, tic-e738) so the two can never disagree about
 * what entering a scope means -- which they would, since only one of them is
 * exercised by everyday clicking.
 */
function enterFocus(mode: ModeState, path: string): ModeState | null {
  // Entering a scope auto-expands the focused folder (tic-b1ab): a folder the
  // user had collapsed would otherwise open to an empty scope.  The `dir:` key
  // is the fs-tree mode's directory expand-key convention; the add is
  // additive, so nothing the user already has open is collapsed.  The root
  // (empty path) has no folder to expand.
  const expanded =
    path !== '' && mode.expanded[`dir:${path}`] !== true
      ? { ...mode.expanded, [`dir:${path}`]: true }
      : mode.expanded
  if (mode.focusPath === path) {
    // Re-entering the current scope (e.g. its own breadcrumb) re-opens a
    // folder the user had collapsed from inside it.
    if (expanded === mode.expanded) return null
    return { ...mode, expanded }
  }
  // Entering a scope must not inherit drag overrides from the wider view: a
  // chip dragged around the whole graph has no meaningful position inside the
  // focused subtree.
  return { ...mode, focusPath: path, overrides: {}, expanded }
}

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
    inspectorCollapsed: readUiPrefs().inspectorCollapsed,
    animateAllEdges: readUiPrefs().animateAllEdges,

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

    setParams: (params) =>
      patchMode((mode) =>
        sameParams(mode.params, params) ? null : { ...mode, params: { ...params } },
      ),

    setExpanded: (expanded) =>
      patchMode((mode) =>
        sameParams(mode.expanded, expanded) ? null : { ...mode, expanded: { ...expanded } },
      ),

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

    centerOn: (rect, size, opts) =>
      patchMode((mode) => {
        const viewport = centerOn(mode.viewport, rect, size, opts)
        return viewport === mode.viewport ? null : { ...mode, viewport }
      }),

    setFocusPath: (path) => patchMode((mode) => enterFocus(mode, path)),

    openInMode: (modeId, target) =>
      set((state) => {
        const known = state.modes[modeId]
        const saved = known ? null : readModeState(modeId)
        const current = known ?? saved ?? emptyModeState()
        const focused = enterFocus(current, target) ?? current
        const modes = { ...state.modes, [modeId]: focused }

        if (state.modeId === modeId) {
          // Same mode: this is a re-focus, and the selection/hover reset a
          // mode SWITCH performs would be gratuitous.
          return focused === current ? { modes: state.modes } : { modes }
        }
        return {
          modeId,
          modes,
          restored: known ? true : saved !== null,
          // Cleared for the same reason `setMode` clears them: a selection
          // and a hover are ids in the mode being left, and mean nothing in
          // the one being entered.
          selection: EMPTY_SELECTION,
          hovered: null,
        }
      }),

    moveNodes: (positions) =>
      patchMode((mode) => ({ ...mode, overrides: { ...mode.overrides, ...positions } })),

    clearOverrides: () =>
      patchMode((mode) => (Object.keys(mode.overrides).length === 0 ? null : { ...mode, overrides: {} })),

    collapseAllFolders: (dirIds) =>
      patchMode((mode) => {
        const expanded = { ...mode.expanded }
        let changed = false
        for (const id of dirIds) {
          if (expanded[id] !== false) {
            expanded[id] = false
            changed = true
          }
        }
        return changed ? { ...mode, expanded } : null
      }),

    expandAllFolders: (dirIds) =>
      patchMode((mode) => {
        const expanded = { ...mode.expanded }
        let changed = false
        for (const id of dirIds) {
          if (expanded[id] !== true) {
            expanded[id] = true
            changed = true
          }
        }
        return changed ? { ...mode, expanded } : null
      }),


    toggleExpanded: (id) =>
      patchMode((mode) => ({ ...mode, expanded: { ...mode.expanded, [id]: !mode.expanded[id] } })),

    setFilterVisible: (visible) =>
      patchMode((mode) => (mode.filterVisible === visible ? null : { ...mode, filterVisible: visible })),

    setInspectorCollapsed: (collapsed) =>
      set((state) =>
        state.inspectorCollapsed === collapsed ? state : { inspectorCollapsed: collapsed },
      ),

    setAnimateAllEdges: (animate) =>
      set((state) => (state.animateAllEdges === animate ? state : { animateAllEdges: animate })),

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

/** Shallow equality for the flat JSON records params and expand state are. */
function sameParams(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((key) => a[key] === b[key])
}

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
export const selectFilterVisible = (state: WorkspaceState) => activeMode(state).filterVisible
export const selectFocusPath = (state: WorkspaceState) => activeMode(state).focusPath

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

// The inspector's collapse is a standalone UI preference (tic-88ac): written to
// its own key, never into a mode slice, so a saved preset cannot capture it.
useWorkspace.subscribe((state, previous) => {
  if (state.inspectorCollapsed === previous.inspectorCollapsed && state.animateAllEdges === previous.animateAllEdges)
    return
  // Write both chrome prefs from live state, so changing either one never
  // clobbers the other (tic-5196).
  writeUiPrefs({ inspectorCollapsed: state.inspectorCollapsed, animateAllEdges: state.animateAllEdges })
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
