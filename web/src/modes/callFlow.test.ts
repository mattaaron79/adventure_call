import { describe, expect, it } from 'vitest'
import { deriveCallMetrics } from '../data/callMetrics'
import { deriveWorkspace, indexSymbols } from '../data/derive'
import { deriveEntryPoints } from '../data/entryPoints'
import type { CodebaseGraph, GraphEdge, GraphNode, SymbolKind, SymbolRegistry } from '../data/types'
import {
  cacheKeyOf,
  callFlowMode,
  callFlowRoot,
  callFlowSummary,
  componentId,
  componentLabel,
  coneOf,
  EXTERNAL_PREFIX,
  frontierOf,
  moduleTail,
  rankedEntryComponents,
  rootedElementIds,
  rootSublabelFor,
  sublabelFor,
  toElkGraphInput,
} from './callFlow'
import { shouldShowGoIn } from '../canvas/iconButtonLogic'
import { THEME } from '../canvas/theme'
import { CALL_FLOW_MODE_ID } from './ids'
import { modeById, MODES } from './registry'

function node(
  id: string,
  kind: SymbolKind,
  overrides: Partial<GraphNode> = {},
): GraphNode {
  const module = id.split('.').slice(0, -1).join('.') || 'm'
  return {
    id,
    symbol_id: id,
    name: id.split('.').pop()!,
    kind,
    file_path: `${module.replace(/\./g, '/')}.py`,
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
    ...overrides,
  }
}

function calls(source: string, target: string): GraphEdge {
  return {
    source,
    target,
    type: 'CALLS',
    types: ['CALLS'],
    count: 1,
    lines: [1],
    confidence: 'exact',
    call_types: [],
    aliases: [],
  }
}

/**
 * A corpus with the shapes the mode has to survive: two entry points of
 * different reach, a shared callee, a mutual-recursion pair, a self-recursive
 * function, and an orphan.
 */
const NODES: GraphNode[] = [
  node('m', 'module', { module: 'm', file_path: 'm.py' }),
  node('m.wide', 'function'),
  node('m.narrow', 'function'),
  node('m.shared', 'function'),
  node('m.deep', 'function'),
  node('m.deeper', 'function'),
  node('m.ping', 'function'),
  node('m.pong', 'function'),
  node('m.loops', 'function'),
  node('m.lonely', 'function'),
  node('t.test_drives', 'function', { module: 't', file_path: 'tests/t.py' }),
  node('t.go', 'function', { module: 't', file_path: 'tests/t.py' }),
]

const EDGES: GraphEdge[] = [
  calls('m.wide', 'm.shared'),
  calls('m.wide', 'm.ping'),
  calls('m.shared', 'm.deep'),
  calls('m.deep', 'm.deeper'),
  calls('m.narrow', 'm.shared'),
  calls('m.ping', 'm.pong'),
  calls('m.pong', 'm.ping'),
  calls('m.wide', 'm.loops'),
  calls('m.loops', 'm.loops'),
  calls('t.test_drives', 'm.shared'),
  calls('t.go', 'm.deep'),
]

const GRAPH: CodebaseGraph = {
  directed: true,
  multigraph: false,
  graph: {
    schema_version: 3,
    generated_at: '',
    root: '',
    stats: {} as CodebaseGraph['graph']['stats'],
  },
  nodes: NODES,
  edges: EDGES,
}

function registryWith(external: [caller: string, target: string][]): SymbolRegistry {
  return {
    // deriveWorkspace also runs the import-side derivations over this, so the
    // fixture has to be a plausible registry rather than only what this
    // mode reads.
    modules: {},
    bindings: {},
    unresolved_calls: external.map(([caller_id, target]) => ({
      caller_id,
      raw_name: 'x',
      line: 1,
      callee_id: null,
      confidence: 'unresolved' as const,
      call_type: 'call' as const,
      reason: `external: ${target}`,
      file_path: 'm.py',
    })),
  } as unknown as SymbolRegistry
}

const WORKSPACE = deriveWorkspace(GRAPH, [])
const params = (over: Partial<Parameters<typeof callFlowMode.select>[1]> = {}) => ({
  ...callFlowMode.defaultParams,
  ...over,
})
const select = (over = {}, workspace = WORKSPACE) =>
  callFlowMode.select(workspace, params(over), { expanded: {} })

