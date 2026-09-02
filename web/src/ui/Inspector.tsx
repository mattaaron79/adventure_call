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
import { stateTouchedBy, variableImpact } from '../data/dataFlow'
import type { SymbolIndex, Workspace } from '../data/derive'
import { normalizePath } from '../data/filters'
import { loadRegistry } from '../data/load'
import type { GraphNode, SymbolKind } from '../data/types'
// The cross-mode jump (tic-d6af): naming the destination mode takes the leaf
// ids module, and taking the jump takes the store's openInMode -- the same
// call the canvas's open-in button makes, so a jump from here records the
// same excursion provenance and gets the same way back.
import { CALL_FLOW_MODE_ID } from '../modes/ids'
import { useWorkspace } from '../state/store'
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

/**
 * The vscode:// source link for every scene element that resolves to a symbol
 * or a file (tic-468e), keyed by the element id the canvas renders.  Symbols
 * resolve through the mode output's `symbolOf` (element id -> symbol id) to the
 * index; file chips carry their own path as the element id and resolve straight
 * to their module.  Elements with no symbol or file -- directory chips, section
 * headers, stubs, group boxes -- get no link, so the canvas shows the
 * file-symlink affordance only where there is a real source line to open.
 */
export function buildSourceLinks(
  elementIds: Iterable<string>,
  symbolOf: ReadonlyMap<string, string>,
  index: SymbolIndex,
  absoluteRoot: string | null,
): Map<string, string> {
  const links = new Map<string, string>()
  for (const elementId of elementIds) {
    const symbolId = symbolOf.get(elementId)
    const node =
      symbolId !== undefined ? index.byId.get(symbolId) : index.moduleByFile.get(elementId)
    if (!node) continue
    const url = vscodeFileLink(absoluteRoot, node.file_path, node.start_line)
    if (url !== null) links.set(elementId, url)
  }
  return links
}

/**
 * Launch a `vscode://file/...` deep link without the browser keeping a blank
 * tab behind (tic-e523).  A plain anchor with `target="_blank"` opens a new
 * tab the OS protocol handler never fills, leaving a dead tab that does
 * nothing.  Instead the URL is handed to the handler through a hidden iframe:
 * the browser routes the custom scheme to the OS, the iframe is invisible, and
 * no tab is ever created.  The iframe is dropped once the OS has had a moment
 * to take over.
 */
export function launchVscodeLink(url: string): void {
  if (typeof document === 'undefined') return
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  iframe.src = url
  document.body.appendChild(iframe)
  window.setTimeout(() => iframe.remove(), 1000)
}

/**
 * The target of the 'trace call flow' jump (tic-d6af): the selected symbol's
 * id, in the call-flow mode's focus vocabulary, or null when the selection
 * has no call flow to trace -- a module, class, variable or attribute.  Only
 * a function or method can set something in motion, and an affordance that
 * does nothing is worse than none.
 */
