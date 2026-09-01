import { describe, expect, it } from 'vitest'
import { deriveWorkspace } from '../data/derive'
import type { CodebaseGraph, GraphEdge, GraphNode, SymbolKind } from '../data/types'
import {
  cacheKeyOf,
  finalisePositioned,
  flattenJunctions,
  importGraphMode,
  localViewCentre,
  neighbourhoodOf,
  toElkGraphInput,
} from './importGraph'
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

  it('emits one file-role node per file, expandable but collapsed', () => {
    const ids = spec.root.children.map((n) => n.id).sort()
    expect(ids).toEqual(['src/pkg/a.py', 'src/pkg/b.py', 'src/pkg/c.py'])
    for (const n of spec.root.children) {
      expect(n.role).toBe('file')
      // Every file offers the double-click expansion (tic-ea9d), but nothing
      // is open until the expand state says so.
      expect(n.expandable).toBe(true)
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
      expect(size!.width).toBeGreaterThanOrEqual(150)
      expect(size!.width).toBeLessThanOrEqual(340)
    }
  })

  it('leaves room for the name AND the icons the chip carries (tic-ea7b)', () => {
    // The canvas reserves 64 units at the right edge for the source link and
    // the Local View button, and draws the label from x=12.  A chip measured
    // for its name alone had the buttons sitting on the end of that name.
    const longest = spec.root.children.reduce((a, b) =>
      a.label.length >= b.label.length ? a : b,
    )
    const width = sizes.get(longest.id)!.width
    expect(width - 64 - 12).toBeGreaterThanOrEqual(longest.label.length * 6.4)
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
  const specOf = () =>
    importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, { expanded: {} })
  const sizesOf = (spec: SceneSpec) => importGraphMode.measure(spec, { expanded: {} })
  const DEFAULTS = importGraphMode.defaultParams

  it('is stable across two separately-built specs with the same content', () => {
    const a = specOf()
    const b = specOf()
    expect(a).not.toBe(b) // select() always returns a fresh object
    expect(cacheKeyOf(a, sizesOf(a), DEFAULTS)).toBe(cacheKeyOf(b, sizesOf(b), DEFAULTS))
  })

  it('differs when the edge set differs', () => {
    const full = specOf()
    const noEdges: SceneSpec = { ...full, edges: [] }
    expect(cacheKeyOf(full, sizesOf(full), DEFAULTS)).not.toBe(
      cacheKeyOf(noEdges, sizesOf(noEdges), DEFAULTS),
    )
  })

  it('differs when the node set differs', () => {
    const full = specOf()
    const fewerNodes: SceneSpec = {
      ...full,
      root: { ...full.root, children: full.root.children.slice(0, 1) },
    }
    expect(cacheKeyOf(full, sizesOf(full), DEFAULTS)).not.toBe(
      cacheKeyOf(fewerNodes, sizesOf(fewerNodes), DEFAULTS),
    )
  })

  // The crux of tic-531b: toggling mergeLines changes no node id and no edge
  // id, so a key built from ids alone would hit the stale single-slot cache
  // and the checkbox would silently do nothing, in either direction.
  it('differs when the params differ, even though every id is identical', () => {
    const spec = specOf()
    const sizes = sizesOf(spec)
    const unmerged = cacheKeyOf(spec, sizes, { mergeLines: false })
    const merged = cacheKeyOf(spec, sizes, { mergeLines: true })
    expect(merged).not.toBe(unmerged)
    // ...and toggling back returns to exactly the first key, so the cached
    // unmerged layout is reused rather than recomputed.
    expect(cacheKeyOf(spec, sizes, { mergeLines: false })).toBe(unmerged)
  })

  // The same trap waits for anything that resizes a chip without renaming it
  // (an expanded container, say), which is why the measured sizes are in the
  // key ahead of the feature that needs them.
  it('differs when a measured size differs, even though every id is identical', () => {
    const spec = specOf()
    const sizes = sizesOf(spec)
    const first = spec.root.children[0].id
    const grown = new Map(sizes)
    grown.set(first, { width: sizes.get(first)!.width + 40, height: 40 })
    expect(cacheKeyOf(spec, grown, DEFAULTS)).not.toBe(cacheKeyOf(spec, sizes, DEFAULTS))
  })
})

