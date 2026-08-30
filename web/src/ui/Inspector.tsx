/**
 * The selection inspector.
 *
 * Everything shown comes from codebase_graph.json, which is already in
 * memory; the source body alone lives in symbol_registry.json, so it is
 * fetched lazily the first time a selection actually wants it (and the
 * registry promise is memoised in the data layer, so this is free after the
 * first time).
 */
import { useEffect, useState } from 'react'
import { loadRegistry } from '../data/load'
import type { GraphNode } from '../data/types'

type SourceState = 'idle' | 'loading' | 'ready' | 'unavailable'

export function Inspector({ node }: { node: GraphNode | null }) {
  const [source, setSource] = useState<string | null>(null)
  const [sourceState, setSourceState] = useState<SourceState>('idle')

  useEffect(() => {
    setSource(null)
    if (!node) {
      setSourceState('idle')
      return
    }
    setSourceState('loading')
    let cancelled = false
    loadRegistry()
      .then((registry) => {
        if (cancelled) return
        const record = registry.symbols[node.symbol_id]
        setSource(record?.code ?? null)
        setSourceState(record?.code ? 'ready' : 'unavailable')
      })
      .catch(() => {
        if (!cancelled) setSourceState('unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [node])

  if (!node) return null

  return (
    <aside className="inspector">
      <header className="inspector-head">
        <span className={`swatch kind-${node.kind}`} />
        <strong>{node.name}</strong>
        <span className="inspector-kind">{node.kind}</span>
      </header>
      <p className="inspector-path">{node.file_path}:{node.start_line}</p>

      {node.signature !== '' && <pre className="inspector-sig">{node.signature}</pre>}

      {node.docstring !== null && node.docstring !== '' && (
        <p className="inspector-doc">{node.docstring}</p>
      )}

      {node.params.length > 0 && (
        <>
          <h3>Params</h3>
          <ul className="inspector-list">
            {node.params.map((param) => (
              <li key={param.name}>
                <code>{param.name}</code>
                {param.annotation !== null && <span>: {param.annotation}</span>}
                {param.default !== null && <span className="inspector-dim"> = {param.default}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {node.bases.length > 0 && (
        <>
          <h3>Bases</h3>
          <ul className="inspector-list">
            {node.bases.map((base) => (
              <li key={base}>{base}</li>
            ))}
          </ul>
        </>
      )}

      {node.decorators.length > 0 && (
        <>
          <h3>Decorators</h3>
          <ul className="inspector-list">
            {node.decorators.map((decorator) => (
              <li key={decorator}>@{decorator}</li>
            ))}
          </ul>
        </>
      )}

      <h3>Source</h3>
      {sourceState === 'ready' && source !== null && (
        <pre className="inspector-source">{source}</pre>
      )}
      {sourceState === 'loading' && <p className="inspector-dim">Loading symbol_registry…</p>}
      {sourceState === 'unavailable' && (
        <p className="inspector-dim">
          No source in the export (written without --source, or the symbol is a module).
        </p>
      )}
    </aside>
  )
}
