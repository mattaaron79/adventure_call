import { describe, expect, it } from 'vitest'
import { THEME } from '../canvas/theme'
import { deriveWorkspace, type FsDir } from '../data/derive'
import type {
  BindingRecord,
  CodebaseGraph,
  GraphEdge,
  GraphNode,
  ImportRecord,
  SymbolKind,
  SymbolRegistry,
} from '../data/types'
import { fileRows, fsTreeMode, layoutContainer } from './fsTree'
import { renderMode, resolveGoto } from './types'

/**
 * Render the mode the way the app does: only through the VizMode interface.
 * `focusPath` (tic-e7d2) is the directory the scene is drilled into; the
 * empty string is the whole graph.
 */
const render = (
  expanded: Record<string, boolean> = {},
  params = { ...fsTreeMode.defaultParams },
  lod = 0,
  workspace = WORKSPACE,
  focusPath = '',
) => renderMode(fsTreeMode, workspace, params, { expanded, lod, focusPath })

/**
 * A miniature corpus with everything the mode has to render: a nested
 * directory, a file with a class (two methods and an attribute), a top-level
 * function and a module constant, a second file it imports from, and a
 * subdirectory that can be collapsed.
 */
function node(
  id: string,
  kind: SymbolKind,
  file_path: string,
  module: string,
  parent: string | null = null,
  signature = '',
): GraphNode {
  return {
    id,
    symbol_id: id,
    name: id.split('.').pop()!,
    kind,
    file_path,
    module,
    parent,
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    end_line: 1,
    params: [],
    signature,
    docstring: null,
    decorators: [],
    bases: [],
    is_async: false,
    stub: '',
  }
}

function imports(source: string, target: string, count = 1): GraphEdge {
  return {
    source,
    target,
    type: 'IMPORTS',
    types: ['IMPORTS'],
    count,
    lines: [1],
    confidence: 'exact',
    call_types: [],
    aliases: [],
  }
}

const NODES: GraphNode[] = [
  node('app.loop', 'module', 'src/app/loop.py', 'app.loop'),
  node('app.loop.Agent', 'class', 'src/app/loop.py', 'app.loop', null, 'class Agent:'),
  node('app.loop.Agent.step', 'method', 'src/app/loop.py', 'app.loop', 'app.loop.Agent', 'def step(self):'),
  node('app.loop.Agent.name', 'attribute', 'src/app/loop.py', 'app.loop', 'app.loop.Agent'),
  node('app.loop.run', 'function', 'src/app/loop.py', 'app.loop', null, 'def run():'),
  node('app.loop.LIMIT', 'variable', 'src/app/loop.py', 'app.loop'),

  node('app.errors', 'module', 'src/app/errors.py', 'app.errors'),
  node('app.errors.PluginError', 'class', 'src/app/errors.py', 'app.errors'),

  node('app.cli', 'module', 'src/app/cli/main.py', 'app.cli'),
]

const EDGES: GraphEdge[] = [imports('app.loop', 'app.errors.PluginError', 2)]

const GRAPH: CodebaseGraph = {
  directed: true,
  multigraph: false,
  graph: {
    schema_version: 1,
    generated_at: '2026-08-30T00:00:00+00:00',
    root: '../fixture',
    stats: {
      files: 3,
      files_with_diagnostics: 0,
      symbols: 7,
      nodes: NODES.length,
      edges: EDGES.length,
      node_kinds: {},
      edge_types: {},
      calls_resolved: 0,
      calls_heuristic: 0,
      calls_unresolved: 0,
      calls_builtin: 0,
      diagnostics: 0,
    },
  },
  nodes: NODES,
  edges: EDGES,
}

const WORKSPACE = deriveWorkspace(GRAPH, [])

// -- external imports (tic-314c) --------------------------------------------

function importRecord(
  module: string,
  alias: string,
  target_module: string,
  target_symbol: string | null,
): ImportRecord {
  const target = target_symbol
    ? target_module
      ? `${target_module}.${target_symbol}`
      : target_symbol
    : target_module
  return {
    module,
    alias,
    target_module,
    target_symbol,
    is_relative: false,
    level: 1,
    is_wildcard: false,
    line: 1,
    target,
  }
}

function binding(alias: string, kind: string, target: string): BindingRecord {
  return { alias, kind, target, line: 1, statement_module: '', is_relative: false }
}