describe('flattenJunctions', () => {
  it('flattens every edge list into one world-space point array', () => {
    const flat = flattenJunctions(
      new Map([
        ['a->c', [{ x: 10, y: 20 }]],
        ['b->c', [{ x: 30, y: 40 }]],
      ]),
    )
    expect(flat).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ])
  })

  it('de-duplicates a coordinate claimed by more than one edge', () => {
    // Insurance, not a fix for observed behaviour: elk was measured to
    // attribute each junction to a single edge, but nothing promises that,
    // and stacked identical circles cost Konva nodes for no visual gain.
    const flat = flattenJunctions(
      new Map([
        ['a->d', [{ x: 10, y: 20 }]],
        ['b->d', [{ x: 10, y: 20 }]],
        ['c->d', [{ x: 10.4, y: 19.6 }]],
      ]),
    )
    expect(flat).toEqual([{ x: 10, y: 20 }])
  })

  it('is empty for a layout that merged nothing', () => {
    expect(flattenJunctions(new Map())).toEqual([])
  })
})

describe('mode params', () => {
  it('defaults to unmerged import lines', () => {
    expect(importGraphMode.defaultParams).toEqual({ mergeLines: false })
  })

  it('declares mergeLines as a toggle so ModePicker renders it generically', () => {
    expect(importGraphMode.paramToggles).toEqual([
      { key: 'mergeLines', label: 'Merge import lines' },
    ])
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
  it('is registered with a stable id', () => {
    expect(importGraphMode.id).toBe('import-graph')
  })
  // The params themselves are covered by the 'mode params' block above; this
  // stopped asserting an empty defaultParams when tic-531b added mergeLines.
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

// -- expansion (tic-ea9d) -----------------------------------------------------

/** `src/pkg/a.py` open: it is imported by both other files, so it exercises
 *  the "Imported By" section and the target-side anchoring at once. */
const A_OPEN = { expanded: { 'src/pkg/a.py': true } }
/** `src/pkg/b.py` open: it imports a, so it exercises the source side. */
const B_OPEN = { expanded: { 'src/pkg/b.py': true } }

describe('importGraphMode.select with an expanded file', () => {
  const spec = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, A_OPEN)
  const container = spec.root.children.find((n) => n.id === 'src/pkg/a.py')!
  const sections = container.children.filter((n) => n.role === 'section').map((n) => n.label)

  it('expands only the file the expand state names', () => {
    expect(container.children.length).toBeGreaterThan(0)
    for (const other of spec.root.children) {
      if (other.id !== 'src/pkg/a.py') expect(other.children).toEqual([])
    }
  })

  it('puts Imported By above the other sections', () => {
    expect(sections[0]).toBe('Imported By')
    // a.py imports nothing, so Imports is absent here; Classes still follows.
    expect(sections).toContain('Classes')
  })

  it('emits one Imported By row per importing file, each with a goto target', () => {
    const rows = container.children.filter((n) => n.id.includes(':impby:'))
    expect(rows.map((n) => n.gotoTo).sort()).toEqual(['src/pkg/b.py', 'src/pkg/c.py'])
  })

  it('gives the open container a sublabel, so the canvas puts its name in the header', () => {
    // Workspace centres a label vertically unless the node has a sublabel;
    // without one, a tall container renders its file name across its rows.
    expect(container.sublabel).toBe('1 symbol')
    const collapsed = spec.root.children.find((n) => n.id === 'src/pkg/b.py')!
    expect(collapsed.sublabel).toBeUndefined()
  })

  it('carries the symbol id on member rows so source links and the inspector resolve', () => {
    const member = container.children.find((n) => n.label === 'Thing')
    expect(member?.symbolId).toBe('pkg.a.Thing')
  })

  it('anchors the imported end of a line onto that file Imported By row', () => {
    const edge = spec.edges.find((e) => e.id === 'imp:src/pkg/b.py->src/pkg/a.py')!
    expect(edge.to).toBe('row:src/pkg/a.py:impby:src/pkg/b.py')
    // The importer is still collapsed, so its end stays on the chip.
    expect(edge.from).toBe('src/pkg/b.py')
  })

  it('keeps the file-level ends on the edge payload for elk to route with', () => {
    const elk = toElkGraphInput(spec, importGraphMode.measure(spec, A_OPEN))
    const elkEdge = elk.edges.find((e) => e.id === 'imp:src/pkg/b.py->src/pkg/a.py')!
    expect(elkEdge.source).toBe('src/pkg/b.py')
    expect(elkEdge.target).toBe('src/pkg/a.py')
    // Every elk endpoint must name a declared elk node, never a row.
    const declared = new Set(elk.nodes.map((n) => n.id))
    for (const e of elk.edges) {
      expect(declared.has(e.source)).toBe(true)
      expect(declared.has(e.target)).toBe(true)
    }
  })

  it('anchors the importing end onto that file Imports row', () => {
    const bSpec = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, B_OPEN)
    const edge = bSpec.edges.find((e) => e.id === 'imp:src/pkg/b.py->src/pkg/a.py')!
    expect(edge.from).toBe('row:src/pkg/b.py:imp:pkg.a.Thing')
    expect(edge.to).toBe('src/pkg/a.py')
  })

  it('leaves both ends on the files when the lines are merged', () => {
    const merged = importGraphMode.select(WORKSPACE, { mergeLines: true }, A_OPEN)
    const edge = merged.edges.find((e) => e.id === 'imp:src/pkg/b.py->src/pkg/a.py')!
    expect(edge.from).toBe('src/pkg/b.py')
    expect(edge.to).toBe('src/pkg/a.py')
    // The container itself still expands; only the anchoring opts out.
    const box = merged.root.children.find((n) => n.id === 'src/pkg/a.py')!
    expect(box.children.length).toBeGreaterThan(0)
  })

  it('collapses the container back to a chip at the furthest zoom-out', () => {
    const far = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, {
      ...A_OPEN,
      lod: 3,
    })
    expect(far.root.children.find((n) => n.id === 'src/pkg/a.py')!.children).toEqual([])
  })
})

describe('importGraphMode.measure with an expanded file', () => {
  const spec = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, A_OPEN)
  const sizes = importGraphMode.measure(spec, A_OPEN)

  it('sizes the container to its rows, bigger than a collapsed chip', () => {
    const open = sizes.get('src/pkg/a.py')!
    const chip = sizes.get('src/pkg/b.py')!
    expect(open.height).toBeGreaterThan(chip.height)
    expect(open.width).toBeGreaterThan(chip.width)
  })

  it('changes the cache key, so the expansion re-runs elk instead of reusing the layout', () => {
    const collapsed = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, {
      expanded: {},
    })
    const collapsedKey = cacheKeyOf(
      collapsed,
      importGraphMode.measure(collapsed, { expanded: {} }),
      importGraphMode.defaultParams,
    )
    expect(cacheKeyOf(spec, sizes, importGraphMode.defaultParams)).not.toBe(collapsedKey)
  })
})