describe('callFlowMode registration', () => {
  it('is discoverable through the registry, not by importing it', () => {
    expect(MODES.map((m) => m.id)).toContain(CALL_FLOW_MODE_ID)
    expect(modeById(CALL_FLOW_MODE_ID).id).toBe(CALL_FLOW_MODE_ID)
  })
})

describe('componentLabel and moduleTail', () => {
  const index = indexSymbols(NODES)

  it('names a lone function', () => {
    expect(componentLabel(['m.wide'], index)).toBe('wide')
  })

  it('carries a method class, so two same-named methods differ', () => {
    const nodes = [node('p.K.run', 'method', { parent: 'p.K', name: 'run' })]
    expect(componentLabel(['p.K.run'], indexSymbols(nodes))).toBe('K.run')
  })

  it('counts a cycle rather than picking an arbitrary member', () => {
    expect(componentLabel(['m.ping', 'm.pong'], index)).toBe('2 functions (cycle)')
  })

  it('falls back to the id for a symbol the index does not hold', () => {
    expect(componentLabel(['gone'], index)).toBe('gone')
  })

  it('takes the last module segment, which is what disambiguates', () => {
    expect(moduleTail('platform.menus.views_v1')).toBe('views_v1')
    expect(moduleTail('single')).toBe('single')
  })
})

describe('componentId', () => {
  it('is stable regardless of member order', () => {
    expect(componentId(['m.pong', 'm.ping'])).toBe(componentId(['m.ping', 'm.pong']))
  })
})

describe('sublabelFor', () => {
  it('leads with the module, because that is what disambiguates', () => {
    expect(sublabelFor(['a'], 'views', null, 3, false)).toBe('views · reaches 3')
  })

  it('says how many functions a cycle holds', () => {
    expect(sublabelFor(['a', 'b'], 'm', null, 3, false)).toContain('2 mutually recursive')
  })

  it('marks direct recursion, which is not a cycle component', () => {
    expect(sublabelFor(['a'], 'm', null, 0, true)).toContain('recursive')
  })

  it('names the framework role when there is one', () => {
    expect(sublabelFor(['a'], 'm', 'route', 1, false)).toContain('route')
  })
})

describe('frontierOf', () => {
  const graph = WORKSPACE.callGraph
  const componentOf = (id: string) => graph.componentOf.get(id)!

  it('returns just the seeds at depth 0', () => {
    expect(frontierOf(graph, [componentOf('m.wide')], 0).size).toBe(1)
  })

  it('grows one level per step', () => {
    const seed = [componentOf('m.wide')]
    expect(frontierOf(graph, seed, 1).size).toBeGreaterThan(1)
    expect(frontierOf(graph, seed, 2).size).toBeGreaterThan(frontierOf(graph, seed, 1).size)
  })

  it('counts a mutual-recursion pair as ONE step, not one per member', () => {
    // ping <-> pong is a single component, so reaching it costs one hop --
    // otherwise a knot would eat the whole depth budget going nowhere.
    const frontier = frontierOf(graph, [componentOf('m.wide')], 1)
    expect(frontier.has(componentOf('m.ping'))).toBe(true)
    expect(componentOf('m.ping')).toBe(componentOf('m.pong'))
  })

  it('terminates on a cycle', () => {
    expect(() => frontierOf(graph, [componentOf('m.ping')], 10)).not.toThrow()
  })
})