function makeRegistry(
  imports: ImportRecord[],
  bindings: Record<string, BindingRecord>,
): SymbolRegistry {
  return {
    schema_version: 1,
    generated_at: '2026-08-30T00:00:00+00:00',
    root: '../fixture',
    includes_source: false,
    stats: GRAPH.graph.stats,
    symbols: {},
    modules: {
      'app.loop': {
        file_path: 'src/app/loop.py',
        language: 'python',
        docstring: null,
        symbol_ids: [],
        imports,
      },
    },
    bindings: { 'app.loop': bindings },
    unresolved_calls: [],
    diagnostics: [],
  }
}

// loop.py imports collections.abc and typing (external, typing twice so the
// grouping is exercised) plus app.errors.PluginError (an internal symbol that
// must not be surfaced as external).
const EXTERNAL_REGISTRY = makeRegistry(
  [
    importRecord('app.loop', 'collections', 'collections.abc', null),
    importRecord('app.loop', 'typing', 'typing', null),
    importRecord('app.loop', 'typing', 'typing', null),
    importRecord('app.loop', 'PluginError', 'app.errors', 'PluginError'),
  ],
  {
    collections: binding('collections', 'external', 'collections.abc'),
    typing: binding('typing', 'external', 'typing'),
    PluginError: binding('PluginError', 'symbol', 'app.errors.PluginError'),
  },
)

const EXTERNAL_WORKSPACE = deriveWorkspace(GRAPH, [], '', EXTERNAL_REGISTRY)

function dir(root: FsDir, path: string): FsDir {
  if (path === '') return root
  for (const segment of path.split('/')) {
    const next = root.children.find((c) => c.type === 'dir' && c.name === segment)
    if (!next || next.type !== 'dir') throw new Error(`no directory ${path}`)
    root = next
  }
  return root
}

describe('fsTreeMode, everything collapsed', () => {
  const layout = render()
  const { scene, rects, expandable } = layout

  it('emits one chip per directory and per file, no rows', () => {
    const ids = scene.nodes.map((n) => n.id)
    expect(ids).toContain('dir:')
    expect(ids).toContain('dir:src')
    expect(ids).toContain('dir:src/app')
    expect(ids).toContain('dir:src/app/cli')
    expect(ids).toContain('src/app/loop.py')
    expect(ids).toContain('src/app/errors.py')
    expect(ids).toContain('src/app/cli/main.py')
    expect(scene.nodes.every((n) => !n.id.startsWith('row:'))).toBe(true)
  })

  it('writes a rect for every chip and group box, and marks dirs and files expandable', () => {
    // The positioned output covers nodes plus the group boxes behind them.
    expect(rects.size).toBe(scene.nodes.length + scene.groups.length)
    for (const node of scene.nodes) expect(rects.has(node.id)).toBe(true)
    expect(expandable.has('dir:src/app')).toBe(true)
    expect(expandable.has('src/app/loop.py')).toBe(true)
  })

  it('backs each expanded directory with a group box and elbow nesting lines', () => {
    expect(scene.groups.map((g) => g.label)).toContain('src/app')
    const nesting = scene.edges.filter((e) => !e.id.startsWith('imp:'))
    expect(nesting.length).toBeGreaterThanOrEqual(5) // root->src, src->app, app->2 files, app->cli
    // Elbows leave the parent's right edge and enter the child's left edge.
    const first = nesting[0]
    expect(first.points.length).toBeGreaterThanOrEqual(4)
  })

  it('draws import lines between the collapsed file chips', () => {
    const imp = scene.edges.find((e) => e.id === 'imp:src/app/loop.py->src/app/errors.py')
    expect(imp).toBeDefined()
    const from = rects.get('src/app/loop.py')!
    const to = rects.get('src/app/errors.py')!
    expect(imp!.points).toEqual([
      from.x + from.width / 2,
      from.y + from.height / 2,
      to.x + to.width / 2,
      to.y + to.height / 2,
    ])
  })

  it('labels import edges with the import kind and nesting edges with nesting (tic-5393)', () => {
    // The canvas needs a stable discriminator so selection highlighting does
    // not mistake an elbow (nesting) for a centre line (import).
    expect(scene.edges.find((e) => e.id.startsWith('imp:'))!.kind).toBe('import')
    expect(scene.edges.find((e) => !e.id.startsWith('imp:'))!.kind).toBe('nesting')
  })

  it('is deterministic', () => {
    expect(render()).toEqual(layout)
  })
})