describe('finalisePositioned', () => {
  const spec = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, A_OPEN)
  const sizes = importGraphMode.measure(spec, A_OPEN)
  /** A stand-in elk result: the container at a known origin, the two other
   *  files elsewhere, and one routed line per edge between them. */
  const elkResult = {
    rects: new Map([
      ['src/pkg/a.py', { x: 100, y: 400, ...sizes.get('src/pkg/a.py')! }],
      ['src/pkg/b.py', { x: 0, y: 0, ...sizes.get('src/pkg/b.py')! }],
      ['src/pkg/c.py', { x: 300, y: 0, ...sizes.get('src/pkg/c.py')! }],
    ]),
    edgePoints: new Map([
      ['imp:src/pkg/b.py->src/pkg/a.py', [10, 20, 50, 200, 90, 380]],
      ['imp:src/pkg/c.py->src/pkg/a.py', [310, 20, 350, 380]],
    ]),
    junctionPoints: new Map<string, { x: number; y: number }[]>(),
  }
  const positioned = finalisePositioned(spec, elkResult)

  it('places every row inside its container rect', () => {
    const box = positioned.rects.get('src/pkg/a.py')!
    const rowRects = [...positioned.rects.entries()].filter(([id]) => id.startsWith('row:'))
    expect(rowRects.length).toBeGreaterThan(0)
    for (const [, rect] of rowRects) {
      expect(rect.x).toBeGreaterThanOrEqual(box.x)
      expect(rect.y).toBeGreaterThanOrEqual(box.y)
      expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width)
      expect(rect.y + rect.height).toBeLessThanOrEqual(box.y + box.height)
    }
  })

  it('re-points the anchored end onto the row centre, keeping elk bends', () => {
    const points = [...positioned.edgePoints.get('imp:src/pkg/b.py->src/pkg/a.py')!]
    const row = positioned.rects.get('row:src/pkg/a.py:impby:src/pkg/b.py')!
    // The unanchored start and the middle bend are exactly as elk routed them.
    expect(points.slice(0, 4)).toEqual([10, 20, 50, 200])
    expect(points.slice(-2)).toEqual([row.x + row.width / 2, row.y + row.height / 2])
  })

  it('leaves an edge with no anchored end exactly as elk routed it', () => {
    const collapsed = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, {
      expanded: {},
    })
    const asIs = finalisePositioned(collapsed, elkResult)
    const points = [...asIs.edgePoints.get('imp:src/pkg/c.py->src/pkg/a.py')!]
    expect(points).toEqual([310, 20, 350, 380])
  })
})

