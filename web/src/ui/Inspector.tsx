/**
 * The selection inspector (tic-4b0a).
 *
 * Everything shown comes from the derived workspace, which is already in
 * memory; the source body alone lives in symbol_registry.json, so it is
 * fetched lazily the first time a selection actually wants it (and the
 * registry promise is memoised in the data layer, so this is free after the
 * first time).
 */
import { useEffect, useMemo, useState } from 'react'
import type { Workspace } from '../data/derive'
import { normalizePath } from '../data/filters'
import { loadRegistry } from '../data/load'
import type { GraphNode, SymbolKind } from '../data/types'
import { GotoIcon } from './GotoIcon'

type SourceState = 'idle' | 'loading' | 'ready' | 'unavailable'

// -- pure helpers (exported for tests) ---------------------------------------

/**
 * The VS Code deep link for a file+line, or null when the absolute root is
 * unavailable -- the path then degrades to plain text.  `absoluteRoot` comes
 * from the dev server already resolved (outData.ts), so the browser never has
 * to guess at a relative root; backslashes are normalised to forward slashes
 * because a Windows path is not a valid URI.
 */
export function vscodeFileLink(
  absoluteRoot: string | null,
  filePath: string,
  line: number,
): string | null {
  if (!absoluteRoot || !filePath) return null
  const root = absoluteRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const file = filePath.replace(/^\/+/, '')
  return `vscode://file/${root}/${file}:${line}:1`
}

/** A human-readable line range: `L12` for a single line, `L12–L34` for a span. */
export function lineRange(node: GraphNode): string {
  return node.start_line === node.end_line
    ? `L${node.start_line}`
    : `L${node.start_line}\u2013L${node.end_line}`
}

/** One row of the inspector's Imports section. */
export interface ImportRow {
  /** React key, stable across re-renders. */
  key: string
  /**
   * The camera-goto target (a root-relative file path the fs-tree index
   * resolves) for an internal import, or null for an external one -- external
   * targets have nothing to centre on and render no goto icon.
   */
  goto: string | null
  /** Display label, e.g. `PluginError · app.errors`. */
  label: string
  /** True for a registry-classified external import (tic-314c): muted, linkless. */
  external: boolean
  /** Occurrence count; the UI shows it only when > 1. */
  count: number
}

/**
 * The imports of one file: internal rows first (each carrying its imported
 * file as a goto target), then external rows (tic-314c) which link to nothing.
 */
export function buildImportRows(workspace: Workspace, filePath: string): ImportRow[] {
  const rows: ImportRow[] = []
  for (const edge of workspace.fileImports) {
    if (edge.source !== filePath) continue
    for (const symbolId of edge.symbolIds) {
      const target = workspace.index.byId.get(symbolId)
      rows.push({
        key: `imp:${symbolId}`,
        goto: edge.target,
        label: target ? `${target.name} \u00b7 ${target.module}` : symbolId,
        external: false,
        count: edge.count,
      })
    }
  }
  for (const imp of workspace.externalImports) {
    if (imp.source !== filePath) continue
    rows.push({
      key: `ext:${imp.target}`,
      goto: null,
      label: imp.target,
      external: true,
      count: imp.count,
    })
  }
  return rows
}

/** Per-kind symbol counts for a module, sorted by kind for a stable display. */
export interface KindCount {
  kind: SymbolKind
  count: number
}

export function countSymbolsByKind(nodes: readonly GraphNode[]): KindCount[] {
  const counts = new Map<SymbolKind, number>()
  for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1)
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind))
}

// -- the component ------------------------------------------------------------

