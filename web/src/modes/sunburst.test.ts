import { describe, expect, it } from 'vitest'
import { deriveWorkspace } from '../data/derive'
import type { CodebaseGraph, GraphEdge, GraphNode, SymbolKind } from '../data/types'
import { RING_THICKNESS, sectorBounds, sunburstMode } from './sunburst'
import { renderMode } from './types'

/** A module node plus the non-module symbols its file exports. */
function node(
  id: string,
  kind: SymbolKind,
  file_path: string,
  module: string,
  parent: string | null = null,
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
    signature: '',
    docstring: null,
    decorators: [],
    bases: [],
    is_async: false,
    stub: '',
  }
}

/**
 * A small corpus shaped to exercise the sunburst's arithmetic rather than any
 * language feature: three top-level slices of different sizes, one of which
 * (src) nests far enough to test ring depth, aggregation and focusing.
 *
 * Symbol counts per file (what 'symbols' sizes slices by): loop.py has 5,
 * errors.py 1, main.py 0 (floored to 1), core.py 2, setup.py 1.
 */
const NODES: GraphNode[] = [
  node('app.loop', 'module', 'src/app/loop.py', 'app.loop'),
  node('app.loop.Agent', 'class', 'src/app/loop.py', 'app.loop', null),
  node('app.loop.Agent.step', 'method', 'src/app/loop.py', 'app.loop', 'app.loop.Agent'),
  node('app.loop.Agent.name', 'attribute', 'src/app/loop.py', 'app.loop', 'app.loop.Agent'),
  node('app.loop.run', 'function', 'src/app/loop.py', 'app.loop', null),
  node('app.loop.LIMIT', 'variable', 'src/app/loop.py', 'app.loop'),

  node('app.errors', 'module', 'src/app/errors.py', 'app.errors'),
  node('app.errors.PluginError', 'class', 'src/app/errors.py', 'app.errors'),

  node('app.cli', 'module', 'src/app/cli/main.py', 'app.cli'),

  node('lib.core', 'module', 'lib/core.py', 'lib.core'),
  node('lib.core.a', 'function', 'lib/core.py', 'lib.core'),
  node('lib.core.b', 'function', 'lib/core.py', 'lib.core'),

  node('setup', 'module', 'setup.py', 'setup'),
  node('setup.main', 'function', 'setup.py', 'setup'),
]

const EDGES: GraphEdge[] = []

