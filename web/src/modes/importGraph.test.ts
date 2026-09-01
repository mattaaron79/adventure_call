import { describe, expect, it } from 'vitest'
import { deriveWorkspace } from '../data/derive'
import type { CodebaseGraph, GraphEdge, GraphNode, SymbolKind } from '../data/types'
import { cacheKeyOf, importGraphMode, toElkGraphInput } from './importGraph'
import type { SceneSpec } from './types'

function node(id: string, kind: SymbolKind, file_path: string, module: string): GraphNode {
  return {
    id,
    symbol_id: id,
    name: id.split('.').pop()!,
    kind,
    file_path,
    module,
    parent: null,
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    end_line: 1,
    params: [],
    signature: '',
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

/**
 * Three files with a two-hop chain and one back-edge (b imports a and c;
 * c imports a again), so both an ordinary edge and a cycle-adjacent one are
 * exercised even though cycle highlighting itself is a later ticket.
 */
const NODES: GraphNode[] = [
  node('pkg.a', 'module', 'src/pkg/a.py', 'pkg.a'),
  node('pkg.a.Thing', 'class', 'src/pkg/a.py', 'pkg.a'),
  node('pkg.b', 'module', 'src/pkg/b.py', 'pkg.b'),
  node('pkg.c', 'module', 'src/pkg/c.py', 'pkg.c'),
]

const EDGES: GraphEdge[] = [
  imports('pkg.b', 'pkg.a.Thing', 2),
  imports('pkg.c', 'pkg.a.Thing'),
]

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
      symbols: 4,
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

describe('importGraphMode.select', () => {
  const spec = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, {
    expanded: {},
  })

  it('emits one file-role node per file, none expandable', () => {
    const ids = spec.root.children.map((n) => n.id).sort()
    expect(ids).toEqual(['src/pkg/a.py', 'src/pkg/b.py', 'src/pkg/c.py'])
    for (const n of spec.root.children) {
      expect(n.role).toBe('file')
      expect(n.expandable).toBe(false)
      expect(n.children).toEqual([])
    }
  })

  it('emits no directory or row nodes', () => {
    const roles = new Set(spec.root.children.map((n) => n.role))
    expect(roles).toEqual(new Set(['file']))
  })

  it('emits one directional import edge per FileImportEdge, importer -> imported', () => {
    expect(spec.edges).toHaveLength(2)
    const byId = new Map(spec.edges.map((e) => [e.id, e]))
    expect(byId.get('imp:src/pkg/b.py->src/pkg/a.py')).toMatchObject({
      from: 'src/pkg/b.py',
      to: 'src/pkg/a.py',
      kind: 'import',
      directional: true,
    })
    expect(byId.get('imp:src/pkg/c.py->src/pkg/a.py')).toMatchObject({
      from: 'src/pkg/c.py',
      to: 'src/pkg/a.py',
      kind: 'import',
      directional: true,
    })
  })

  it('emits no groups: no folder grouping in this mode', () => {
    expect(spec.groups).toEqual([])
  })

  it('resolves every file path to its own node id via the goto index', () => {
    expect(spec.goto?.get('src/pkg/a.py')).toBe('src/pkg/a.py')
    expect(spec.goto?.get('src/pkg/b.py')).toBe('src/pkg/b.py')
  })
})

describe('importGraphMode.measure', () => {
  const spec = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, { expanded: {} })
  const sizes = importGraphMode.measure(spec, { expanded: {} })

  it('sizes every file node, fixed height, width clamped to the label range', () => {
    for (const node of spec.root.children) {
      const size = sizes.get(node.id)
      expect(size).toBeDefined()
      expect(size!.height).toBe(40)
      expect(size!.width).toBeGreaterThanOrEqual(120)
      expect(size!.width).toBeLessThanOrEqual(260)
    }
  })
})

describe('importGraphMode.style', () => {
  const spec = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, { expanded: {} })
  const styles = importGraphMode.style(spec, importGraphMode.defaultParams)

  it('styles every file node and no groups', () => {
    expect(styles.nodes.size).toBe(3)
    expect(styles.groups.size).toBe(0)
  })

  it('styles every import edge with a muted opacity', () => {
    expect(styles.edges.size).toBe(2)
    for (const edgeStyle of styles.edges.values()) {
      expect(edgeStyle.opacity).toBe(0.45)
    }
  })
})