export function Inspector({
  node,
  workspace,
  absoluteRoot,
  collapsed,
  onToggleCollapsed,
}: {
  node: GraphNode | null
  /** The derived workspace: file imports, external imports (tic-314c), index. */
  workspace: Workspace | null
  /** Absolute analysed root from the dev server; null degrades the path to text. */
  absoluteRoot: string | null
  /** Whether the card is collapsed to its compact identifying bar (tic-88ac). */
  collapsed: boolean
  /** Toggle the collapse; the flag is a persisted UI preference in the store. */
  onToggleCollapsed: () => void
}) {
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

  const filePath = useMemo(() => (node ? normalizePath(node.file_path) : ''), [node])

  // The file's imports and its per-kind symbol counts, derived once per
  // selection from the in-memory workspace.
  const imports = useMemo(
    () => (node && workspace ? buildImportRows(workspace, filePath) : []),
    [node, workspace, filePath],
  )
  const symbolCounts = useMemo(
    () =>
      node && workspace && node.kind === 'module'
        ? countSymbolsByKind(workspace.index.byModule.get(node.module) ?? [])
        : [],
    [node, workspace],
  )
  const pathLink = useMemo(
    () => (node ? vscodeFileLink(absoluteRoot, node.file_path, node.start_line) : null),
    [node, absoluteRoot],
  )

  if (!node || !workspace) return null

  return (
    <aside className={`inspector${collapsed ? ' inspector-collapsed' : ''}`}>
      <header className="inspector-head">
        <span className={`swatch kind-${node.kind}`} />
        <strong>{node.name}</strong>
        <span className="inspector-kind">{node.kind}</span>
        {/* Fly the camera to the selected node's file (tic-bee0). */}
        <GotoIcon target={node.file_path} label={`Go to ${node.file_path}`} />
        {/* Collapse the card to its identifying bar (tic-88ac). The flag is a
            standalone UI preference, persisted under its own key, so it
            survives reloads and never rides along in a saved preset. */}
        <button
          type="button"
          className="inspector-toggle"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : 'inspector-body'}
          aria-label={collapsed ? 'Show details' : 'Hide details'}
          title={collapsed ? 'Show details' : 'Hide details'}
          onClick={onToggleCollapsed}
        >
          {collapsed ? '\u25b8' : '\u25be'}
        </button>
      </header>

      {!collapsed && (
        <div id="inspector-body">
          {pathLink !== null ? (
            <p className="inspector-path">
              <a
                className="inspector-path-link"
                href={pathLink}
                target="_blank"
                rel="noreferrer"
                title={`Open ${node.file_path} in VS Code`}
              >
                {node.file_path}:{node.start_line}
              </a>
            </p>
          ) : (
            <p className="inspector-path">
              {node.file_path}:{node.start_line}
            </p>
          )}

          <ul className="inspector-facts">
            <li>
              <span className="inspector-fact">kind</span>
              <code>{node.kind}</code>
            </li>
            {node.module !== '' && (
              <li>
                <span className="inspector-fact">module</span>
                <code>{node.module}</code>
              </li>
            )}
            <li>
              <span className="inspector-fact">lines</span>
              <code>{lineRange(node)}</code>
            </li>
            {node.is_async && (
              <li>
                <span className="inspector-fact">async</span>
                <code>yes</code>
              </li>
            )}
          </ul>

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
                    {param.default !== null && (
                      <span className="inspector-dim"> = {param.default}</span>
                    )}
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

          {imports.length > 0 && (
            <>
              <h3>Imports</h3>
              <ul className="inspector-list inspector-imports">
                {imports.map((row) => (
                  <li key={row.key} className={row.external ? 'inspector-external' : undefined}>
                    <code>{row.label}</code>
                    {row.count > 1 && <span className="inspector-dim"> ×{row.count}</span>}
                    {/* Internal targets fly the camera to the imported file;
                        external targets (tic-314c) have no goto icon. */}
                    {row.goto !== null && (
                      <GotoIcon target={row.goto} label={`Go to ${row.goto}`} />
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {symbolCounts.length > 0 && (
            <>
              <h3>Symbols</h3>
              <p className="inspector-dim">
                {symbolCounts
                  .map(({ kind, count }) => `${count} ${kind}${count === 1 ? '' : 's'}`)
                  .join(' · ')}
              </p>
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
        </div>
      )}
    </aside>
  )
}