describe('importGraphMode.style with an expanded file', () => {
  const spec = importGraphMode.select(WORKSPACE, importGraphMode.defaultParams, A_OPEN)
  const styles = importGraphMode.style(spec, importGraphMode.defaultParams)
  const container = spec.root.children.find((n) => n.id === 'src/pkg/a.py')!

  it('styles every row and pins it against dragging', () => {
    for (const row of container.children) {
      const style = styles.nodes.get(row.id)
      expect(style).toBeDefined()
      expect(style!.draggable).toBe(false)
    }
  })

  it('gives the expanded container the container fill, not the chip fill', () => {
    const open = styles.nodes.get('src/pkg/a.py')!
    const chip = styles.nodes.get('src/pkg/b.py')!
    expect(open.fill).not.toBe(chip.fill)
  })
})

// -- Local View (tic-d7d7) ----------------------------------------------------

/** A CodebaseGraph around a node/edge list; nothing under test here reads the
 *  stats, so they stay at their zeroes. */
function graphOf(nodes: GraphNode[], edges: GraphEdge[]): CodebaseGraph {
  return {
    directed: true,
    multigraph: false,
    graph: {
      schema_version: 1,
      generated_at: '2026-08-30T00:00:00+00:00',
      root: '../fixture',
      stats: {
        files: nodes.length,
        files_with_diagnostics: 0,
        symbols: nodes.length,
        nodes: nodes.length,
        edges: edges.length,
        node_kinds: {},
        edge_types: {},
        calls_resolved: 0,
        calls_heuristic: 0,
        calls_unresolved: 0,
        calls_builtin: 0,
        diagnostics: 0,
      },
    },
    nodes,
    edges,
  }
}

const file = (name: string): GraphNode =>
  node(`pkg.${name}`, 'module', `src/pkg/${name}.py`, `pkg.${name}`)
const path = (name: string): string => `src/pkg/${name}.py`

