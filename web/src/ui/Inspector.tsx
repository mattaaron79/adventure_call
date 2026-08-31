/**
 * The selection inspector.
 *
 * Everything shown comes from codebase_graph.json, which is already in
 * memory; the source body alone lives in symbol_registry.json, so it is
 * fetched lazily the first time a selection actually wants it (and the
 * registry promise is memoised in the data layer, so this is free after the
 * first time).
 */
import { useEffect, useMemo, useState } from 'react'
import type { ExternalImport } from '../data/derive'
import { normalizePath } from '../data/filters'
import { loadRegistry } from '../data/load'
import type { GraphNode } from '../data/types'
import { GotoIcon } from './GotoIcon'

type SourceState = 'idle' | 'loading' | 'ready' | 'unavailable'

export function Inspector({
  node,
  externalImports = [],
}: {
  node: GraphNode | null
  /** The workspace's registry-derived external imports (tic-314c); empty
   *  until the registry has been fetched. */
  externalImports?: readonly ExternalImport[]
}) {
  // The imports of the file the selected node lives in; empty until the
  // registry arrives, since codebase_graph.json drops external targets.
  const fileExternal = useMemo(
    () => (node ? externalImports.filter((imp) => imp.source === normalizePath(node.file_path)) : []),
    [node, externalImports],
  )
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
        {/* Fly the camera to the selected node's file (tic-bee0). */}
        <GotoIcon target={node.file_path} label={`Go to ${node.file_path}`} />
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

      {fileExternal.length > 0 && (
        <>
          <h3>External imports</h3>
          <ul className="inspector-list inspector-external">
            {fileExternal.map((imp) => (
              <li key={imp.target}>
                <code>{imp.target}</code>
                {imp.count > 1 && <span className="inspector-dim"> ×{imp.count}</span>}
              </li>
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
