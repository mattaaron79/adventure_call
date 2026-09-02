import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { deriveWorkspace } from './data/derive'
import { DEFAULT_EXCLUDES, readExcludes, writeExcludes } from './data/filters'
import { loadAbsoluteRoot, loadGraph, loadRegistry, onDataChanged } from './data/load'
import type { CodebaseGraph, GraphNode, SymbolRegistry } from './data/types'
import { Workspace } from './canvas/Workspace'
import { lodOf } from './canvas/lod'
import { EMPTY_SCENE } from './canvas/scene'
import { modeById } from './modes/registry'
import { fileOnlyDirIds, fsTreeMode, minimalScopeForTarget } from './modes/fsTree'
import { getLayoutVersion, subscribeLayoutReady } from './modes/asyncLayout'
import { CALL_FLOW_MODE_ID } from './modes/ids'
import {
  EDGE_LEGEND,
  callFlowCoverage,
  formatCoverageHud,
  formatTypeCoverageHud,
} from './modes/callFlow'
import { deriveTypeFlow } from './data/typeFlow'
import { renderMode } from './modes/types'
import { activeMode, selectExpanded, selectFilterVisible, useWorkspace } from './state/store'
import { buildSourceLinks, Inspector } from './ui/Inspector'
import { Sidebar } from './ui/Sidebar'

type Status =
  | { phase: 'loading' }
  | { phase: 'ready'; graph: CodebaseGraph }
  | { phase: 'error'; error: string }

/** No fs-tree folders are file-only before a workspace has loaded. */
const EMPTY_DIR_IDS: ReadonlySet<string> = new Set()