describe('fsTreeMode, with an expanded file', () => {
  const layout = render({ 'src/app/loop.py': true })
  const { scene, rects, symbolOf } = layout

  it('renders the container plus header, sections and rows', () => {
    const ids = scene.nodes.map((n) => n.id)
    expect(ids).toContain('src/app/loop.py') // the container itself
    expect(ids).toContain('row:src/app/loop.py:section:Imports')
    expect(ids).toContain('row:src/app/loop.py:section:Classes')
    expect(ids).toContain('row:src/app/loop.py:section:Functions')
    expect(ids).toContain('row:src/app/loop.py:section:Variables')
    expect(ids).toContain('row:src/app/loop.py:app.loop.Agent')
    expect(ids).toContain('row:src/app/loop.py:app.loop.Agent.step')
    expect(ids).toContain('row:src/app/loop.py:app.loop.Agent.name')
    expect(ids).toContain('row:src/app/loop.py:app.loop.run')
    expect(ids).toContain('row:src/app/loop.py:app.loop.LIMIT')
    expect(ids).toContain('row:src/app/loop.py:imp:app.errors.PluginError')
  })

  it('carries a symbol id on every row and a rect for every row', () => {
    expect(symbolOf.get('row:src/app/loop.py:app.loop.Agent.step')).toBe('app.loop.Agent.step')
    expect(symbolOf.has('row:src/app/loop.py:section:Classes')).toBe(false)
    for (const [id] of symbolOf) expect(rects.has(id)).toBe(true)
  })

  it('keeps every row inside its container', () => {
    const container = rects.get('src/app/loop.py')!
    for (const [id, rect] of rects) {
      if (!id.startsWith('row:src/app/loop.py:')) continue
      expect(rect.x).toBeGreaterThanOrEqual(container.x)
      expect(rect.y).toBeGreaterThanOrEqual(container.y)
      expect(rect.x + rect.width).toBeLessThanOrEqual(container.x + container.width + 0.001)
      expect(rect.y + rect.height).toBeLessThanOrEqual(container.y + container.height + 0.001)
    }
  })

  it('anchors the import line to the imported symbol row in the expanded source', () => {
    const imp = scene.edges.find((e) => e.id === 'imp:src/app/loop.py->src/app/errors.py')!
    const row = rects.get('row:src/app/loop.py:imp:app.errors.PluginError')!
    expect(imp.points[0]).toBe(row.x + row.width / 2)
    expect(imp.points[1]).toBe(row.y + row.height / 2)
    // The target file is still collapsed, so the far end is its chip.
    const chip = rects.get('src/app/errors.py')!
    expect(imp.points[2]).toBe(chip.x + chip.width / 2)
  })

  it('pins container rows in place (not draggable, not marquee fodder)', () => {
    const container = scene.nodes.find((n) => n.id === 'src/app/loop.py')!
    expect(container.draggable).toBe(false)
    for (const n of scene.nodes) {
      if (n.id.startsWith('row:')) expect(n.draggable).toBe(false)
    }
  })
})

describe('fsTreeMode, with a collapsed directory', () => {
  it('hides the subtree and its import lines', () => {
    const layout = render({ 'dir:src/app': false })
    const ids = layout.scene.nodes.map((n) => n.id)
    expect(ids).toContain('dir:src/app')
    expect(ids).not.toContain('src/app/loop.py')
    expect(ids).not.toContain('dir:src/app/cli')
    expect(layout.scene.edges.filter((e) => e.id.startsWith('imp:'))).toEqual([])
  })
})

describe('fsTreeMode params', () => {
  it('drops the import lines when showImports is off', () => {
    const layout = render({}, { showImports: false })
    expect(layout.scene.edges.filter((e) => e.id.startsWith('imp:'))).toEqual([])
    // Everything else is untouched.
    expect(layout.scene.nodes.map((n) => n.id)).toContain('src/app/loop.py')
  })
})

describe('fsTreeMode LOD (tic-fa56)', () => {
  it('collapses expanded containers to summary chips at extreme zoom-out', () => {
    const layout = render({ 'src/app/loop.py': true }, undefined, 3)
    const container = layout.scene.nodes.find((n) => n.id === 'src/app/loop.py')!
    expect(container.sublabel).toMatch(/symbol/)
    expect(layout.scene.nodes.every((n) => !n.id.startsWith('row:'))).toBe(true)
  })

  it('keeps containers open just above the extreme threshold', () => {
    const layout = render({ 'src/app/loop.py': true }, undefined, 2)
    expect(layout.scene.nodes.some((n) => n.id.startsWith('row:'))).toBe(true)
  })

  it('drops import lines once labels are gone (lod >= 2)', () => {
    expect(render({}, undefined, 2).scene.edges.some((e) => e.id.startsWith('imp:'))).toBe(false)
    expect(render({}, undefined, 1).scene.edges.some((e) => e.id.startsWith('imp:'))).toBe(true)
  })
})

