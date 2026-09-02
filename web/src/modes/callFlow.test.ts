import { describe, expect, it } from 'vitest'
import { deriveCallMetrics, destinationOf } from '../data/callMetrics'
import { deriveWorkspace, indexSymbols } from '../data/derive'
import { deriveEntryPoints } from '../data/entryPoints'
import type {
  CodebaseGraph,
  GraphEdge,
  GraphNode,
  GraphStats,
  SymbolKind,
  SymbolRegistry,
} from '../data/types'
import { COMPUTED_CALLEE_REASON } from '../data/callMetrics'
import {
  cacheKeyOf,
  callFlowCoverage,
  callFlowMode,
  callFlowRoot,
  callFlowSummary,
  componentId,
  componentLabel,
  complexityAccent,
  coneOf,
  EXTERNAL_PREFIX,
  formatCoverageHud,
  frontierOf,
  groupComplexity,
  groupCoverage,
  moduleTail,
  nodeStyleFor,
  rankedEntryComponents,
  groupControl,
  rootedElementIds,
  rootSublabelFor,
  couplingLabel,
  stateEdgeStyleFor,
  sublabelFor,
  type StateEdgeData,
  toElkGraphInput,
  edgeStyleFor,
} from './callFlow'
import { shouldShowGoIn } from '../canvas/iconButtonLogic'
import { THEME } from '../canvas/theme'
import { edgeTagsOf, type EdgeTags } from '../data/controlFlow'
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