describe('cacheKeyOf', () => {
  it('is stable across two separately-built specs with the same content', () => {
    const a = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, { expanded: {} })
    const b = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, { expanded: {} })
    expect(a).not.toBe(b) // select() always returns a fresh object
    expect(cacheKeyOf(a)).toBe(cacheKeyOf(b))
  })

  it('differs when the edge set differs', () => {
    const full = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, { expanded: {} })
    const noEdges: SceneSpec = { ...full, edges: [] }
    expect(cacheKeyOf(full)).not.toBe(cacheKeyOf(noEdges))
  })

  it('differs when the node set differs', () => {
    const full = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, { expanded: {} })
    const fewerNodes: SceneSpec = {
      ...full,
      root: { ...full.root, children: full.root.children.slice(0, 1) },
    }
    expect(cacheKeyOf(full)).not.toBe(cacheKeyOf(fewerNodes))
  })
})

describe('toElkGraphInput', () => {
  const spec = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, { expanded: {} })
  const sizes = importGraphMode.measure(spec, { expanded: {} })
  const elkGraph = toElkGraphInput(spec, sizes)

  it('carries one elk node per file with its measured size', () => {
    expect(elkGraph.nodes).toHaveLength(3)
    for (const elkNode of elkGraph.nodes) {
      const size = sizes.get(elkNode.id)
      expect(elkNode.width).toBe(size!.width)
      expect(elkNode.height).toBe(size!.height)
    }
  })

  it('carries one elk edge per import edge, source/target from from/to', () => {
    expect(elkGraph.edges).toHaveLength(2)
    const bToA = elkGraph.edges.find((e) => e.id === 'imp:src/pkg/b.py->src/pkg/a.py')
    expect(bToA).toEqual({
      id: 'imp:src/pkg/b.py->src/pkg/a.py',
      source: 'src/pkg/b.py',
      target: 'src/pkg/a.py',
    })
  })
})

describe('importGraphMode.select with a query-scoped workspace', () => {
  // deriveWorkspace keeps every module node in its symbol index regardless of
  // the file query (only non-module symbols get query-filtered), so a whole-
  // module import can resolve to a file the query dropped from `tree`:
  // fileImports then names a file this mode never turns into a node. Elk
  // crashes ("Referenced shape does not exist") if an edge points at a node
  // id it was never given, so select() must drop such edges -- reproduced
  // here with a real query-scoped deriveWorkspace, the way it actually arises.
  const SCOPE_NODES: GraphNode[] = [
    node('pkg.p', 'module', 'src/pkg/p.py', 'pkg.p'),
    node('pkg.q', 'module', 'src/pkg/q.py', 'pkg.q'),
  ]
  const SCOPE_GRAPH: CodebaseGraph = {
    directed: true,
    multigraph: false,
    graph: {
      schema_version: 1,
      generated_at: '2026-08-30T00:00:00+00:00',
      root: '../fixture',
      stats: {
        files: 2,
        files_with_diagnostics: 0,
        symbols: 2,
        nodes: SCOPE_NODES.length,
        edges: 1,
        node_kinds: {},
        edge_types: {},
        calls_resolved: 0,
        calls_heuristic: 0,
        calls_unresolved: 0,
        calls_builtin: 0,
        diagnostics: 0,
      },
    },
    nodes: SCOPE_NODES,
    edges: [imports('pkg.p', 'pkg.q')],
  }
  // Matches only p.py: q.py -- the edge's target -- falls out of `modules`
  // and `tree`, but stays resolvable in the symbol index (the bug above).
  const scoped = deriveWorkspace(SCOPE_GRAPH, [], 'p.py')

  it('confirms the fixture reproduces the gap: fileImports names a file outside tree', () => {
    expect(scoped.tree.fileCount).toBe(1)
    expect(scoped.fileImports).toEqual([
      { source: 'src/pkg/p.py', target: 'src/pkg/q.py', count: 1, symbolIds: ['pkg.q'] },
    ])
  })

  it('drops the edge and renders only the visible file, without throwing', () => {
    const spec = importGraphMode.select(scoped, importGraphMode.defaultParams, { expanded: {} })
    expect(spec.root.children.map((n) => n.id)).toEqual(['src/pkg/p.py'])
    expect(spec.edges).toEqual([])
  })
})

describe('importGraphMode metadata', () => {
  it('is registered with a stable id and no configurable params', () => {
    expect(importGraphMode.id).toBe('import-graph')
    expect(importGraphMode.defaultParams).toEqual({})
  })
})

// -- cycle highlighting (tic-56b2) --------------------------------------------