describe('callFlowMode.select', () => {
  it('draws the entry points, most far-reaching first', () => {
    const spec = select()
    const labels = spec.root.children.map((n) => n.label)
    expect(labels).toContain('wide')
    expect(labels.indexOf('wide')).toBeLessThan(labels.indexOf('narrow'))
  })

  it('reports how many entry points it is showing out of how many exist', () => {
    // A view that shows 40 of 1491 roots while looking complete is the same
    // failure as a call graph that silently drops half its edges.
    const spec = select({ entryLimit: 1 })
    const summary = callFlowSummary(spec)!
    expect(summary.shown).toBe(1)
    expect(summary.total).toBeGreaterThan(1)
  })

  it('draws a mutual-recursion pair as ONE node', () => {
    const spec = select({ depth: 3 })
    const cycle = spec.root.children.filter((n) => n.label.includes('cycle'))
    expect(cycle).toHaveLength(1)
    expect(cycle[0].label).toBe('2 functions (cycle)')
    // ...and it is not two nodes hiding under one label.
    expect(spec.root.children.filter((n) => n.label === 'ping')).toHaveLength(0)
  })

  it('gives a cyclic component no symbol, since it is not one symbol', () => {
    const spec = select({ depth: 3 })
    const cycle = spec.root.children.find((n) => n.label.includes('cycle'))!
    expect(cycle.symbolId).toBeNull()
  })

  it('marks a self-recursive function without calling it a cycle', () => {
    const spec = select({ entryLimit: 50, depth: 3 })
    const loops = spec.root.children.find((n) => n.label === 'loops')!
    expect(loops.sublabel).toContain('recursive')
    expect(loops.sublabel).not.toContain('mutually')
    // Still one symbol, unlike a cyclic component.
    expect(loops.symbolId).toBe('m.loops')
  })

  it('leaves an orphan out of the overview', () => {
    // The overview is about where execution starts; something nothing
    // reaches heads no flow.  tic-171f is where "possibly unused" gets said.
    const spec = select({ entryLimit: 50, depth: 3 })
    expect(spec.root.children.map((n) => n.label)).not.toContain('lonely')
  })

  it('honours the depth param', () => {
    const shallow = select({ depth: 0, entryLimit: 1 }).root.children.length
    const deeper = select({ depth: 2, entryLimit: 1 }).root.children.length
    expect(deeper).toBeGreaterThan(shallow)
  })

  it('never emits an edge naming a node outside the scene', () => {
    // The dangling-reference shape that crashed elk in tic-56b2.
    for (const over of [{ depth: 0 }, { depth: 1 }, { depth: 2 }, { entryLimit: 1 }]) {
      const spec = select(over)
      const ids = new Set(spec.root.children.map((n) => n.id))
      for (const edge of spec.edges) {
        expect(ids.has(edge.from)).toBe(true)
        expect(ids.has(edge.to)).toBe(true)
      }
    }
  })

  it('indexes goto targets by symbol id and by file', () => {
    const spec = select()
    expect(spec.goto?.get('m.wide')).toBeDefined()
    expect(spec.goto?.get('m.py')).toBeDefined()
  })

  it('draws nothing for a workspace with no calls', () => {
    const empty = deriveWorkspace(
      { ...GRAPH, nodes: [node('m', 'module')], edges: [] },
      [],
    )
    expect(() => select({}, empty)).not.toThrow()
  })
})

describe('callFlowMode external sinks', () => {
  const withRegistry = deriveWorkspace(
    GRAPH,
    [],
    '',
    registryWith([
      ['m.wide', 'json.dumps'],
      ['m.wide', 'json.loads'],
      ['m.shared', 'os.path.join'],
      ['m.lonely', 'httpx.get'],
    ]),
  )

  it('aggregates to one node per root module, not per dotted target', () => {
    const spec = select({}, withRegistry)
    const sinks = spec.root.children.filter((n) => n.id.startsWith(EXTERNAL_PREFIX))
    expect(sinks.map((n) => n.label).sort()).toEqual(['json', 'os'])
    expect(sinks.find((n) => n.label === 'json')!.sublabel).toContain('2 calls')
  })

  it('leaves out modules only unreachable code calls', () => {
    // `lonely` is an orphan and never drawn, so its httpx call is not part of
    // this picture and claiming it would be wrong.
    const spec = select({}, withRegistry)
    const labels = spec.root.children.map((n) => n.label)
    expect(labels).not.toContain('httpx')
  })

  it('can be turned off', () => {
    const spec = select({ showExternals: false }, withRegistry)
    expect(spec.root.children.some((n) => n.id.startsWith(EXTERNAL_PREFIX))).toBe(false)
  })

  it('styles an external edge differently from a call edge', () => {
    const spec = select({}, withRegistry)
    const styles = callFlowMode.style(spec, params())
    const ext = spec.edges.find((e) => e.id.startsWith('ext:'))!
    const call = spec.edges.find((e) => !e.id.startsWith('ext:'))!
    expect(styles.edges.get(ext.id)!.dash).toBeDefined()
    expect(styles.edges.get(call.id)!.dash).toBeUndefined()
  })
})