describe('fileRows and layoutContainer', () => {
  it('orders sections Imports, Classes (children nested), Functions, Variables', () => {
    const file = dir(WORKSPACE.tree, 'src/app').children.find(
      (c) => c.type === 'file' && c.path === 'src/app/loop.py',
    )
    if (!file || file.type !== 'file') throw new Error('loop.py missing')
    const rows = fileRows(WORKSPACE, file)
    // The first class row is the imported PluginError (imports carry the
    // target symbol's kind); the second is Agent with its children nested.
    expect(rows.map((r) => r.kind)).toEqual([
      'section',
      'class',
      'section',
      'class',
      'method',
      'attribute',
      'section',
      'function',
      'section',
      'variable',
    ])
    expect(rows[4].indent).toBe(true) // the method nests under its class
    expect(rows[5].indent).toBe(true) // the attribute too
    expect(rows[6].indent).toBe(false)
  })

  it('sizes the container to fit its rows', () => {
    const layout = layoutContainer([
      { id: 's', symbolId: null, label: 'Classes', kind: 'section', indent: false },
      { id: 'a', symbolId: 'a', label: 'x'.repeat(80), kind: 'function', indent: false },
    ])
    expect(layout.width).toBeGreaterThan(300)
    expect(layout.height).toBeGreaterThan(36 + 12 + 2 * 24)
    expect(layout.rows[0].y).toBeLessThan(layout.rows[1].y)
  })
})

describe('fsTreeMode focus scope (tic-e7d2)', () => {
  it('scopes the scene to the focused directory, everything outside absent', () => {
    const layout = render({}, undefined, 0, WORKSPACE, 'src/app')
    const ids = layout.scene.nodes.map((n) => n.id)
    expect(ids).toContain('dir:src/app') // the focused dir is now the tree root
    expect(ids).toContain('src/app/loop.py')
    expect(ids).toContain('src/app/errors.py')
    expect(ids).toContain('dir:src/app/cli')
    expect(ids).toContain('src/app/cli/main.py')
    // Outside the scope is absent, not dimmed: the parent and the root are
    // simply not in the scene.
    expect(ids).not.toContain('dir:src')
    expect(ids).not.toContain('dir:')
  })

  it('keeps import lines that are internal to the scope and drops the rest', () => {
    const scoped = render({}, undefined, 0, WORKSPACE, 'src/app')
    // loop.py imports errors.py; both are inside the scope, so the edge stays.
    expect(scoped.scene.edges.some((e) => e.id === 'imp:src/app/loop.py->src/app/errors.py')).toBe(
      true,
    )

    const deep = render({}, undefined, 0, WORKSPACE, 'src/app/cli')
    // main.py imports nothing and loop.py's import is outside the scope, so
    // no import lines at all.
    expect(deep.scene.edges.filter((e) => e.id.startsWith('imp:'))).toEqual([])
  })

  it('makes the focused directory the laid-out root and carries its path as focusTo', () => {
    const scoped = render({}, undefined, 0, WORKSPACE, 'src/app')
    const root = scoped.scene.nodes.find((n) => n.id === 'dir:src/app')!
    expect(root.focusTo).toBe('src/app')
    // Every directory chip advertises its own drill-in target.
    const atRoot = render()
    expect(atRoot.scene.nodes.find((n) => n.id === 'dir:')!.focusTo).toBe('')
    expect(atRoot.scene.nodes.find((n) => n.id === 'dir:src/app')!.focusTo).toBe('src/app')
  })

  it('falls back to the whole graph when the focus path no longer exists', () => {
    const layout = render({}, undefined, 0, WORKSPACE, 'src/gone')
    const ids = layout.scene.nodes.map((n) => n.id)
    expect(ids).toContain('dir:src')
    expect(ids).toContain('src/app/loop.py')
  })

  it('still honours expand state inside the scope', () => {
    const scoped = render({ 'src/app/loop.py': true }, undefined, 0, WORKSPACE, 'src/app')
    const ids = scoped.scene.nodes.map((n) => n.id)
    expect(ids).toContain('row:src/app/loop.py:section:Classes')
    expect(ids).not.toContain('dir:src')
  })

  it('resolves goto targets inside the scope and nothing outside it', () => {
    const scoped = render({}, undefined, 0, WORKSPACE, 'src/app')
    const file = resolveGoto(scoped, 'src/app/loop.py')
    expect(file!.elementId).toBe('src/app/loop.py')
    expect(resolveGoto(scoped, 'src/app/cli/main.py')!.elementId).toBe('src/app/cli/main.py')
    // A path outside the scope is absent from the scene and resolves to null.
    expect(resolveGoto(scoped, 'src/not/here.py')).toBeNull()
  })
})