/**
 * entry -> x -> y -> x: a genuine two-file cycle (x/y) fed from outside by a
 * third file that is not itself part of it.
 */
const CYCLE_NODES: GraphNode[] = [
  node('pkg.entry', 'module', 'src/pkg/entry.py', 'pkg.entry'),
  node('pkg.entry.Start', 'class', 'src/pkg/entry.py', 'pkg.entry'),
  node('pkg.x', 'module', 'src/pkg/x.py', 'pkg.x'),
  node('pkg.x.X', 'class', 'src/pkg/x.py', 'pkg.x'),
  node('pkg.y', 'module', 'src/pkg/y.py', 'pkg.y'),
  node('pkg.y.Y', 'class', 'src/pkg/y.py', 'pkg.y'),
]

const CYCLE_EDGES: GraphEdge[] = [
  imports('pkg.entry', 'pkg.x.X'),
  imports('pkg.x', 'pkg.y.Y'),
  imports('pkg.y', 'pkg.x.X'),
]

const CYCLE_GRAPH: CodebaseGraph = {
  directed: true,
  multigraph: false,
  graph: {
    schema_version: 1,
    generated_at: '2026-08-30T00:00:00+00:00',
    root: '../fixture',
    stats: {
      files: 3,
      files_with_diagnostics: 0,
      symbols: 6,
      nodes: CYCLE_NODES.length,
      edges: CYCLE_EDGES.length,
      node_kinds: {},
      edge_types: {},
      calls_resolved: 0,
      calls_heuristic: 0,
      calls_unresolved: 0,
      calls_builtin: 0,
      diagnostics: 0,
    },
  },
  nodes: CYCLE_NODES,
  edges: CYCLE_EDGES,
}

const CYCLE_WORKSPACE = deriveWorkspace(CYCLE_GRAPH, [])

describe('importGraphMode cycle highlighting', () => {
  const spec = importGraphMode.select(CYCLE_WORKSPACE, importGraphMode.defaultParams, {
    expanded: {},
  })
  const styles = importGraphMode.style(spec, importGraphMode.defaultParams)

  it('flags the two cycle members but not the feeder file', () => {
    const byId = new Map(spec.root.children.map((n) => [n.id, n]))
    expect((byId.get('src/pkg/x.py')!.data as { inCycle: boolean }).inCycle).toBe(true)
    expect((byId.get('src/pkg/y.py')!.data as { inCycle: boolean }).inCycle).toBe(true)
    expect((byId.get('src/pkg/entry.py')!.data as { inCycle: boolean }).inCycle).toBe(false)
  })

  it('flags the two cycle edges but not the feeder edge', () => {
    const byId = new Map(spec.edges.map((e) => [e.id, e]))
    expect((byId.get('imp:src/pkg/x.py->src/pkg/y.py')!.data as { inCycle: boolean }).inCycle).toBe(
      true,
    )
    expect((byId.get('imp:src/pkg/y.py->src/pkg/x.py')!.data as { inCycle: boolean }).inCycle).toBe(
      true,
    )
    expect(
      (byId.get('imp:src/pkg/entry.py->src/pkg/x.py')!.data as { inCycle: boolean }).inCycle,
    ).toBe(false)
  })

  it('styles cycle nodes distinctly from ordinary ones', () => {
    const cycleStyle = styles.nodes.get('src/pkg/x.py')!
    const plainStyle = styles.nodes.get('src/pkg/entry.py')!
    expect(cycleStyle.stroke).not.toBe(plainStyle.stroke)
    expect(cycleStyle.stroke).toBe(styles.nodes.get('src/pkg/y.py')!.stroke)
  })

  it('styles cycle edges distinctly (bolder, less transparent) from ordinary ones', () => {
    const cycleEdgeStyle = styles.edges.get('imp:src/pkg/x.py->src/pkg/y.py')!
    const plainEdgeStyle = styles.edges.get('imp:src/pkg/entry.py->src/pkg/x.py')!
    expect(cycleEdgeStyle.stroke).not.toBe(plainEdgeStyle.stroke)
    expect(cycleEdgeStyle.opacity).toBeGreaterThan(plainEdgeStyle.opacity!)
  })

  it('keeps every import edge on kind "import" regardless of cycle membership', () => {
    // So cross-mode machinery keyed on kind (selection highlighting, marching
    // ants) still treats every import edge, cyclic or not, as an import.
    for (const edge of spec.edges) expect(edge.kind).toBe('import')
  })
})