const GRAPH: CodebaseGraph = {
  directed: true,
  multigraph: false,
  graph: {
    schema_version: 1,
    generated_at: '2026-08-30T00:00:00+00:00',
    root: '../fixture',
    stats: {
      files: 5,
      files_with_diagnostics: 0,
      symbols: 11,
      nodes: NODES.length,
      edges: 0,
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

const params = (over: Partial<typeof sunburstMode.defaultParams> = {}) => ({
  ...sunburstMode.defaultParams,
  ...over,
})

/** Render the mode the way the app does: only through the VizMode interface. */
const render = (over = {}, focusPath = '') =>
  renderMode(sunburstMode, WORKSPACE, params(over), { expanded: {}, focusPath })

const TAU = Math.PI * 2
const nodeById = (output: ReturnType<typeof render>, id: string) =>
  output.scene.nodes.find((n) => n.id === id)

describe('sectorBounds', () => {
  it('bounds a full circle by its radius', () => {
    expect(sectorBounds(0, 0, 100, -Math.PI / 2, (3 * Math.PI) / 2)).toEqual({
      x: -100,
      y: -100,
      width: 200,
      height: 200,
    })
  })

  it('is tight around a quarter slice that never crosses a cardinal axis', () => {
    // 20 degrees..70 degrees: no cardinal inside, so the arc endpoints rule.
    const box = sectorBounds(0, 0, 100, (Math.PI / 180) * 20, (Math.PI / 180) * 70)
    expect(box.x).toBeCloseTo(100 * Math.cos((Math.PI / 180) * 70), 9)
    expect(box.x + box.width).toBeCloseTo(100 * Math.cos((Math.PI / 180) * 20), 9)
    expect(box.y).toBeCloseTo(100 * Math.sin((Math.PI / 180) * 20), 9)
    expect(box.y + box.height).toBeCloseTo(100 * Math.sin((Math.PI / 180) * 70), 9)
  })

  it('pulls a slice that crosses a cardinal out to a full radius on that axis', () => {
    // East through south: cos/sin reach their extremes at the cardinal angles,
    // not at the endpoints.
    const box = sectorBounds(0, 0, 100, 0, Math.PI / 2)
    expect(box.x).toBeCloseTo(0, 9)
    expect(box.y).toBeCloseTo(0, 9)
    expect(box.width).toBeCloseTo(100, 9)
    expect(box.height).toBeCloseTo(100, 9)
  })
})

describe('sunburst select/layout over the whole graph', () => {
  it('draws every directory and file as a sector with the fs id scheme', () => {
    const out = render()
    const ids = out.scene.nodes.map((n) => n.id)
    // The hub is the tree root (''); directories use dir:<path> like the
    // fs-tree so focused directories resolve, files use their bare path so a
    // file sector resolves to its module in the inspector.
    expect(ids).toContain('dir:')
    expect(ids).toContain('dir:src')
    expect(ids).toContain('dir:src/app')
    expect(ids).toContain('src/app/loop.py')
    expect(ids).toContain('src/app/cli/main.py')
    expect(ids).toContain('dir:lib')
    expect(ids).toContain('lib/core.py')
    expect(ids).toContain('setup.py')
  })

  it('gives every sector wedge geometry whose arc tiles its parent', () => {
    const out = render()
    const wedge = (id: string) => nodeById(out, id)!.wedge!
    // The fs tree lists directories first (lib, src by name) then files, so
    // top-level slices partition the hub's full circle in that order.
    const src = wedge('dir:src')
    const lib = wedge('dir:lib')
    const setup = wedge('setup.py')
    const hub = wedge('dir:')
    expect(hub.end - hub.start).toBeCloseTo(TAU, 9)
    expect(lib.start).toBeCloseTo(hub.start, 9)
    expect(lib.end).toBeCloseTo(src.start, 9)
    expect(src.end).toBeCloseTo(setup.start, 9)
    expect(setup.end).toBeCloseTo(hub.end, 9)
    expect((src.end - src.start) + (lib.end - lib.start) + (setup.end - setup.start)).toBeCloseTo(TAU, 9)
    for (const n of out.scene.nodes) {
      expect(n.wedge!.end).toBeGreaterThan(n.wedge!.start)
      expect(n.wedge!.innerRadius).toBeGreaterThanOrEqual(0)
      expect(n.wedge!.outerRadius).toBeGreaterThan(n.wedge!.innerRadius)
    }
  })

  it('sizes slices by symbol count: loop.py owns half the pie', () => {
    const out = render({ metric: 'symbols' })
    // loop.py has 5 of the corpus's 10 symbols, and it is src's only deep
    // chain, so its arc is a straight half circle.
    const loop = nodeById(out, 'src/app/loop.py')!.wedge!
    expect(loop.end - loop.start).toBeCloseTo(Math.PI, 6)
    // The directory above it is src's whole share of the circle.
    const src = nodeById(out, 'dir:src')!.wedge!
    expect(src.end - src.start).toBeCloseTo((7 / 10) * TAU, 6)
  })

  it('sizes slices by file count when the metric is files', () => {
    const files = render({ metric: 'files' })
    const loop = nodeById(files, 'src/app/loop.py')!.wedge!
    const errors = nodeById(files, 'src/app/errors.py')!.wedge!
    const main = nodeById(files, 'src/app/cli/main.py')!.wedge!
    // One file each, all siblings under src/app (value 3): three equal arcs.
    expect(loop.end - loop.start).toBeCloseTo(errors.end - errors.start, 9)
    expect(loop.end - loop.start).toBeCloseTo(main.end - main.start, 9)
    // src has 3 files to lib's 1, so src's slice is three times as big.
    const src = nodeById(files, 'dir:src')!.wedge!
    const lib = nodeById(files, 'dir:lib')!.wedge!
    expect((src.end - src.start) / (lib.end - lib.start)).toBeCloseTo(3, 9)
  })

  it('aggregates a directory that reaches the ring limit', () => {
    const out = render({ maxDepth: 2 })
    const ids = new Set(out.scene.nodes.map((n) => n.id))
    // src/app sits at the deepest ring and aggregates main.py and friends.
    expect(ids).toContain('dir:src/app')
    expect(ids).not.toContain('src/app/loop.py')
    expect(ids).not.toContain('src/app/cli/main.py')
    // An aggregated directory has nothing to go into, so no focus affordance.
    const app = nodeById(out, 'dir:src/app')!
    expect(app.focusTo).toBeUndefined()
    // ...while a directory with room below still does.
    expect(nodeById(out, 'dir:src')!.focusTo).toBe('src')
  })

  it('builds a goto index from every drawn path to its sector', () => {
    const out = render()
    expect(out.goto.get('src/app/loop.py')).toBe('src/app/loop.py')
    expect(out.goto.get('src')).toBe('dir:src')
    expect(out.goto.get('lib')).toBe('dir:lib')
    expect(out.goto.get('setup.py')).toBe('setup.py')
  })

  it('lays each sector out at the ring its depth owns', () => {
    const out = render()
    const loop = nodeById(out, 'src/app/loop.py')!
    // loop.py is 4 fs levels below the hub, so its outer radius is 4 rings.
    expect(loop.wedge!.outerRadius).toBeCloseTo(RING_THICKNESS * 4, 9)
    expect(loop.wedge!.innerRadius).toBeCloseTo(RING_THICKNESS * 3, 9)
    // The node's rect is the sector's bounding box, so it contains the arc.
    expect(loop.x).toBeLessThanOrEqual(0)
  })
})

describe('sunburst scoping and styling', () => {
  it('rescopes the sunburst to the focused directory', () => {
    const out = render({}, 'src/app')
    const ids = new Set(out.scene.nodes.map((n) => n.id))
    // The focused directory becomes the hub.
    expect(ids).toContain('dir:src/app')
    expect(nodeById(out, 'dir:src/app')!.label).toBe('app')
    // Its children are now the first ring; the rest of the tree is absent.
    expect(ids).toContain('src/app/loop.py')
    expect(ids).toContain('dir:src/app/cli')
    expect(ids).not.toContain('dir:src')
    expect(ids).not.toContain('setup.py')
    // Everything drawn resolves through the goto index.
    expect(out.goto.get('src/app/loop.py')).toBe('src/app/loop.py')
  })

  it('falls back to the whole graph when the focus names a file or is gone', () => {
    for (const gone of ['does/not/exist', 'src/app/loop.py']) {
      const out = render({}, gone)
      const ids = new Set(out.scene.nodes.map((n) => n.id))
      expect(ids).toContain('dir:src')
      expect(ids).toContain('setup.py')
    }
  })

  it('renders an empty hub when the workspace has no files', () => {
    // A workspace with nothing in it still draws its hub, and nothing else,
    // rather than an empty scene a user cannot account for.
    const empty = deriveWorkspace({ ...GRAPH, nodes: [] }, [])
    const out = renderMode(sunburstMode, empty, params(), { expanded: {}, focusPath: '' })
    expect(out.scene.nodes).toHaveLength(1)
    expect(out.scene.nodes[0].id).toBe('dir:')
  })

  it('styles every sector pinned, with the hub in a neutral fill', () => {
    const out = render()
    for (const n of out.scene.nodes) expect(n.draggable).toBe(false)
    // The hub's neutral fill differs from its (coloured) children.
    const hub = nodeById(out, 'dir:')!
    const child = nodeById(out, 'dir:src')!
    expect(hub.fill).not.toBe(child.fill)
  })

  it('keeps directory wedges drillable and file wedges not', () => {
    const out = render()
    expect(nodeById(out, 'dir:src/app')!.focusTo).toBe('src/app')
    expect(nodeById(out, 'src/app/loop.py')!.focusTo).toBeUndefined()
    expect(nodeById(out, 'dir:src/app/cli')!.focusTo).toBe('src/app/cli')
  })
})

describe('registry integration', () => {
  it('names every control help a real sentence (registry sweep)', () => {
    // Duplicated narrowly here so a failure names the sunburst's own controls;
    // the registry-level sweep in registry.test.ts still runs over all modes.
    const controls = [
      ...(sunburstMode.paramOptions ?? []),
      ...(sunburstMode.paramNumbers ?? []),
    ]
    for (const control of controls) {
      expect(control.help.length).toBeGreaterThan(control.label.length * 4)
      expect(control.help.trim()).toMatch(/\.$/)
    }
  })
})