/**
 * A hub with importers above, imports below, one edge running between two of
 * those neighbours, a file two hops out and a file with no imports at all:
 * every case the neighbourhood rule has to answer, in one graph.
 *
 *   far -> up1 -> hub <- up2       lonely
 *           |      |
 *           v      v
 *         down1  down2
 */
const LOCAL_WORKSPACE = deriveWorkspace(
  graphOf(['hub', 'up1', 'up2', 'down1', 'down2', 'far', 'lonely'].map(file), [
    imports('pkg.up1', 'pkg.hub'),
    imports('pkg.up2', 'pkg.hub'),
    imports('pkg.hub', 'pkg.down1'),
    imports('pkg.hub', 'pkg.down2'),
    // A dependency two neighbours share: the edge that makes a Local View
    // more than a bare star.
    imports('pkg.up1', 'pkg.down1'),
    // Two hops from the hub, so outside the view entirely.
    imports('pkg.far', 'pkg.up1'),
  ]),
  [],
)

const localSpec = (focusPath: string) =>
  importGraphMode.select(LOCAL_WORKSPACE, importGraphMode.defaultParams, {
    expanded: {},
    focusPath,
  })

describe('neighbourhoodOf (tic-d7d7)', () => {
  const everything = new Set(['hub', 'up1', 'up2', 'down1', 'down2', 'far', 'lonely'].map(path))

  it('takes one hop in both directions from the centre', () => {
    expect([...neighbourhoodOf(LOCAL_WORKSPACE, path('hub'), everything)].sort()).toEqual(
      [path('down1'), path('down2'), path('hub'), path('up1'), path('up2')].sort(),
    )
  })

  it('is just the centre for a file with no imports either way', () => {
    expect([...neighbourhoodOf(LOCAL_WORKSPACE, path('lonely'), everything)]).toEqual([
      path('lonely'),
    ])
  })

  it('drops a neighbour the current filter scope has removed from the tree', () => {
    // A file outside `visible` is one this mode never turns into a node, and
    // an edge to a node elk was never given crashes the layout (tic-56b2).
    const withoutUp2 = new Set([...everything].filter((p) => p !== path('up2')))
    const files = neighbourhoodOf(LOCAL_WORKSPACE, path('hub'), withoutUp2)
    expect(files.has(path('up2'))).toBe(false)
    expect(files.has(path('up1'))).toBe(true)
  })
})

describe('importGraphMode.select with a Local View', () => {
  const spec = localSpec(path('hub'))
  const ids = spec.root.children.map((n) => n.id).sort()

  it('scopes the scene to the centre, its importers and its imports', () => {
    expect(ids).toEqual([path('hub'), path('up1'), path('up2'), path('down1'), path('down2')].sort())
  })

  it('leaves a file two hops out, and a file with no edges at all, absent', () => {
    expect(ids).not.toContain(path('far'))
    expect(ids).not.toContain(path('lonely'))
  })

  it('keeps every import edge running between two neighbours', () => {
    // The point of the rule: a dependency up1 and hub share is visible as the
    // two lines that make it shared, rather than hidden behind a bare star.
    expect(spec.edges.map((e) => e.id).sort()).toEqual(
      [
        `imp:${path('up1')}->${path('hub')}`,
        `imp:${path('up2')}->${path('hub')}`,
        `imp:${path('hub')}->${path('down1')}`,
        `imp:${path('hub')}->${path('down2')}`,
        `imp:${path('up1')}->${path('down1')}`,
      ].sort(),
    )
  })

  it('drops an edge with an end outside the neighbourhood', () => {
    expect(spec.edges.map((e) => e.id)).not.toContain(`imp:${path('far')}->${path('up1')}`)
  })

  it('indexes goto targets for the scoped files only', () => {
    expect(spec.goto?.get(path('up1'))).toBe(path('up1'))
    expect(spec.goto?.has(path('far'))).toBe(false)
  })

  it('records the centre on the spec, for the phases that never see the ui', () => {
    expect(localViewCentre(spec)).toBe(path('hub'))
    expect(localViewCentre(localSpec(''))).toBe('')
  })

  it('scopes to nothing but itself for an isolated file', () => {
    const isolated = localSpec(path('lonely'))
    expect(isolated.root.children.map((n) => n.id)).toEqual([path('lonely')])
    expect(isolated.edges).toEqual([])
  })

  it('falls back to the whole graph for a focus path naming no visible file', () => {
    // A `/out` refetch or a filter change can drop the focused file, exactly
    // as it can drop fsTree.scopeRoot's directory: draw everything, not
    // nothing.  A directory path lands here too -- this mode scopes to files.
    // Since tic-e738 this is a stated contract rather than this mode's own
    // politeness (see UiState.focusPath): cross-mode navigation can seed a
    // focus written in another mode's vocabulary, so degrading to unfocused
    // is required of every mode, not just kind of it.
    for (const stale of [path('gone'), 'src/pkg', 'nonsense']) {
      expect(localSpec(stale).root.children).toHaveLength(7)
    }
    expect(localSpec('').root.children).toHaveLength(7)
  })
})

