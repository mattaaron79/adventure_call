import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deriveWorkspace } from './data/derive'
import { DEFAULT_EXCLUDES, readExcludes, writeExcludes } from './data/filters'
import { loadGraph, onDataChanged } from './data/load'
import type { CodebaseGraph, GraphNode } from './data/types'
import { Workspace } from './canvas/Workspace'
import { EMPTY_SCENE } from './canvas/scene'
import { fsTreeScene } from './modes/fsTree'
import { selectExpanded, useWorkspace } from './state/store'
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

  // deriveWorkspace is itself memoised on (graph, excludes), so this only
  // guards against handing Sidebar a new object when neither has changed.
  const graph = status.phase === 'ready' ? status.graph : null
  const workspace = useMemo(
    () => (graph ? deriveWorkspace(graph, effectiveExcludes) : null),
    [graph, effectiveExcludes],
  )

  const expanded = useWorkspace(selectExpanded)
  const layout = useMemo(
    () => (workspace ? fsTreeScene(workspace, expanded) : null),
    [workspace, expanded],
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

  const selection = useWorkspace((s) => s.selection)
  const selectedNode = useMemo<GraphNode | null>(() => {
    if (!workspace || !layout) return null
    for (const id of selection) {
      const symbolId = layout.symbolOfRow.get(id)
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
      />
      <div className="stage-host">
        <Workspace scene={scene} onActivate={onActivate} />
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