export function App() {
  const [status, setStatus] = useState<Status>({ phase: 'loading' })
  const [excludes, setExcludes] = useState<string[]>(readExcludes)
  const [noiseFilter, setNoiseFilter] = useState(true)
  // The Filter Files query (tic-9098) lives here so it can reach both the
  // sidebar tree and, through deriveWorkspace, the canvas.
  const [fileQuery, setFileQuery] = useState('')
  const [reloadedAt, setReloadedAt] = useState<number | null>(null)
  // The registry is ~2x codebase_graph.json (it embeds source), so it is
  // fetched lazily and only populates the external-import layer (tic-314c).
  // Null at startup: the app boots on codebase_graph.json alone.
  const [registry, setRegistry] = useState<SymbolRegistry | null>(null)
  // The absolute analysed root from the dev server (tic-4b0a), for the
  // inspector's vscode:// deep links; null in a static build without the
  // outData middleware, where the path stays plain text.
  const [absoluteRoot, setAbsoluteRoot] = useState<string | null>(null)
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

  const loadRoot = useCallback(async () => {
    setAbsoluteRoot(await loadAbsoluteRoot())
  }, [])

  useEffect(() => {
    void refresh(false)
    void loadRoot()
    return onDataChanged(() => {
      void refresh(true)
      void loadRoot()
    })
  }, [refresh, loadRoot])

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
    () =>
      graph
        ? deriveWorkspace(graph, effectiveExcludes, filterVisible ? fileQuery : '', registry)
        : null,
    [graph, effectiveExcludes, filterVisible, fileQuery, registry],
  )

  // The fs-tree folders Collapse All is allowed to fold up (tic-2356): only
  // directories whose children are all files, so the tree keeps its folder
  // skeleton instead of collapsing to the root.  Reused on every layout; the
  // empty set while there is no workspace.
  const fileOnlyDirs = useMemo(
    () => (workspace ? fileOnlyDirIds(workspace.tree) : EMPTY_DIR_IDS),
    [workspace],
  )

  // The active mode renders entirely through the VizMode interface: the app
  // never touches a mode's internals, only the ModeOutput that comes back.
  const modeId = useWorkspace((s) => s.modeId)
  const savedParams = useWorkspace((s) => activeMode(s).params)
  const expanded = useWorkspace(selectExpanded)
  const focusPath = useWorkspace((s) => activeMode(s).focusPath)
  const mode = modeById(modeId)
  const params = useMemo(
    () => ({ ...mode.defaultParams, ...savedParams }),
    [mode, savedParams],
  )
  // Zoom LOD as a selector: a number, so this re-renders only when a
  // threshold is crossed, never per pan/zoom frame (tic-fa56).
  const lod = useWorkspace((s) => lodOf(activeMode(s).viewport.scale))
  // A mode whose `layout` phase needs an async computation (tic-7e6d's
  // import-graph, via elk) can't return its real result synchronously; this
  // ticks whenever one lands in that mode's own cache, so the memo below
  // re-runs `layout()` a second time and picks it up (see ./modes/asyncLayout).
  const layoutVersion = useSyncExternalStore(subscribeLayoutReady, getLayoutVersion)
  const layout = useMemo(
    () => (workspace ? renderMode(mode, workspace, params, { expanded, lod, focusPath }) : null),
    [mode, params, workspace, expanded, lod, focusPath, layoutVersion],
  )
  const scene = layout?.scene ?? EMPTY_SCENE

  // The vscode:// source link per scene element (tic-468e): every element that
  // resolves to a symbol or file gets the same deep link the inspector shows,
  // so the canvas can offer a file-symlink button on each item.
  const sourceLinks = useMemo(
    () =>
      layout && workspace
        ? buildSourceLinks(layout.rects.keys(), layout.symbolOf, workspace.index, absoluteRoot)
        : new Map<string, string>(),
    [layout, workspace, absoluteRoot],
  )

  // Clicking a directory chip or a file chip/container toggles it; rows and
  // everything else just select (which the pointer-down handler already did).
  const onActivate = useCallback(
    (id: string) => {
      if (layout?.expandable.has(id)) useWorkspace.getState().toggleExpanded(id)
    },
    [layout],
  )

  // A goto target that is not in the current focus scope (tic-1d9a): resolve
  // the smallest scope that contains it so the canvas can pop out and travel.
  // Only the fs-tree can do that, and the allow-list is deliberate rather than
  // incidental: `minimalScopeForTarget` answers with a DIRECTORY, while the
  // import graph's focus path is a FILE (its Local View, tic-d7d7) and call
  // flow's is a SYMBOL ID (its rooted view, tic-7a5e).  Handing either one a
  // directory would pop the view into a scope that mode cannot render, and
  // both would then fall back to their unfocused state -- losing the focus the
  // user had, to travel to something they would not arrive at anyway.
  // Resolving nothing leaves an unreachable goto as the no-op the caller
  // already treats it as.  A new mode is opted OUT until it says otherwise,
  // which is the safe direction for a field whose meaning each mode defines.
  const resolveGotoScope = useCallback(
    (target: string): string | null =>
      workspace && modeId === fsTreeMode.id
        ? minimalScopeForTarget(workspace.tree, target)
        : null,
    [workspace, modeId],
  )

  // A preset's filters were captured as the effective list, so restoring them
  // means: use them verbatim, with the noise toggle folded in (on).
  const applyPresetFilters = useCallback((filters: string[]) => {
    setExcludes(filters)
    setNoiseFilter(true)
  }, [])

  const selection = useWorkspace((s) => s.selection)
  const inspectorCollapsed = useWorkspace((s) => s.inspectorCollapsed)
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

  // The first thing that actually wants import detail triggers the registry:
  // any expanded file container, or a selection feeding the inspector.
  // loadRegistry is memoised, so many triggers still mean one request.
  // Not gated on the mode any more (tic-ea9d): the import-graph containers
  // show the same external-import rows, and gating on fs-tree left them
  // permanently empty there.  Call flow is a trigger of its own (tic-171f):
  // its per-node coverage and dynamic-hole figures come from the registry's
  // unresolved_calls, and a mode about honesty that opens without its
  // honesty numbers would have to stay silent until the user happened to
  // click something.
  const wantsRegistry = useMemo(
    () =>
      selection.size > 0 ||
      Object.values(expanded).some(Boolean) ||
      modeId === CALL_FLOW_MODE_ID,
    [selection, expanded, modeId],
  )
  useEffect(() => {
    if (!wantsRegistry) return
    let cancelled = false
    loadRegistry()
      .then((reg) => {
        if (!cancelled) setRegistry(reg)
      })
      .catch(() => {
        // Best-effort detail: without the registry the canvas simply stays on
        // codebase_graph.json, exactly how it always started.
      })
    return () => {
      cancelled = true
    }
  }, [wantsRegistry])

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
        <Workspace
          scene={scene}
          output={layout}
          sourceLinks={sourceLinks}
          onActivate={onActivate}
          expandable={layout?.expandable}
          fileOnlyDirs={fileOnlyDirs}
          resolveGotoScope={resolveGotoScope}
        />
        {graph && modeId === CALL_FLOW_MODE_ID && (
          // The mode's always-visible honesty line (tic-171f): how much of
          // the export's call sites actually resolved, read live from the
          // export every time it is rewritten.  A call-flow view silently
          // dropping most of its edges would look authoritative while being
          // anything but; this is the antidote, worn where the mode is.
          <div
            className="coverage-hud"
            title={EDGE_LEGEND}
          >
            {formatCoverageHud(callFlowCoverage(graph.graph.stats, registry))}
            {/* The type-flow overlay's own honesty line (tic-59b1), shown only
                while it is on: that picture rests on annotations rather than
                on resolved calls, and covers less than half of either. */}
            {workspace !== null && (params as { showTypes?: boolean }).showTypes === true && (
              <span className="coverage-hud-type">
                {' · '}
                {formatTypeCoverageHud(deriveTypeFlow(workspace.index, registry))}
              </span>
            )}
          </div>
        )}
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
        <Inspector
          node={selectedNode}
          workspace={workspace}
          absoluteRoot={absoluteRoot}
          collapsed={inspectorCollapsed}
          onToggleCollapsed={() => useWorkspace.getState().setInspectorCollapsed(!inspectorCollapsed)}
        />
      </div>
    </div>
  )
}