describe('callFlowMode.measure and toElkGraphInput', () => {
  const spec = select()
  const sizes = callFlowMode.measure(spec, { expanded: {} })

  it('sizes every node it drew', () => {
    for (const child of spec.root.children) expect(sizes.get(child.id)).toBeDefined()
  })

  it('hands elk one shape per node and one edge per connection', () => {
    const input = toElkGraphInput(spec, sizes)
    expect(input.nodes).toHaveLength(spec.root.children.length)
    expect(input.edges).toHaveLength(spec.edges.length)
    const declared = new Set(input.nodes.map((n) => n.id))
    for (const edge of input.edges) {
      expect(declared.has(edge.source)).toBe(true)
      expect(declared.has(edge.target)).toBe(true)
    }
  })
})

describe('callFlowMode.style', () => {
  it('styles every node it drew', () => {
    const spec = select()
    const styles = callFlowMode.style(spec, params())
    for (const child of spec.root.children) expect(styles.nodes.get(child.id)).toBeDefined()
  })

  it('gives a cycle the warm accent that marks one everywhere else', () => {
    const spec = select({ depth: 3 })
    const styles = callFlowMode.style(spec, params())
    const cycle = spec.root.children.find((n) => n.label.includes('cycle'))!
    const plain = spec.root.children.find((n) => n.label === 'shared')!
    expect(styles.nodes.get(cycle.id)!.accent).not.toBe(styles.nodes.get(plain.id)!.accent)
  })
})

describe('rankedEntryComponents', () => {
  const graph = WORKSPACE.callGraph
  const entryPoints = deriveEntryPoints(graph, WORKSPACE.index)
  const metrics = deriveCallMetrics(graph, WORKSPACE.index, entryPoints)

  it('orders entry components by blast radius, widest first', () => {
    const ranked = rankedEntryComponents(graph, entryPoints, metrics)
    const wide = graph.componentOf.get('m.wide')!
    const narrow = graph.componentOf.get('m.narrow')!
    expect(ranked.indexOf(wide)).toBeLessThan(ranked.indexOf(narrow))
  })

  it('lists each entry component once, however many entries it holds', () => {
    const ranked = rankedEntryComponents(graph, entryPoints, metrics)
    expect(new Set(ranked).size).toBe(ranked.length)
  })

  it('is deterministic, so the picture does not reshuffle between runs', () => {
    const first = rankedEntryComponents(graph, entryPoints, metrics)
    const second = rankedEntryComponents(graph, entryPoints, metrics)
    expect(second).toEqual(first)
  })
})

describe('callFlowMode and the test surface', () => {
  it('leaves test entry points out by default', () => {
    // Ranking by blast radius puts tests at the top -- they drive the deepest
    // paths -- so an architecture overview that included them would open on a
    // wall of them.
    const labels = select({ entryLimit: 50 }).root.children.map((n) => n.label)
    expect(labels).not.toContain('test_drives')
    expect(labels).toContain('wide')
  })

  it('filters by FILE, not by the test naming rule', () => {
    // `go` sits in a test module but is not named `test_*`, so the role rule
    // misses it while it is plainly test surface. On carnot a dozen nested
    // functions called `go` outranked every real entry point.
    expect(select({ entryLimit: 50 }).root.children.map((n) => n.label)).not.toContain('go')
  })

  it('says how many entry points the filter held back', () => {
    const summary = callFlowSummary(select({ entryLimit: 50 }))!
    expect(summary.hiddenTests).toBe(2)
  })

  it('includes them when asked, and then hides none', () => {
    const spec = select({ entryLimit: 50, includeTests: true })
    expect(spec.root.children.map((n) => n.label)).toContain('test_drives')
    expect(callFlowSummary(spec)!.hiddenTests).toBe(0)
  })
})

// -- the rooted view (tic-7a5e) ---------------------------------------------

