import { useMemo } from 'react'
import type { FsFile, Workspace } from '../data/derive'
import type { CodebaseGraph, SymbolKind } from '../data/types'
import { fileFacts, matchFile, parseQuery } from '../data/query'
import { ExcludeEditor } from './ExcludeEditor'
import { FileTree, matchTree } from './FileTree'
import { ModePicker } from './ModePicker'

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
  /** The derived view of `status.graph`; null until the graph is ready. */
  workspace: Workspace | null
  excludes: readonly string[]
  onExcludesChange: (next: string[]) => void
  /** Whether the built-in noise patterns are being applied. */
  noiseFilter: boolean
  onNoiseFilterChange: (next: boolean) => void
  /** The effective exclude list, captured into a preset on save. */
  effectiveFilters: readonly string[]
  /** Applies a preset's filters; the exclude state lives in App. */
  onApplyPresetFilters: (filters: string[]) => void
  /** The Filter Files query (tic-9098); lives in App so it can drive the canvas. */
  fileQuery: string
  onFileQueryChange: (next: string) => void
  /** Whether the query also decides what the canvas shows. */
  filterVisible: boolean
  onFilterVisibleChange: (next: boolean) => void
}

export function Sidebar({
  status,
  workspace,
  excludes,
  onExcludesChange,
  noiseFilter,
  onNoiseFilterChange,
  effectiveFilters,
  onApplyPresetFilters,
  fileQuery,
  onFileQueryChange,
  filterVisible,
  onFilterVisibleChange,
}: Props) {
  // File filter; '/' from the canvas focuses this input (tic-fa56).  The
  // query language (tic-9098) is parsed here for the tree and reported to App
  // raw, so the canvas re-derivation goes through deriveWorkspace, not the UI.
  const query = useMemo(() => parseQuery(fileQuery), [fileQuery])
  const matches = useMemo(() => {
    if (!workspace) return () => false
    const index = workspace.index
    return (file: FsFile) =>
      matchFile(query, fileFacts(file.module, index.byModule.get(file.module.id) ?? []))
  }, [workspace, query])
  const filteredTree = useMemo(
    () => (workspace ? matchTree(workspace.tree, matches) : null),
    [workspace, matches],
  )
  const queryError = query.kind === 'error' ? query.message : null

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

      <ModePicker filters={effectiveFilters} onApplyFilters={onApplyPresetFilters} />

      {status.phase === 'ready' && workspace && (
        <>
          <Stats graph={status.graph} workspace={workspace} />
          <label className="noise-toggle">
            <input
              type="checkbox"
              checked={noiseFilter}
              onChange={(event) => onNoiseFilterChange(event.target.checked)}
            />
            Hide noise
            <span className="noise-patterns">.pytest_tmp · scratch · __pycache__</span>
          </label>
          <ExcludeEditor excludes={excludes} onChange={onExcludesChange} />
          <h2>Files</h2>
          <div className="file-search-row">
            <input
              id="file-search"
              className={`file-search${queryError ? ' invalid' : ''}`}
              type="text"
              placeholder="Filter files  ( / )"
              value={fileQuery}
              aria-invalid={queryError !== null}
              onChange={(event) => onFileQueryChange(event.target.value)}
            />
            <button
              type="button"
              className={`eye-toggle${filterVisible ? ' active' : ''}`}
              title={
                filterVisible
                  ? 'Canvas shows only matching files'
                  : 'Canvas shows all files'
              }
              aria-pressed={filterVisible}
              aria-label="Filter the canvas by the file query"
              onClick={() => onFilterVisibleChange(!filterVisible)}
            >
              👁
            </button>
          </div>
          {queryError && <p className="query-error">{queryError}</p>}
          {filteredTree ? (
            <FileTree root={filteredTree} />
          ) : (
            <p className="preset-empty">No files match.</p>
          )}
        </>
      )}
    </aside>
  )
}

function Stats({ graph, workspace }: { graph: CodebaseGraph; workspace: Workspace }) {
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

      <h2>Workspace</h2>
      <dl className="stat-grid">
        <dt>Files shown</dt>
        <dd>{workspace.tree.fileCount.toLocaleString()}</dd>
        <dt>Excluded</dt>
        <dd>{workspace.excludedFiles.toLocaleString()}</dd>
        <dt>Symbols</dt>
        <dd>{(workspace.nodes.length - workspace.modules.length).toLocaleString()}</dd>
        <dt>File imports</dt>
        <dd>{workspace.fileImports.length.toLocaleString()}</dd>
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