function registryWith(
  external: [caller: string, target: string][],
  computed: [caller: string, times: number][] = [],
  /** Raw reasons, for coverage tests that care about the bucket a reason
   *  falls in rather than about which caller made the call (tic-f21f). */
  reasons: string[] = [],
): SymbolRegistry {
  const unresolved_calls = external.map(([caller_id, target]) => ({
    caller_id,
    raw_name: 'x',
    line: 1,
    callee_id: null,
    confidence: 'unresolved' as const,
    call_type: 'call' as const,
    reason: `external: ${target}`,
    file_path: 'm.py',
  }))
  for (const [caller_id, times] of computed) {
    for (let i = 0; i < times; i++) {
      unresolved_calls.push({
        caller_id,
        raw_name: 'x',
        line: 1,
        callee_id: null,
        confidence: 'unresolved' as const,
        call_type: 'call' as const,
        reason: COMPUTED_CALLEE_REASON,
        file_path: 'm.py',
      })
    }
  }
  for (const reason of reasons) {
    unresolved_calls.push({
      caller_id: 'm.a',
      raw_name: 'x',
      line: 1,
      callee_id: null,
      confidence: 'unresolved' as const,
      call_type: 'call' as const,
      reason,
      file_path: 'm.py',
    })
  }
  return {
    // deriveWorkspace also runs the import-side derivations over this, so the
    // fixture has to be a plausible registry rather than only what this
    // mode reads.
    modules: {},
    bindings: {},
    unresolved_calls,
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

  it('puts the chokepoint figure beside the reach, because the pair is the point', () => {
    // Reaches thirty, and twenty-eight of them have no other way in.
    expect(sublabelFor(['a'], 'm', null, 30, false, null, null, 28)).toBe(
      'm · reaches 30 · gates 28',
    )
  })

  it('stays silent when a function gates nothing, which is most of them', () => {
    expect(sublabelFor(['a'], 'm', null, 3, false, null, null, 0)).toBe('m · reaches 3')
  })

  it('states the claim before the reason to doubt it', () => {
    // tic-d8f2 is computed over the RESOLVED call graph, so the coverage
    // clause has to be readable as a qualifier on the gates figure.
    expect(
      sublabelFor(['a'], 'm', null, 9, false, { resolved: 4, total: 9, unresolved: 5, dynamic: 0 }, null, 6),
    ).toBe('m · reaches 9 · gates 6 · 4/9 sites resolved')
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

// -- wearing the uncertainty (tic-171f) --------------------------------------

/** A workspace WITH the registry, so coverage has filled in.  `m.wide` has 3
 *  resolved sites plus one external call; `m.narrow` has 1 resolved site plus
 *  2 computed callees. */
const COVERAGE_REGISTRY = registryWith([['m.wide', 'json']], [['m.narrow', 2]])
const REG_WORKSPACE = deriveWorkspace(GRAPH, [], '', COVERAGE_REGISTRY)
const selectReg = (over = {}) =>
  callFlowMode.select(REG_WORKSPACE, params(over), { expanded: {} })
const rootedReg = (focusPath: string) =>
  callFlowMode.select(REG_WORKSPACE, params(), { expanded: {}, focusPath })

describe('per-node coverage on the chips (tic-171f)', () => {
  it('says how many of its own call sites a function resolved', () => {
    // A count, not a claim of completeness -- the vocabulary the ticket asks
    // for: "3 resolved calls, 8 unresolved", never "calls X and nothing else".
    const narrow = selectReg().root.children.find((n) => n.id === 'm.narrow')!
    expect(narrow.sublabel).toContain('1/3 sites resolved')
    expect(narrow.sublabel).toContain('2 computed')
  })

  it('counts an external call as unresolved, like any other site it could not place', () => {
    const wide = selectReg().root.children.find((n) => n.id === 'm.wide')!
    expect(wide.sublabel).toContain('3/4 sites resolved')
  })

  it('stays quiet about a function with no unresolved sites -- 1/1 needs no caveat', () => {
    const shared = selectReg().root.children.find((n) => n.id === 'm.shared')!
    expect(shared.sublabel).toContain('1/1 sites resolved')
    expect(shared.sublabel).not.toContain('computed')
  })

  it('says nothing when the registry has not landed -- absence, not zero', () => {
    // Without the registry nothing is known, so nothing may be claimed: "0/0
    // resolved" would read as "this function calls nothing", which is a lie
    // the registry simply has not corrected yet.
    const narrow = select().root.children.find((n) => n.id === 'm.narrow')!
    expect(narrow.sublabel).not.toContain('sites resolved')
  })

  it('says nothing about a function that genuinely makes no calls', () => {
    // Orphans are left out of the overview, so the rooted view draws one.
    const lonely = rootedReg('m.lonely').root.children.find((n) => n.id === 'm.lonely')!
    expect(lonely.sublabel).not.toContain('sites resolved')
  })

  it('sums the coverage of a condensed cycle across its members', () => {
    const cycle = selectReg({ entryLimit: 50, depth: 2 }).root.children.find((n) =>
      n.label.includes('cycle'),
    )!
    expect(cycle.sublabel).toContain('2/2 sites resolved')
  })

  it('groupCoverage sums the members a chip stands for', () => {
    const entryPoints = deriveEntryPoints(REG_WORKSPACE.callGraph, REG_WORKSPACE.index)
    const metrics = deriveCallMetrics(
      REG_WORKSPACE.callGraph,
      REG_WORKSPACE.index,
      entryPoints,
      COVERAGE_REGISTRY,
    )
    expect(groupCoverage(['m.ping', 'm.pong'], metrics)).toEqual({
      resolved: 2,
      unresolved: 0,
      total: 2,
      dynamic: 0,
    })
    expect(groupCoverage(['m.narrow'], metrics)).toEqual({
      resolved: 1,
      unresolved: 2,
      total: 3,
      dynamic: 2,
    })
    expect(groupCoverage(['m.nobody'], metrics)).toBeNull()
  })
})

describe('coverage on the rooted root chip (tic-171f)', () => {
  it('wears the same honesty clause as every other chip', () => {
    const root = rootedReg('m.narrow').root.children.find((n) => n.id === 'm.narrow')!
    expect(root.sublabel).toContain('1/3 sites resolved')
    expect(root.sublabel).toContain('2 computed')
  })
})

describe('heuristic edges (tic-171f)', () => {
  /** `m.wide -> m.loops` fully heuristic; a NEW heuristic `m.wide -> m.pong`
   *  collapses onto the component chip that `m.wide -> m.ping` (exact)
   *  already draws, so the pair is MIXED. */
  const HEURISTIC_GRAPH: CodebaseGraph = {
    ...GRAPH,
    edges: [
      ...EDGES.map((e) =>
        e.source === 'm.wide' && e.target === 'm.loops'
          ? { ...e, confidence: 'heuristic' as const }
          : e,
      ),
      { ...calls('m.wide', 'm.pong'), confidence: 'heuristic' as const },
    ],
  }
  const styleOf = (workspace: ReturnType<typeof deriveWorkspace>) => {
    const spec = callFlowMode.select(workspace, params(), { expanded: {} })
    return { spec, styles: callFlowMode.style(spec, params()) }
  }

  it('draws a heuristic edge differently from an exact one', () => {
    const { styles } = styleOf(hWorkspaceOf(HEURISTIC_GRAPH))
    const heuristic = styles.edges.get('call:m.wide->m.loops')!
    const exact = styles.edges.get('call:m.wide->m.shared')!
    expect(heuristic.dash).toBeDefined()
    expect(exact.dash).toBeUndefined()
    expect(heuristic.opacity!).toBeLessThan(exact.opacity!)
  })

  it('marks a mixed pair as heuristic: one guess among exact sites is still a guess', () => {
    const { spec, styles } = styleOf(hWorkspaceOf(HEURISTIC_GRAPH))
    // The pair collapsed to element `m.ping` carries one exact and one
    // heuristic per-symbol edge; the line is partly conjecture either way.
    const mixed = (spec.edges.find((e) => e.id === 'call:m.wide->m.ping')!.data ?? {}) as {
      heuristic?: boolean
    }
    expect(mixed.heuristic).toBe(true)
    expect(styles.edges.get('call:m.wide->m.ping')!.dash).toBeDefined()
  })

  it('leaves exact edges alone on the registry-less workspace too', () => {
    const { styles } = styleOf(WORKSPACE)
    expect(styles.edges.get('call:m.wide->m.shared')!.dash).toBeUndefined()
  })

  function hWorkspaceOf(graph: CodebaseGraph): ReturnType<typeof deriveWorkspace> {
    return deriveWorkspace(graph, [])
  }
})

describe('edge styles from control-flow tags (tic-23eb)', () => {
  /** Edges with breadcrumbs, so the tags are real derivations, not literals
   *  the tests could lie about. */
  const TAGGED_GRAPH: CodebaseGraph = {
    ...GRAPH,
    edges: [
      { ...calls('m.wide', 'm.shared'), controls: [['if']] },
      { ...calls('m.wide', 'm.loops'), controls: [['for']] },
      { ...calls('m.narrow', 'm.shared'), controls: [['try:except']] },
      { ...calls('m.deep', 'm.deeper'), controls: [['type-checking']] },
      { ...calls('m.shared', 'm.deep'), controls: [['if'], []] },
    ],
  }
  const TAGGED_WORKSPACE = deriveWorkspace(TAGGED_GRAPH, [])
  const styleOf = (id: string) => {
    const spec = callFlowMode.select(TAGGED_WORKSPACE, params(), { expanded: {} })
    const styles = callFlowMode.style(spec, params())
    return { data: spec.edges.find((e) => e.id === id)!, style: styles.edges.get(id)! }
  }

  it('draws a guarded edge dashed', () => {
    expect(styleOf('call:m.wide->m.shared').style.dash).toEqual([6, 4])
  })

  it('draws a looped edge heavier than the unguarded default', () => {
    const plain = edgeStyleFor({ external: false, heuristic: false, tags: edgeTagsOf([[]]) })
    const looped = edgeStyleFor({ external: false, heuristic: false, tags: edgeTagsOf([['for']]) })
    expect(looped.strokeWidth!).toBeGreaterThan(plain.strokeWidth!)
  })

  it('gives mixed the guarded dash rather than a third treatment for 2% of edges', () => {
    // Measured (tic-5069): mixed is 2.2%/1.5% of edges.  Its dash claim --
    // "this call can be skipped" -- is true of it, so the cheap correct
    // choice is to share guarded's dash and let the inspector say the rest.
    expect(edgeStyleFor({ external: false, heuristic: false, tags: edgeTagsOf([['if'], []]) }).dash).toEqual([6, 4])
  })

  it('marks an error path with the one warm colour in the palette', () => {
    expect(styleOf('call:m.narrow->m.shared').style.stroke).toBe(THEME.cycle)
  })

  it('does not draw a type-checking-only edge at all', () => {
    // It fired ZERO times on both measured codebases and structurally will on
    // most (`if TYPE_CHECKING` guards imports, not calls), so it earns no
    // param, no styling and no legend entry until an export exists where it
    // fires.  Absence is the honest treatment of a tag that never happens.
    const style = edgeStyleFor({
      external: false,
      heuristic: false,
      tags: edgeTagsOf([['type-checking']]),
    })
    expect(style.opacity).toBe(0)
  })

  it('leaves the unguarded majority solid -- styling 78% of edges is how a style phase becomes noise', () => {
    // The base fixture's edges carry no breadcrumbs, so their tags are null:
    // the unguarded-by-default case.
    const spec = callFlowMode.select(WORKSPACE, params(), { expanded: {} })
    const style = callFlowMode.style(spec, params()).edges.get('call:m.wide->m.shared')!
    expect(style.dash).toBeUndefined()
    expect(style.stroke).toBe(THEME.edge)
    expect(style.opacity).toBe(0.9)
  })

  it('keeps a heuristic edge on the confidence dash even when guarded, but still weights and warms it', () => {
    // One dash channel; when confidence and the guard collide, "some of this
    // is a guess" is the louder claim on the line.
    const style = edgeStyleFor({
      external: false,
      heuristic: true,
      tags: edgeTagsOf([['for', 'try:except'], ['try:except']]),
    })
    expect(style.dash).toEqual([2, 4])
    expect(style.opacity).toBeLessThan(0.9)
    expect(style.strokeWidth).toBeCloseTo(1.7)
    expect(style.stroke).toBe(THEME.cycle)
  })

  it('keeps the external sink voice untouched by tags', () => {
    expect(
      edgeStyleFor({ external: true, heuristic: false, tags: edgeTagsOf([['for']]) }),
    ).toEqual({ stroke: THEME.textFaint, strokeWidth: 1, dash: [4, 4], opacity: 0.5 })
  })

  it('never lets a tag become the kind, which cross-mode machinery keys on', () => {
    const spec = callFlowMode.select(TAGGED_WORKSPACE, params(), { expanded: {} })
    for (const edge of spec.edges) expect(edge.kind).toBe('call')
  })
})

describe('destinationOf (tic-f21f)', () => {
  it('names the reasons that mean the call simply leaves the project', () => {
    expect(destinationOf('external: rich.console.Console')).toBe('out-of-project')
    expect(destinationOf('stdlib method on list')).toBe('out-of-project')
    expect(destinationOf('foreign base: textual.app.App')).toBe('out-of-project')
  })

  it('keeps a computed callee apart, because that one really is a hole', () => {
    expect(destinationOf('computed callee')).toBe('computed')
  })

  it('treats every other reason, and no reason at all, as unknown', () => {
    expect(destinationOf("unknown receiver 'pilot'")).toBe('unknown')
    expect(destinationOf("ambiguous: 3 symbols named 'go'")).toBe('unknown')
    expect(destinationOf("no member 'stop' on m.Engine")).toBe('unknown')
    expect(destinationOf(null)).toBe('unknown')
    expect(destinationOf(undefined)).toBe('unknown')
  })
})

describe('the global coverage figure (tic-171f, rebucketed by tic-f21f)', () => {
  // ../carnot's real figures, so the arithmetic below is checkable against a
  // codebase rather than against invented numbers.
  const STATS: GraphStats = {
    calls_resolved: 4279,
    calls_heuristic: 786,
    calls_unresolved: 6226,
    calls_builtin: 1900,
  } as GraphStats

  /** Unresolved reasons in carnot's real proportions: 1956 out-of-project,
   *  847 computed, 3423 neither. */
  const CARNOT_REASONS = registryWith(
    [],
    [],
    [
      ...Array<string>(1956).fill('external: rich.console.Console'),
      ...Array<string>(847).fill('computed callee'),
      ...Array<string>(3423).fill("unknown receiver 'pilot'"),
    ],
  )

  it('counts every call site exactly once', () => {
    // `calls_heuristic` is a SUBSET of `calls_resolved` (writer.py counts the
    // resolved list, then filters it by confidence).  Adding the two made a
    // total 786 larger than the number of call sites carnot has, and inflated
    // the headline from 34% to 38%.
    const coverage = callFlowCoverage(STATS, null)
    expect(coverage.total).toBe(4279 + 6226 + 1900)
    expect(coverage.inProject + coverage.outOfProject + coverage.unknown).toBe(coverage.total)
    expect(coverage.heuristic).toBeLessThan(coverage.inProject)
  })

  it('claims only builtins as out-of-project until the reasons arrive', () => {
    // Understating the split is honest; inventing one is not.
    expect(callFlowCoverage(STATS, null)).toEqual({
      inProject: 4279,
      heuristic: 786,
      outOfProject: 1900,
      unknown: 6226,
      computed: null,
      total: 12405,
      classified: false,
    })
  })

  it('splits the unresolved sites by reason once the registry is in', () => {
    const coverage = callFlowCoverage(STATS, CARNOT_REASONS)
    expect(coverage.outOfProject).toBe(1900 + 1956)
    expect(coverage.unknown).toBe(6226 - 1956)
    expect(coverage.computed).toBe(847)
    expect(coverage.classified).toBe(true)
    expect(coverage.inProject + coverage.outOfProject + coverage.unknown).toBe(coverage.total)
  })

  it('leaves a computed callee in `unknown`, where it belongs', () => {
    // It is the subset of unknown we can say most about, not a fourth bucket:
    // flow provably leaves the map there, which is still not knowing where.
    const coverage = callFlowCoverage(STATS, CARNOT_REASONS)
    expect(coverage.computed).toBeLessThan(coverage.unknown)
  })

  it('states three proportions that add up, and the computed count beside them', () => {
    const line = formatCoverageHud(callFlowCoverage(STATS, CARNOT_REASONS))
    expect(line).toContain('12,405 call sites')
    expect(line).toContain('34% in project')
    expect(line).toContain('31% out of project')
    expect(line).toContain('34% unknown')
    expect(line).toContain('847 computed callees')
  })

  it('says the split is still coming rather than publishing one that will move', () => {
    const line = formatCoverageHud(callFlowCoverage(STATS, null))
    expect(line).toContain('34% in project')
    expect(line).toContain('classifying')
    expect(line).not.toContain('out of project')
    expect(line).not.toContain('computed')
  })

  it('survives an export with no calls at all rather than dividing by zero', () => {
    const empty = callFlowCoverage({} as GraphStats, null)
    expect(empty.total).toBe(0)
    expect(formatCoverageHud(empty)).toContain('0 call sites')
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

  it('keeps the chokepoint figure, which the drawn cone cannot show', () => {
    // `reaches` was dropped from a root because it invites subtracting two
    // numbers that measure opposite directions.  `gates` is not a direction:
    // it says how much of the codebase depends on this root exclusively.
    expect(rootSublabelFor(['m.a'], 'm', null, false, 4, false, null, 12)).toBe(
      'm · gates 12 · 4 not shown',
    )
  })
})


describe('chokepoints on the scene (tic-d8f2)', () => {
  // m.wide is the only way into m.loops and into the {m.ping, m.pong} knot,
  // so it gates three.  m.shared has three callers and gates nothing, which
  // is the fan-in/dominance difference in miniature.
  const chipFor = (spec: ReturnType<typeof select>, label: string) =>
    spec.root.children.find((child) => child.label === label)!

  it('wears the figure on the chip that is the whole component', () => {
    const spec = select({ entryLimit: 8, depth: 4, includeTests: true })
    expect(chipFor(spec, 'wide').sublabel).toContain('gates 3')
  })

  it('says nothing on a popular function that gates nothing', () => {
    const spec = select({ entryLimit: 8, depth: 4, includeTests: true })
    expect(chipFor(spec, 'shared').sublabel).not.toContain('gates')
  })

  it('drops the figure when a knot is expanded into its members', () => {
    // A knot that DOES gate something: m.wide -> m.ping <-> m.pong -> m.only,
    // where m.only has no other way in.  Drawn whole the knot reads
    // `gates 1`; the members it expands into must not, because removing
    // m.ping alone leaves m.pong standing and the claim belongs to the group.
    const gating = deriveWorkspace(
      {
        ...GRAPH,
        nodes: [...NODES, node('m.only', 'function')],
        edges: [...EDGES, calls('m.pong', 'm.only')],
      } as CodebaseGraph,
      [],
    )
    // Rooted on m.wide, so the knot is drawn by the ordinary chip path rather
    // than by the root chip, which carries its own copy of the same rule.
    const at = (over = {}) =>
      callFlowMode.select(gating, params({ rootDepth: 3, ...over }), {
        expanded: {},
        focusPath: 'm.wide',
      })

    const whole = at().root.children.find((child) => child.label === '2 functions (cycle)')!
    expect(whole.sublabel).toContain('gates 1')

    const members = at({ expandCycles: true }).root.children.filter(
      (child) => child.label === 'ping' || child.label === 'pong',
    )
    expect(members).toHaveLength(2)
    for (const member of members) expect(member.sublabel).not.toContain('gates')
  })

  it('carries it onto the root of a rooted view', () => {
    const spec = rooted('m.wide')
    const root = spec.root.children.find((child) => child.label === 'wide')!
    expect(root.sublabel).toContain('gates 3')
  })

  it('applies the same rule to a root that is itself an expanded knot', () => {
    // The root chip rewrites its own sublabel, so it carries its own copy of
    // the whole-component rule and needs its own check.
    const gating = deriveWorkspace(
      {
        ...GRAPH,
        nodes: [...NODES, node('m.only', 'function')],
        edges: [...EDGES, calls('m.pong', 'm.only')],
      } as CodebaseGraph,
      [],
    )
    const at = (over = {}) =>
      callFlowMode.select(gating, params(over), { expanded: {}, focusPath: 'm.ping' })

    expect(
      at().root.children.find((child) => child.label === '2 functions (cycle)')!.sublabel,
    ).toContain('gates 1')

    const members = at({ expandCycles: true }).root.children.filter(
      (child) => child.label === 'ping' || child.label === 'pong',
    )
    expect(members).toHaveLength(2)
    for (const member of members) expect(member.sublabel).not.toContain('gates')
  })
})


describe('control-flow tags on the scene (tic-5069)', () => {
  /** m.wide -> m.shared is guarded and looped; m.narrow -> m.shared is not. */
  const TAGGED = {
    ...GRAPH,
    edges: EDGES.map((edge) =>
      edge.source === 'm.wide' && edge.target === 'm.shared'
        ? { ...edge, count: 2, controls: [['if'], ['for']] }
        : { ...edge, controls: [[]] },
    ),
  } as CodebaseGraph
  const tagged = deriveWorkspace(TAGGED, [])
  const scene = callFlowMode.select(tagged, params(), { expanded: {} })
  const dataOf = (id: string) =>
    scene.edges.find((edge) => edge.id === id)!.data as { tags: EdgeTags | null }

  it('carries the tags on data, never on the edge kind', () => {
    // `kind` is what the cross-mode machinery keys on: selection highlighting
    // and marching ants both test for a `call` edge, so encoding a tag there
    // would quietly stop these being recognised as call edges at all.
    for (const edge of scene.edges) expect(edge.kind).toBe('call')
    expect(dataOf('call:m.wide->m.shared').tags!.guard).toBe('guarded')
    expect(dataOf('call:m.narrow->m.shared').tags!.guard).toBe('unguarded')
  })

  it('pools the breadcrumbs of every call-graph edge that collapses onto one line', () => {
    // A drawn element can stand for several symbols, so one line can carry
    // two functions' calls to the same target.  Tagging one edge and picking
    // it would report a fact about a call the reader cannot see.
    const pooled = deriveWorkspace(
      {
        ...GRAPH,
        edges: [
          { ...calls('m.ping', 'm.deep'), controls: [[]] },
          { ...calls('m.pong', 'm.deep'), controls: [['if']] },
          ...EDGES.map((edge) => ({ ...edge, controls: [[]] })),
        ],
      } as CodebaseGraph,
      [],
    )
    // m.ping and m.pong are one condensed knot, so both edges draw one line.
    const spec = callFlowMode.select(pooled, params({ depth: 2 }), { expanded: {} })
    const line = spec.edges.find((edge) => edge.id.endsWith('->m.deep'))!
    expect((line.data as { tags: EdgeTags }).tags.guard).toBe('mixed')
    expect((line.data as { tags: EdgeTags }).tags.sites).toBe(2)
  })

  it('gives an external sink line no tags, because it has no breadcrumbs', () => {
    const withExternals = deriveWorkspace(TAGGED, [], '', registryWith([['m.shared', 'json.loads']]))
    const spec = callFlowMode.select(withExternals, params(), { expanded: {} })
    const external = spec.edges.find((edge) => edge.id.startsWith('ext:'))!
    expect((external.data as { tags: unknown }).tags).toBeNull()
  })

  it('badges a function every one of whose callers calls it from an error path', () => {
    const rescued = deriveWorkspace(
      {
        ...GRAPH,
        edges: EDGES.map((edge) =>
          edge.target === 'm.deep'
            ? { ...edge, controls: [['try:except']] }
            : { ...edge, controls: [[]] },
        ),
      } as CodebaseGraph,
      [],
    )
    const spec = callFlowMode.select(rescued, params({ depth: 2 }), { expanded: {} })
    expect(spec.root.children.find((n) => n.id === 'm.deep')!.sublabel).toContain('error handler')
  })

  it('badges a function every one of whose call sites is inside a loop', () => {
    const spec = callFlowMode.select(
      deriveWorkspace(
        {
          ...GRAPH,
          edges: EDGES.map((edge) =>
            edge.target === 'm.deep'
              ? { ...edge, controls: [['for']] }
              : { ...edge, controls: [[]] },
          ),
        } as CodebaseGraph,
        [],
      ),
      params({ depth: 2 }),
      { expanded: {} },
    )
    expect(spec.root.children.find((n) => n.id === 'm.deep')!.sublabel).toContain('hot')
  })

  it('does not badge `always guarded`, which is true of a quarter of everything', () => {
    // Derived and available; simply too common to be worth a chip's ink.
    const spec = callFlowMode.select(tagged, params(), { expanded: {} })
    for (const child of spec.root.children) {
      expect(child.sublabel ?? '').not.toContain('always guarded')
    }
  })

  it('says nothing about a knot unless every member agrees', () => {
    expect(
      groupControl(['m.ping', 'm.pong'], {
        edgeOf: new Map(),
        nodeOf: new Map([
          ['m.ping', { errorHandler: true, hot: false, alwaysGuarded: true, callers: 1 }],
          ['m.pong', { errorHandler: false, hot: false, alwaysGuarded: true, callers: 1 }],
        ]),
      }),
    ).toEqual({ errorHandler: false, hot: false, alwaysGuarded: true, callers: 2 })
  })

  it('gives a knot no tags at all when one member has no callers', () => {
    expect(
      groupControl(['m.ping', 'm.pong'], {
        edgeOf: new Map(),
        nodeOf: new Map([
          ['m.ping', { errorHandler: true, hot: true, alwaysGuarded: true, callers: 1 }],
        ]),
      }),
    ).toBeNull()
  })
})

describe('complexity proxy (tic-d7d1)', () => {
  it('shades a node at or above the threshold, and not below', () => {
    expect(complexityAccent(10)).toBe(THEME.hairy)
    expect(complexityAccent(25)).toBe(THEME.hairy)
    expect(complexityAccent(9)).toBeNull()
    expect(complexityAccent(1)).toBeNull()
  })

  it('leaves nodes without a complexity number unshaded', () => {
    // A schema_version 5 export predates the field entirely.
    expect(complexityAccent(null)).toBeNull()
    expect(complexityAccent(undefined)).toBeNull()
  })

  it('a condensed knot is as hairy as its worst member', () => {
    const workspace = deriveWorkspace(
      {
        ...GRAPH,
        nodes: [
          ...NODES,
          node('m.calm', 'function'),
          node('m.hairy', 'function', { complexity: 14 }),
        ],
      } as CodebaseGraph,
      [],
    )
    expect(groupComplexity(['m.calm', 'm.hairy'], workspace)).toBe(14)
    expect(groupComplexity(['m.calm'], workspace)).toBeNull()
  })

  it('an ordinary node keeps the plain stroke; a hairy one wears the warm one', () => {
    const plain = nodeStyleFor({ role: 'internal', size: 1, recursive: false, rank: null, complexity: null })
    const hairy = nodeStyleFor({ role: 'internal', size: 1, recursive: false, rank: null, complexity: 12 })
    expect(plain.stroke).toBe(THEME.line)
    expect(hairy.stroke).toBe(THEME.hairy)
    // A cycle keeps its pink accent bar; the warmth only warms the border.
    const knotted = nodeStyleFor({ role: 'internal', size: 2, recursive: false, rank: null, complexity: 12 })
    expect(knotted.stroke).toBe(THEME.hairy)
    expect(knotted.accent).toBe(THEME.cycle)
  })
})

describe('state coupling overlay (tic-675a)', () => {
  // m.set and m.show both touch m.K.cursor and never call each other -- the
  // shape a call graph is structurally blind to.  m.wide calls m.set so the
  // overlay has something to sit beside.
  const STATE_NODES: GraphNode[] = [
    ...NODES,
    node('m.K', 'class'),
    node('m.K.cursor', 'attribute', { parent: 'm.K' }),
    node('m.set', 'function'),
    node('m.show', 'function'),
    node('m.both', 'function'),
  ]
  const STATE_EDGES: GraphEdge[] = [
    ...EDGES,
    calls('m.wide', 'm.set'),
    calls('m.wide', 'm.show'),
    { ...calls('m.set', 'm.K.cursor'), type: 'WRITES', types: ['WRITES'] },
    { ...calls('m.show', 'm.K.cursor'), type: 'READS', types: ['READS'] },
  ]
  const STATE_GRAPH = { ...GRAPH, nodes: STATE_NODES, edges: STATE_EDGES } as CodebaseGraph
  const stateWorkspace = deriveWorkspace(STATE_GRAPH, [])

  const scene = (over = {}) =>
    callFlowMode.select(stateWorkspace, params({ entryLimit: 8, depth: 4, ...over }), {
      expanded: {},
    })
  const stateEdges = (spec: ReturnType<typeof scene>) =>
    spec.edges.filter((edge) => edge.kind === 'state')

  it('draws nothing at all until asked', () => {
    // Off by default: it answers a different question from the one this mode
    // is about, and a reader who has not asked should not read past it.
    expect(callFlowMode.defaultParams.showState).toBe(false)
    expect(stateEdges(scene())).toEqual([])
  })

  it('joins two callables that share state and never call each other', () => {
    const edges = stateEdges(scene({ showState: true }))
    const coupling = edges.find((edge) => edge.from === 'm.set' && edge.to === 'm.show')!
    expect(coupling).toBeDefined()
    expect((coupling.data as StateEdgeData).through).toEqual(['m.K.cursor'])
  })

  it('runs writer to reader, because that is the way the value moves', () => {
    const edges = stateEdges(scene({ showState: true }))
    expect(edges.map((edge) => [edge.from, edge.to])).toEqual([['m.set', 'm.show']])
  })

  it('is a different edge kind, so nothing mistakes it for flow', () => {
    // `kind` is what the cross-mode machinery keys on; a coupling is not a
    // call and must not answer to code that walks calls.
    for (const edge of stateEdges(scene({ showState: true }))) {
      expect(edge.kind).toBe('state')
    }
  })

  it('marks a coupling that merely repeats a call it sits beside', () => {
    const beside = deriveWorkspace(
      {
        ...STATE_GRAPH,
        edges: [...STATE_EDGES, calls('m.set', 'm.show')],
      } as CodebaseGraph,
      [],
    )
    const spec = callFlowMode.select(beside, params({ entryLimit: 8, depth: 4, showState: true }), {
      expanded: {},
    })
    const coupling = spec.edges.find((edge) => edge.kind === 'state')!
    expect((coupling.data as StateEdgeData).beside).toBe(true)
    expect(stateEdgeStyleFor(coupling.data as StateEdgeData).opacity).toBeLessThan(
      stateEdgeStyleFor({ through: [], beside: false, mutual: false, via: '' }).opacity!,
    )
  })

  it('folds a pair coupled both ways into one undirected line', () => {
    // Two functions that each write and read the variable would otherwise
    // draw two opposed arrows, doubling the lines and saying nothing more.
    const mutualWorkspace = deriveWorkspace(
      {
        ...STATE_GRAPH,
        edges: [
          ...EDGES,
          calls('m.wide', 'm.set'),
          calls('m.wide', 'm.show'),
          { ...calls('m.set', 'm.K.cursor'), type: 'READS', types: ['READS', 'WRITES'] },
          { ...calls('m.show', 'm.K.cursor'), type: 'READS', types: ['READS', 'WRITES'] },
        ],
      } as CodebaseGraph,
      [],
    )
    const spec = callFlowMode.select(
      mutualWorkspace,
      params({ entryLimit: 8, depth: 4, showState: true }),
      { expanded: {} },
    )
    const edges = spec.edges.filter((edge) => edge.kind === 'state')
    expect(edges).toHaveLength(1)
    expect((edges[0].data as StateEdgeData).mutual).toBe(true)
    expect(edges[0].directional).toBe(false)
  })

  it('never couples a function to itself, however much state it touches', () => {
    const selfish = deriveWorkspace(
      {
        ...STATE_GRAPH,
        edges: [
          ...EDGES,
          calls('m.wide', 'm.both'),
          { ...calls('m.both', 'm.K.cursor'), type: 'READS', types: ['READS', 'WRITES'] },
        ],
      } as CodebaseGraph,
      [],
    )
    const spec = callFlowMode.select(selfish, params({ entryLimit: 8, depth: 4, showState: true }), {
      expanded: {},
    })
    expect(spec.edges.filter((edge) => edge.kind === 'state')).toEqual([])
  })

  it('carries the shared names for a consumer that can show them', () => {
    const index = stateWorkspace.index
    expect(couplingLabel(['m.K.cursor'], index)).toBe('cursor')
    expect(couplingLabel(['m.K.cursor', 'm.shared', 'm.deep', 'm.deeper'], index)).toBe(
      'cursor, shared +2',
    )
  })

  it('gives the overlay a voice of its own, not a call-edge treatment', () => {
    const style = stateEdgeStyleFor({ through: [], beside: false, mutual: false, via: '' })
    expect(style.dash).toBeDefined()
    expect(style.stroke).not.toBe(edgeStyleFor(undefined).stroke)
  })
})