describe('importGraphMode Local View affordance', () => {
  it('offers every file as the centre of its own neighbourhood', () => {
    for (const fileNode of localSpec('').root.children) {
      expect(fileNode.focusTo).toBe(fileNode.id)
      expect(fileNode.focusIcon).toBe('local-view')
      expect(fileNode.focusLabel).toBe('Local View')
    }
  })

  it('keeps the affordance on the neighbours of an active Local View', () => {
    // Switching centre from inside a Local View is the fastest way to walk a
    // dependency chain; the canvas hides only the centre's own button, via
    // shouldShowGoIn(focusTo === focusPath).
    const up1 = localSpec(path('hub')).root.children.find((n) => n.id === path('up1'))!
    expect(up1.focusTo).toBe(path('up1'))
  })
})

describe('importGraphMode.style with a Local View', () => {
  it('emphasises the centre against its neighbours', () => {
    const styles = importGraphMode.style(localSpec(path('hub')), importGraphMode.defaultParams)
    expect(styles.nodes.get(path('hub'))!.stroke).not.toBe(styles.nodes.get(path('up1'))!.stroke)
  })

  it('leaves every file alike outside a Local View', () => {
    const whole = importGraphMode.style(localSpec(''), importGraphMode.defaultParams)
    const strokes = new Set([...whole.nodes.values()].map((s) => s.stroke))
    expect(strokes.size).toBe(1)
  })
})

describe('cacheKeyOf with a Local View', () => {
  // The trap tic-531b describes, one layer in: on a two-file graph a Local
  // View of either file contains both files, so every node id, every edge id
  // and every measured size matches the whole-graph layout -- while the elk
  // spacing does not.  Without the centre in the key the tighter layout would
  // silently reuse the roomy cached one.
  const TWO = deriveWorkspace(graphOf(['p', 'q'].map(file), [imports('pkg.p', 'pkg.q')]), [])
  const specOf = (focusPath: string) =>
    importGraphMode.select(TWO, importGraphMode.defaultParams, { expanded: {}, focusPath })
  const PARAMS = importGraphMode.defaultParams

  it('differs from the whole graph even when the ids and sizes are identical', () => {
    const whole = specOf('')
    const local = specOf(path('p'))
    expect(local.root.children.map((n) => n.id)).toEqual(whole.root.children.map((n) => n.id))
    const sizes = importGraphMode.measure(whole, { expanded: {} })
    expect(cacheKeyOf(local, sizes, PARAMS)).not.toBe(cacheKeyOf(whole, sizes, PARAMS))
  })

  it('differs between two Local Views of the same graph', () => {
    const sizes = importGraphMode.measure(specOf(''), { expanded: {} })
    expect(cacheKeyOf(specOf(path('p')), sizes, PARAMS)).not.toBe(
      cacheKeyOf(specOf(path('q')), sizes, PARAMS),
    )
  })
})