describe('fsTreeMode goto index (tic-bee0)', () => {
  it('resolves a visible file and a visible directory to their chips', () => {
    const layout = render()
    const file = resolveGoto(layout, 'src/app/loop.py')
    expect(file).toEqual({ elementId: 'src/app/loop.py', rect: layout.rects.get('src/app/loop.py') })
    const dir = resolveGoto(layout, 'src/app')
    expect(dir!.elementId).toBe('dir:src/app')
    expect(dir!.rect).toBe(layout.rects.get('dir:src/app'))
  })

  it('resolves a file inside a collapsed directory to the nearest visible chip', () => {
    const layout = render({ 'dir:src/app': false })
    // The file is gone from the scene, but goto still lands on its closed dir.
    expect(layout.scene.nodes.map((n) => n.id)).not.toContain('src/app/loop.py')
    const target = resolveGoto(layout, 'src/app/loop.py')
    expect(target!.elementId).toBe('dir:src/app')
    expect(target!.rect).toBe(layout.rects.get('dir:src/app'))
  })

  it('resolves a deep file under a collapsed parent to the nearest open chip', () => {
    const layout = render({ 'dir:src': false })
    const target = resolveGoto(layout, 'src/app/cli/main.py')
    expect(target!.elementId).toBe('dir:src')
    expect(target!.rect).toBe(layout.rects.get('dir:src'))
  })

  it('resolves nothing for a target absent from the workspace', () => {
    expect(resolveGoto(render(), 'does/not/exist.py')).toBeNull()
  })
})

describe('fsTreeMode, external imports (tic-314c)', () => {
  it('lists external imports in the Imports section, grouped and linkless', () => {
    const layout = render({ 'src/app/loop.py': true }, undefined, 0, EXTERNAL_WORKSPACE)
    const ids = layout.scene.nodes.map((n) => n.id)
    expect(ids).toContain('row:src/app/loop.py:section:Imports')
    expect(ids).toContain('row:src/app/loop.py:imp:app.errors.PluginError')
    expect(ids).toContain('row:src/app/loop.py:ext:collections.abc')
    expect(ids).toContain('row:src/app/loop.py:ext:typing')
    // External rows carry no symbol: they link to nothing by design.
    expect(layout.symbolOf.has('row:src/app/loop.py:ext:collections.abc')).toBe(false)
    expect(layout.symbolOf.has('row:src/app/loop.py:ext:typing')).toBe(false)
    // Internal imports keep their symbol mapping.
    expect(layout.symbolOf.get('row:src/app/loop.py:imp:app.errors.PluginError')).toBe(
      'app.errors.PluginError',
    )
  })

  it('groups repeated targets into one row with a count', () => {
    const layout = render({ 'src/app/loop.py': true }, undefined, 0, EXTERNAL_WORKSPACE)
    const external = layout.scene.nodes.filter((n) => n.id.startsWith('row:src/app/loop.py:ext:'))
    expect(external.map((n) => n.label)).toEqual(['collections.abc', 'typing ×2'])
  })

  it('mutes external rows against the resolved ones', () => {
    const layout = render({ 'src/app/loop.py': true }, undefined, 0, EXTERNAL_WORKSPACE)
    const external = layout.scene.nodes.find((n) => n.id === 'row:src/app/loop.py:ext:typing')!
    expect(external.stroke).toBe(THEME.textFaint)
    expect(external.accent).toBe(THEME.textFaint)
    const internal = layout.scene.nodes.find(
      (n) => n.id === 'row:src/app/loop.py:imp:app.errors.PluginError',
    )!
    expect(internal.stroke).toBe(THEME.line)
  })

  it('starts on codebase_graph.json alone: no registry, no external rows', () => {
    const layout = render({ 'src/app/loop.py': true })
    expect(layout.scene.nodes.map((n) => n.id)).not.toContain('row:src/app/loop.py:ext:typing')
  })
})
