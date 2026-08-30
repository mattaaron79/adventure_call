import type { CodebaseGraph, SymbolKind } from '../data/types'

const KIND_COLOR: Record<SymbolKind, string> = {
  module: 'var(--module)',
  class: 'var(--class)',
  function: 'var(--function)',
  method: 'var(--method)',
  variable: 'var(--variable)',
  attribute: 'var(--variable)',
}

interface Props {
  status:
    | { phase: 'loading' }
    | { phase: 'ready'; graph: CodebaseGraph }
    | { phase: 'error'; error: string }
}

export function Sidebar({ status }: Props) {
  return (
    <aside className="sidebar">
      <h1>Adventure Call</h1>
      {status.phase === 'ready' ? (
        <p className="root-path">{status.graph.graph.root}</p>
      ) : (
        <p className="root-path">/out</p>
      )}

      {status.phase === 'loading' && <p style={{ color: 'var(--text-faint)' }}>Loading /out…</p>}

      {status.phase === 'error' && (
        <p className="error">
          Could not read the graph export.
          <code>{status.error}</code>
          Run <code>uv run adventure-call &lt;path&gt; -o out</code> to generate it.
        </p>
      )}

      {status.phase === 'ready' && <Stats graph={status.graph} />}
    </aside>
  )
}

function Stats({ graph }: { graph: CodebaseGraph }) {
  const { stats, generated_at } = graph.graph
  const kinds = Object.entries(stats.node_kinds) as [SymbolKind, number][]
  const edges = Object.entries(stats.edge_types)

  return (
    <>
      <h2>Corpus</h2>
      <dl className="stat-grid">
        <dt>Files</dt>
        <dd>{stats.files.toLocaleString()}</dd>
        <dt>Symbols</dt>
        <dd>{stats.symbols.toLocaleString()}</dd>
        <dt>Nodes</dt>
        <dd>{stats.nodes.toLocaleString()}</dd>
        <dt>Edges</dt>
        <dd>{stats.edges.toLocaleString()}</dd>
      </dl>

      <h2>Node kinds</h2>
      <dl className="stat-grid">
        {kinds.map(([kind, count]) => (
          <Row key={kind} label={kind} color={KIND_COLOR[kind]} value={count} />
        ))}
      </dl>

      <h2>Edge types</h2>
      <dl className="stat-grid">
        {edges.map(([type, count]) => (
          <Row key={type} label={type} value={count} />
        ))}
      </dl>

      <h2>Call resolution</h2>
      <dl className="stat-grid">
        <dt>Exact</dt>
        <dd>{stats.calls_resolved.toLocaleString()}</dd>
        <dt>Heuristic</dt>
        <dd>{stats.calls_heuristic.toLocaleString()}</dd>
        <dt>Unresolved</dt>
        <dd>{stats.calls_unresolved.toLocaleString()}</dd>
        <dt>Builtin</dt>
        <dd>{stats.calls_builtin.toLocaleString()}</dd>
      </dl>

      <h2>Generated</h2>
      <p className="root-path" style={{ margin: 0 }}>
        {new Date(generated_at).toLocaleString()}
      </p>
    </>
  )
}

function Row({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <>
      <dt>
        {color && <span className="swatch" style={{ background: color }} />}
        {label}
      </dt>
      <dd>{value.toLocaleString()}</dd>
    </>
  )
}
