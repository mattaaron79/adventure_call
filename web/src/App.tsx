import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deriveWorkspace } from './data/derive'
import { readExcludes, writeExcludes } from './data/filters'
import { loadGraph, onDataChanged } from './data/load'
import type { CodebaseGraph } from './data/types'
import { StageHost } from './canvas/StageHost'
import { Sidebar } from './ui/Sidebar'

type Status =
  | { phase: 'loading' }
  | { phase: 'ready'; graph: CodebaseGraph }
  | { phase: 'error'; error: string }

export function App() {
  const [status, setStatus] = useState<Status>({ phase: 'loading' })
  const [excludes, setExcludes] = useState<string[]>(readExcludes)
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

  // deriveWorkspace is itself memoised on (graph, excludes), so this only
  // guards against handing Sidebar a new object when neither has changed.
  const graph = status.phase === 'ready' ? status.graph : null
  const workspace = useMemo(
    () => (graph ? deriveWorkspace(graph, excludes) : null),
    [graph, excludes],
  )

  return (
    <div className="app">
      <Sidebar
        status={status}
        workspace={workspace}
        excludes={excludes}
        onExcludesChange={changeExcludes}
      />
      <div className="stage-host">
        <StageHost />
        {workspace && (
          <div className="placeholder">
            <strong>Workspace canvas lands next</strong>
            <span>
              {workspace.tree.fileCount.toLocaleString()} files ·{' '}
              {workspace.fileImports.length.toLocaleString()} file-to-file import edges
            </span>
          </div>
        )}
        {reloadedAt !== null && (
          <div className="reload-flash" key={reloadedAt}>
            reloaded from /out
          </div>
        )}
      </div>
    </div>
  )
}
