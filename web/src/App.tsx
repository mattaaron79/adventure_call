import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deriveWorkspace } from './data/derive'
import { DEFAULT_EXCLUDES, readExcludes, writeExcludes } from './data/filters'
import { loadGraph, onDataChanged } from './data/load'
import type { CodebaseGraph, GraphNode } from './data/types'
import { Workspace } from './canvas/Workspace'
import { lodOf } from './canvas/lod'
import { EMPTY_SCENE } from './canvas/scene'
import { modeById } from './modes/registry'
import { renderMode } from './modes/types'
import { activeMode, selectExpanded, selectFilterVisible, useWorkspace } from './state/store'
import { Inspector } from './ui/Inspector'
import { Sidebar } from './ui/Sidebar'

type Status =
  | { phase: 'loading' }
  | { phase: 'ready'; graph: CodebaseGraph }
  | { phase: 'error'; error: string }

export function App() {
  const [status, setStatus] = useState<Status>({ phase: 'loading' })
  const [excludes, setExcludes] = useState<string[]>(readExcludes)
  const [noiseFilter, setNoiseFilter] = useState(true)
  // The Filter Files query (tic-9098) lives here so it can reach both the
  // sidebar tree and, through deriveWorkspace, the canvas.
  const [fileQuery, setFileQuery] = useState('')
  const [reloadedAt, setReloadedAt] = useState<number | null>(null)
  // Guards against an in-flight fetch from a superseded reload overwriting a
  // newer one; /out can be rewritten twice in quick succession.
  const generation = useRef(0)

  const refresh = useCallback(async (announce: boolean) => {
    const mine = ++generation.current
    try {
      const graph = await loadGraph()
      if (mine !== generation.current) return
      setStatus({ phase: 'ready', graph })
      if (announce) setReloadedAt(Date.now())
    } catch (err) {
      if (mine !== generation.current) return
      setStatus({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  useEffect(() => {
    void refresh(false)
    return onDataChanged(() => void refresh(true))
  }, [refresh])

  const changeExcludes = useCallback((next: string[]) => {
    setExcludes(next)
    writeExcludes(next)
  }, [])

  // The noise toggle lifts the built-in patterns without editing the user's
  // own list, which stays persisted exactly as they left it.
  const effectiveExcludes = useMemo(
    () => (noiseFilter ? excludes : excludes.filter((p) => !DEFAULT_EXCLUDES.includes(p))),
    [excludes, noiseFilter],
  )

  // deriveWorkspace is itself memoised on (graph, excludes, query), so this
  // only guards against handing Sidebar a new object when none has changed.
  const graph = status.phase === 'ready' ? status.graph : null
  // The eye toggle (tic-9098): when on, the workspace is re-derived from what
  // the query leaves visible, so the mode's select phase -- and therefore the
  // canvas -- tracks the filter.  When off, the query prunes the sidebar only.
  const filterVisible = useWorkspace(selectFilterVisible)
  const workspace = useMemo(
    () => (graph ? deriveWorkspace(graph, effectiveExcludes, filterVisible ? fileQuery : '') : null),
    [graph, effectiveExcludes, filterVisible, fileQuery],
  )

  // The active mode renders entirely through the VizMode interface: the app
  // never touches a mode's internals, only the ModeOutput that comes back.
  const modeId = useWorkspace((s) => s.modeId)
  const savedParams = useWorkspace((s) => activeMode(s).params)
  const expanded = useWorkspace(selectExpanded)
  const mode = modeById(modeId)
  const params = useMemo(
    () => ({ ...mode.defaultParams, ...savedParams }),
    [mode, savedParams],
  )
  // Zoom LOD as a selector: a number, so this re-renders only when a
  // threshold is crossed, never per pan/zoom frame (tic-fa56).
  const lod = useWorkspace((s) => lodOf(activeMode(s).viewport.scale))
  const layout = useMemo(
    () => (workspace ? renderMode(mode, workspace, params, { expanded, lod }) : null),
    [mode, params, workspace, expanded, lod],
  )
  const scene = layout?.scene ?? EMPTY_SCENE

  // Clicking a directory chip or a file chip/container toggles it; rows and
  // everything else just select (which the pointer-down handler already did).
  const onActivate = useCallback(
    (id: string) => {
      if (layout?.expandable.has(id)) useWorkspace.getState().toggleExpanded(id)
    },
    [layout],
  )

  // A preset's filters were captured as the effective list, so restoring them
  // means: use them verbatim, with the noise toggle folded in (on).
  const applyPresetFilters = useCallback((filters: string[]) => {
    setExcludes(filters)
    setNoiseFilter(true)
  }, [])

  const selection = useWorkspace((s) => s.selection)
  const selectedNode = useMemo<GraphNode | null>(() => {
    if (!workspace || !layout) return null
    for (const id of selection) {
      const symbolId = layout.symbolOf.get(id)
      if (symbolId !== undefined) return workspace.index.byId.get(symbolId) ?? null
      const direct = workspace.index.byId.get(id)
      if (direct) return direct
      const module = workspace.index.moduleByFile.get(id)
      if (module) return module
    }
    return null
  }, [selection, workspace, layout])

  return (
    <div className="app">
      <Sidebar
        status={status}
        workspace={workspace}
        excludes={excludes}
        onExcludesChange={changeExcludes}
        noiseFilter={noiseFilter}
        onNoiseFilterChange={setNoiseFilter}
        effectiveFilters={effectiveExcludes}
        onApplyPresetFilters={applyPresetFilters}
        fileQuery={fileQuery}
        onFileQueryChange={setFileQuery}
        filterVisible={filterVisible}
        onFilterVisibleChange={(next) => useWorkspace.getState().setFilterVisible(next)}
      />
      <div className="stage-host">
        <Workspace scene={scene} onActivate={onActivate} expandable={layout?.expandable} />
        {workspace === null && status.phase !== 'error' && (
          <div className="placeholder">
            <strong>Reading /out…</strong>
          </div>
        )}
        {reloadedAt !== null && (
          <div className="reload-flash" key={reloadedAt}>
            reloaded from /out
          </div>
        )}
        <Inspector node={selectedNode} />
      </div>
    </div>
  )
}