/** The component holding `id`, which every rooted-view test needs. */
const componentFor = (id: string): number => WORKSPACE.callGraph.componentOf.get(id)!
const CALLS = WORKSPACE.callGraph

/** `select` with a focus path, i.e. the rooted state. */
const rooted = (focusPath: string, over = {}) =>
  callFlowMode.select(WORKSPACE, params(over), { expanded: {}, focusPath })

/** The symbol ids a rooted scene drew, external sinks excluded. */
const drawnSymbols = (spec: ReturnType<typeof rooted>): Set<string> => {
  const ids = new Set<string>()
  for (const [symbol, element] of spec.goto ?? []) {
    if (element.startsWith(EXTERNAL_PREFIX)) continue
    if (CALLS.componentOf.has(symbol)) ids.add(symbol)
  }
  return ids
}

describe('coneOf', () => {
  it('is just the root at depth 0', () => {
    const cone = coneOf(CALLS, componentFor('m.shared'), 'both', 0)
    expect([...cone.components]).toEqual([componentFor('m.shared')])
    expect(cone.depthOf.get(componentFor('m.shared'))).toBe(0)
  })

  it('walks callees downstream', () => {
    const cone = coneOf(CALLS, componentFor('m.shared'), 'down', 2)
    expect(cone.components.has(componentFor('m.deep'))).toBe(true)
    expect(cone.components.has(componentFor('m.deeper'))).toBe(true)
    expect(cone.components.has(componentFor('m.wide'))).toBe(false)
    expect(cone.depthOf.get(componentFor('m.deeper'))).toBe(2)
  })

  it('walks callers upstream', () => {
    const cone = coneOf(CALLS, componentFor('m.shared'), 'up', 2)
    expect(cone.components.has(componentFor('m.wide'))).toBe(true)
    expect(cone.components.has(componentFor('m.narrow'))).toBe(true)
    expect(cone.components.has(componentFor('m.deep'))).toBe(false)
  })

  it('draws BOTH as two cones, never as a walk that picks up siblings', () => {
    // `t.go` also calls m.deep, so it is two undirected hops from m.shared and
    // an ordinary breadth-first walk would collect it.  It is neither an
    // ancestor nor a descendant of m.shared, so it answers neither question
    // the view asks -- and it is where the size blow-up comes from: on carnot
    // the mixed walk draws a p90 of 47 components at depth 2 against the two
    // cones' 18.
    const cone = coneOf(CALLS, componentFor('m.shared'), 'both', 2)
    expect(cone.components.has(componentFor('t.go'))).toBe(false)
    expect([...cone.components].sort()).toEqual(
      ['m.shared', 'm.wide', 'm.narrow', 't.test_drives', 'm.deep', 'm.deeper']
        .map(componentFor)
        .sort(),
    )
  })

  it('counts a mutual-recursion knot as one step, not one per member', () => {
    // m.wide -> m.ping <-> m.pong.  One hop up from the knot reaches m.wide;
    // if the knot cost a step per member it would not.
    const cone = coneOf(CALLS, componentFor('m.ping'), 'up', 1)
    expect(cone.components.has(componentFor('m.wide'))).toBe(true)
    expect(componentFor('m.ping')).toBe(componentFor('m.pong'))
  })

  it('counts what sits one step past the edge, once per component', () => {
    const cone = coneOf(CALLS, componentFor('m.shared'), 'down', 1)
    // m.deep is drawn; m.deeper is the one thing beyond it.
    expect(cone.beyond).toBe(1)
    expect(coneOf(CALLS, componentFor('m.shared'), 'down', 2).beyond).toBe(0)
  })

  it('does not count the direction it was told not to look in', () => {
    // Looking only downstream, m.shared's three callers are not "beyond the
    // edge of the picture" -- they are outside the question being asked.
    const cone = coneOf(CALLS, componentFor('m.shared'), 'down', 2)
    expect(cone.beyond).toBe(0)
    expect(coneOf(CALLS, componentFor('m.shared'), 'up', 2).beyond).toBe(0)
  })

  it('refuses a whole level rather than a part of one, and says so', () => {
    // A budget of 2 admits the root plus nothing: m.shared's first upstream
    // level is three components, which does not fit, so none of it is drawn.
    // Taking two of the three would mean choosing which callers to believe in.
    const cone = coneOf(CALLS, componentFor('m.shared'), 'up', 1, 2)
    expect(cone.components.size).toBe(1)
    expect(cone.truncated).toBe(true)
    expect(cone.beyond).toBe(3)
  })

  it('stops each direction on its own budget, not both together', () => {
    // Downstream is one component per level and fits; upstream is three at
    // once and does not.  The descendant must still be drawn.
    const cone = coneOf(CALLS, componentFor('m.shared'), 'both', 1, 3)
    expect(cone.components.has(componentFor('m.deep'))).toBe(true)
    expect(cone.components.has(componentFor('m.wide'))).toBe(false)
    expect(cone.truncated).toBe(true)
  })

  it('reports nothing beyond an orphan', () => {
    const cone = coneOf(CALLS, componentFor('m.lonely'), 'both', 3)
    expect(cone.components.size).toBe(1)
    expect(cone.beyond).toBe(0)
    expect(cone.truncated).toBe(false)
  })
})

