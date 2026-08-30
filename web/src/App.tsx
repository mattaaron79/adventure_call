import { useCallback, useEffect, useRef, useState } from 'react'
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

  return (
    <div className="app">
      <Sidebar status={status} />
      <div className="stage-host">
        <StageHost />
        {status.phase === 'ready' && (
          <div className="placeholder">
            <strong>Workspace canvas lands next</strong>
            <span>
              {status.graph.graph.stats.nodes.toLocaleString()} nodes ·{' '}
              {status.graph.graph.stats.edges.toLocaleString()} edges loaded from /out
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