export function traceCallFlowTarget(node: GraphNode): string | null {
  return node.kind === 'function' || node.kind === 'method' ? node.symbol_id : null
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

/**
 * The files that import one file (tic-2caf) -- the reverse of
 * {@link buildImportRows}.
 *
 * Imports answer "what does this file need"; this answers "who breaks if I
 * change it", which the card could not answer at all before.  One row per
 * importing FILE rather than per symbol: the forward section names symbols
 * because that is what an import statement binds, but the incoming
 * relationship is a fact about files -- one importer pulling three symbols
 * is one dependency, not three.
 *
 * Shaped as an {@link ImportRow} so both sections render through the same
 * markup, and never `external`: an external module is something this
 * codebase imports, never something that imports it, so the muted treatment
 * cannot apply here.  Reads tic-0680's reverse index, so this is a map
 * lookup rather than a scan of every edge in the graph.
 */
export function buildImportedByRows(workspace: Workspace, filePath: string): ImportRow[] {
  const rows: ImportRow[] = []
  for (const edge of workspace.fileImporters.get(filePath) ?? []) {
    const module = workspace.index.moduleByFile.get(edge.source)
    rows.push({
      key: `impby:${edge.source}`,
      goto: edge.source,
      // Shaped like the Imports rows so the two sections read as siblings;
      // the raw path is the fallback for an importer whose module node is
      // somehow not in this index.
      label: module ? `${module.name} \u00b7 ${module.id}` : edge.source,
      external: false,
      count: edge.count,
    })
  }
  return rows
}

/**
 * How many rows a state section renders before the rest becomes a count.
 *
 * The blast radius saturates: on ../carnot the deepest `throughCalls` is 111
 * variables and a tenth of variables reach 200+ callers, so a section that
 * rendered everything would push Source off the card entirely. Twenty is
 * enough to recognise a pattern; the summary carries the rest.
 */
export const STATE_ROW_LIMIT = 20

/** One titled list in the inspector's state area. */
export interface StateSection {
  title: string
  rows: ImportRow[]
}

export interface StateView {
  sections: StateSection[]
  /** The line under the sections, or null when there is nothing left to say. */
  summary: string | null
}

const EMPTY_STATE: StateView = { sections: [], summary: null }

/** A symbol row shaped like an {@link ImportRow} so it renders through the
 *  same markup, which is what keeps the two from drifting apart. */
function symbolRow(workspace: Workspace, prefix: string, id: string): ImportRow {
  const target = workspace.index.byId.get(id)
  return {
    key: `${prefix}:${id}`,
    goto: target ? normalizePath(target.file_path) : null,
    label: target ? `${target.name} · ${target.module}` : id,
    external: false,
    count: 1,
  }
}

function rowsFor(workspace: Workspace, prefix: string, ids: readonly string[]): ImportRow[] {
  return ids.slice(0, STATE_ROW_LIMIT).map((id) => symbolRow(workspace, prefix, id))
}

/**
 * The reads/writes sections for one selection (tic-675a).
 *
 * Two different questions depending on what is selected, and the asymmetry is
 * the point:
 *
 * - a VARIABLE or ATTRIBUTE answers "what breaks if I change this" -- who
 *   writes it, who reads it, and how far that reaches through the call graph;
 * - a CALLABLE answers "what state does this touch" -- what it reads and
 *   writes itself, and what it reaches only through the things it calls.
 *
 * Writers come before readers, and both come before the reach, for the same
 * reason Imported By sits above Imports: a reader wants the consequence first.
 *
 * Everything here is a floor, never a total. Both edge types rest on the
 * resolved graph, so a function missing from a blast radius has not been
 * cleared -- it has not been seen -- and the wording never says "affected".
 */
export function buildStateSections(workspace: Workspace, node: GraphNode): StateView {
  if (node.kind === 'variable' || node.kind === 'attribute') {
    return variableSections(workspace, node)
  }
  if (node.kind === 'function' || node.kind === 'method' || node.kind === 'class') {
    return callableSections(workspace, node)
  }
  return EMPTY_STATE
}

function variableSections(workspace: Workspace, node: GraphNode): StateView {
  const impact = variableImpact(workspace.callGraph, workspace.accesses, node.id)
  const sections: StateSection[] = []
  if (impact.writers.length > 0) {
    sections.push({ title: 'Written By', rows: rowsFor(workspace, 'w', impact.writers) })
  }
  if (impact.readers.length > 0) {
    sections.push({ title: 'Read By', rows: rowsFor(workspace, 'r', impact.readers) })
  }
  if (sections.length === 0) return EMPTY_STATE

  const parts: string[] = []
  const hidden =
    Math.max(0, impact.writers.length - STATE_ROW_LIMIT) +
    Math.max(0, impact.readers.length - STATE_ROW_LIMIT)
  if (hidden > 0) parts.push(`${hidden} more not shown`)
  if (impact.reached.length > 0) {
    // `200+` and never `200`: the walk stopped at the budget, so the number
    // is a floor and rendering it flat would state a total that is not one.
    const reach = impact.truncated ? `${impact.reached.length}+` : `${impact.reached.length}`
    parts.push(`${reach} more reached through calls`)
  }
  // No analysis beyond counting, and rare enough to mean something: exactly
  // one module-level variable on each of ../carnot and hypermenu qualifies.
  if (impact.shared) parts.push(`shared mutable state — ${impact.writers.length} writers`)
  return { sections, summary: parts.length > 0 ? parts.join(' · ') : null }
}

function callableSections(workspace: Workspace, node: GraphNode): StateView {
  const touched = stateTouchedBy(workspace.callGraph, workspace.accesses, node.id)
  const sections: StateSection[] = []
  if (touched.writes.length > 0) {
    sections.push({ title: 'Writes', rows: rowsFor(workspace, 'sw', touched.writes) })
  }
  if (touched.reads.length > 0) {
    sections.push({ title: 'Reads', rows: rowsFor(workspace, 'sr', touched.reads) })
  }
  // The section a reader cannot get from the function's body, and where the
  // surprises are: on ../carnot 836 symbols touch state ONLY this way.
  if (touched.throughCalls.length > 0) {
    sections.push({
      title: 'Through Calls',
      rows: rowsFor(workspace, 'st', touched.throughCalls),
    })
  }
  if (sections.length === 0) return EMPTY_STATE

  const hidden =
    Math.max(0, touched.writes.length - STATE_ROW_LIMIT) +
    Math.max(0, touched.reads.length - STATE_ROW_LIMIT) +
    Math.max(0, touched.throughCalls.length - STATE_ROW_LIMIT)
  const parts: string[] = []
  if (hidden > 0) parts.push(`${hidden} more not shown`)
  if (touched.truncated) parts.push('call walk stopped at the budget')
  return { sections, summary: parts.length > 0 ? parts.join(' · ') : null }
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

/**
 * One list of import relationships (tic-2caf).
 *
 * Imports and Imported By are the same rows pointing opposite ways, so they
 * render through one component rather than two copies of the markup that
 * could drift apart.  A section with no rows renders nothing at all, which
 * is how Imports has always behaved.
 */
function ImportSection({ title, rows }: { title: string; rows: ImportRow[] }) {
  if (rows.length === 0) return null
  return (
    <>
      <h3>{title}</h3>
      <ul className="inspector-list inspector-imports">
        {rows.map((row) => (
          <li key={row.key} className={row.external ? 'inspector-external' : undefined}>
            <code>{row.label}</code>
            {row.count > 1 && <span className="inspector-dim"> ×{row.count}</span>}
            {/* Internal targets fly the camera to the file; external ones
                (tic-314c) have nothing to centre on and get no icon. */}
            {row.goto !== null && <GotoIcon target={row.goto} label={`Go to ${row.goto}`} />}
          </li>
        ))}
      </ul>
    </>
  )
}

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
  // The 'trace call flow' jump (tic-d6af): present for ANY callable selection
  // in ANY mode, including selections whose scene element carries no
  // affordance -- that is what makes the inspector the cheapest surface for it.
  const traceTarget = useMemo(() => (node ? traceCallFlowTarget(node) : null), [node])

  // The file's imports and its per-kind symbol counts, derived once per
  // selection from the in-memory workspace.
  const imports = useMemo(
    () => (node && workspace ? buildImportRows(workspace, filePath) : []),
    [node, workspace, filePath],
  )
  // Who imports this file (tic-2caf), above the outgoing list: a reader asks
  // "who breaks if I change this" before "what does this need".
  const importedBy = useMemo(
    () => (node && workspace ? buildImportedByRows(workspace, filePath) : []),
    [node, workspace, filePath],
  )
  // Reads/writes (tic-675a).  A variable answers "what breaks if I change
  // this"; a callable answers "what state does this touch".
  const state = useMemo(
    () => (node && workspace ? buildStateSections(workspace, node) : null),
    [node, workspace],
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
                rel="noreferrer"
                title={`Open ${node.file_path} in VS Code`}
                onClick={(e) => {
                  // Launch via a hidden iframe so no blank tab is left behind
                  // (tic-e523).  The href stays for copy/right-click; plain
                  // left-click is intercepted here.
                  e.preventDefault()
                  launchVscodeLink(pathLink)
                }}
              >
                {node.file_path}:{node.start_line}
              </a>
            </p>
          ) : (
            <p className="inspector-path">
              {node.file_path}:{node.start_line}
            </p>
          )}

          {traceTarget !== null && (
            <p className="inspector-trace">
              <button
                type="button"
                className="inspector-trace-button"
                title={`Trace call flow from ${node.name}`}
                aria-label={`Trace call flow from ${node.name}`}
                onClick={() => {
                  useWorkspace.getState().openInMode(CALL_FLOW_MODE_ID, traceTarget)
                }}
              >
                Trace call flow
              </button>
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
            {(node.kind === 'function' || node.kind === 'method') && node.complexity !== undefined && (
              <li>
                {/* Cyclomatic-style proxy (tic-d7d1), not textbook complexity:
                    a relative-ordering number within this codebase. */}
                <span className="inspector-fact">complexity</span>
                <code>{node.complexity}</code>
              </li>
            )}
            {node.line_count !== undefined && node.line_count > 0 && (
              <li>
                <span className="inspector-fact">loc</span>
                <code>{node.line_count}</code>
              </li>
            )}
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

          <ImportSection title="Imported By" rows={importedBy} />
          <ImportSection title="Imports" rows={imports} />

          {state?.sections.map((section) => (
            <ImportSection key={section.title} title={section.title} rows={section.rows} />
          ))}
          {state?.summary !== null && state?.summary !== undefined && (
            <p className="inspector-dim">{state.summary}</p>
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