describe('callFlowMode rooted view', () => {
  it('draws one function with its callers and callees, and nothing else', () => {
    const spec = rooted('m.shared')
    expect(drawnSymbols(spec)).toEqual(
      new Set(['m.shared', 'm.wide', 'm.narrow', 't.test_drives', 'm.deep', 'm.deeper']),
    )
  })

  it('reports what it is rooted on and what it left out', () => {
    const summary = callFlowRoot(rooted('m.shared', { rootDepth: 1 }))!
    expect(summary.root).toBe('m.shared')
    expect(summary.rootIds).toEqual(['m.shared'])
    expect(summary.direction).toBe('both')
    expect(summary.depth).toBe(1)
    expect(summary.drawn).toBe(5)
    expect(summary.beyond).toBe(1) // m.deeper
    expect(summary.truncated).toBe(false)
  })

  it('says on the root chip what is not shown, so a partial view cannot pass for a whole one', () => {
    const spec = rooted('m.shared', { rootDepth: 1 })
    const root = spec.root.children.find((node) => node.id === 'm.shared')!
    expect(root.sublabel).toContain('1 not shown')
    // ...and stays quiet when there is nothing to admit.
    const whole = rooted('m.shared', { rootDepth: 3 })
    expect(whole.root.children.find((node) => node.id === 'm.shared')!.sublabel).not.toContain(
      'not shown',
    )
  })

  it('never claims a reach number on the root, which measures the wrong direction', () => {
    const spec = rooted('m.shared', { direction: 'up' })
    const root = spec.root.children.find((node) => node.id === 'm.shared')!
    expect(root.sublabel).not.toContain('reaches')
  })

  it('honours the direction, because the two questions are asked separately', () => {
    expect(drawnSymbols(rooted('m.shared', { direction: 'down' }))).toEqual(
      new Set(['m.shared', 'm.deep', 'm.deeper']),
    )
    expect(drawnSymbols(rooted('m.shared', { direction: 'up' }))).toEqual(
      new Set(['m.shared', 'm.wide', 'm.narrow', 't.test_drives']),
    )
  })

  it('honours the depth limit', () => {
    expect(drawnSymbols(rooted('m.shared', { direction: 'down', rootDepth: 1 }))).toEqual(
      new Set(['m.shared', 'm.deep']),
    )
  })

  it('offers every chip as the next root, and the framework hides the one you are on', () => {
    const spec = rooted('m.shared')
    for (const node of spec.root.children) {
      expect(node.focusTo).toBe(node.id)
    }
    expect(shouldShowGoIn(spec.root.children.find((n) => n.id === 'm.shared')!.focusTo, 'm.shared')).toBe(
      false,
    )
    expect(shouldShowGoIn(spec.root.children.find((n) => n.id === 'm.deep')!.focusTo, 'm.shared')).toBe(
      true,
    )
  })

  it('marks the root so it can be told from its neighbours', () => {
    const spec = rooted('m.shared')
    expect(rootedElementIds(spec)).toEqual(['m.shared'])
    const styles = callFlowMode.style(spec, params())
    expect(styles.nodes.get('m.shared')!.stroke).toBe(THEME.accent)
    expect(styles.nodes.get('m.deep')!.stroke).not.toBe(THEME.accent)
  })

  it('re-lays out when only the root changes', () => {
    // Two roots can draw the same chips at the same sizes -- so the node ids
    // and the params alone would hit the stale single-slot cache.
    const a = rooted('m.wide', { direction: 'down', rootDepth: 0 })
    const b = rooted('m.shared', { direction: 'up', rootDepth: 0 })
    expect(cacheKeyOf(a, callFlowMode.measure(a, { expanded: {} }), params())).not.toBe(
      cacheKeyOf(b, callFlowMode.measure(b, { expanded: {} }), params()),
    )
  })

  it('draws a knot as one chip, and as its members when asked', () => {
    const condensed = rooted('m.ping')
    expect(condensed.root.children.map((n) => n.label)).toContain('2 functions (cycle)')
    expect(callFlowRoot(condensed)!.rootIds).toHaveLength(1)

    const expanded = rooted('m.ping', { expandCycles: true })
    const labels = expanded.root.children.map((n) => n.label)
    expect(labels).toContain('ping')
    expect(labels).toContain('pong')
    expect([...callFlowRoot(expanded)!.rootIds].sort()).toEqual(['m.ping', 'm.pong'])
  })

  it('draws the calls INSIDE an expanded knot, which is the only reason to expand one', () => {
    const expanded = rooted('m.ping', { expandCycles: true })
    const ids = expanded.edges.map((edge) => edge.id)
    expect(ids).toContain('call:m.ping->m.pong')
    expect(ids).toContain('call:m.pong->m.ping')
    // Condensed, the same pair is one chip and the mutual call has nowhere to
    // go; the "(cycle)" label carries it instead.
    expect(rooted('m.ping').edges.map((e) => e.id)).not.toContain('call:m.ping->m.pong')
  })

  it('never draws a self-edge, whose chip has nowhere to put it', () => {
    const spec = rooted('m.loops')
    expect(spec.edges.filter((edge) => edge.from === edge.to)).toEqual([])
    expect(spec.root.children.find((n) => n.id === 'm.loops')!.sublabel).toContain('recursive')
  })

  it('draws the overview for a focus the call graph cannot resolve', () => {
    // The fallback `UiState.focusPath` requires (tic-e738): a stale symbol, or
    // a DIRECTORY handed over by something that mistook this for the fs-tree.
    for (const bogus of ['', 'm/nope.py', 'm.vanished', 'src/carnot']) {
      const spec = callFlowMode.select(WORKSPACE, params(), { expanded: {}, focusPath: bogus })
      expect(callFlowRoot(spec)).toBeUndefined()
      expect(callFlowSummary(spec)).toBeDefined()
    }
  })

  it('roots on a test function when asked directly, whatever the entry filter says', () => {
    // includeTests governs which entries the OVERVIEW ranks.  Being handed a
    // root is an explicit request, and silently refusing it would leave the
    // canvas showing the overview with no explanation.
    expect(drawnSymbols(rooted('t.go'))).toContain('t.go')
  })

  it('leaves an orphan as a picture of one thing rather than an empty canvas', () => {
    const spec = rooted('m.lonely')
    expect(spec.root.children.map((n) => n.id)).toEqual(['m.lonely'])
    expect(spec.edges).toEqual([])
  })
})

describe('rootSublabelFor', () => {
  it('says what is missing rather than how far the root reaches', () => {
    expect(rootSublabelFor(['m.a'], 'm', null, false, 4, false)).toBe('m · 4 not shown')
  })

  it('stays quiet when the picture is complete', () => {
    expect(rootSublabelFor(['m.a'], 'm', null, false, 0, false)).toBe('m')
  })

  it('distinguishes a depth limit from a budget that cut the walk short', () => {
    expect(rootSublabelFor(['m.a'], 'm', null, false, 9, true)).toBe(
      'm · 9 not shown (depth capped)',
    )
  })

  it('keeps the identity clauses the overview chips use', () => {
    expect(rootSublabelFor(['m.a', 'm.b'], 'm', 'route', false, 0, false)).toBe(
      'm · 2 mutually recursive · route',
    )
  })
})
