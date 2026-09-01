import { describe, expect, it } from 'vitest'
import { deriveCallMetrics } from './callMetrics'
import { deriveCallGraph, indexSymbols } from './derive'
import { deriveEntryPoints } from './entryPoints'
import type { CallGraph, SymbolIndex } from './derive'
import type { GraphEdge, GraphNode, SymbolKind, SymbolRegistry, UnresolvedCall } from './types'

function node(id: string, kind: SymbolKind, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    symbol_id: id,
    name: id.split('.').pop()!,
    kind,
    file_path: 'src/app/thing.py',
    module: 'src.app.thing',
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

const fn = (id: string, overrides: Partial<GraphNode> = {}): GraphNode =>
  node(id, 'function', overrides)

/** A function in a test file, so it is both an entry (tic-22db) and a
 *  test-only caller. */
const testFn = (id: string): GraphNode =>
  fn(id, { file_path: `tests/${id}.py`, module: `tests.${id}` })

function calls(source: string, target: string, count = 1): GraphEdge {
  return {
    source,
    target,
    type: 'CALLS',
    types: ['CALLS'],
    count,
    lines: [1],
    confidence: 'exact',
    call_types: [],
    aliases: [],
  }
}

function registryWith(
  unresolved: [caller: string, times: number][],
  reason = 'unknown receiver',
): SymbolRegistry {
  const unresolved_calls: UnresolvedCall[] = []
  for (const [caller_id, times] of unresolved) {
    for (let i = 0; i < times; i++) {
      unresolved_calls.push({
        caller_id,
        raw_name: 'thing.do',
        line: 1,
        callee_id: null,
        confidence: 'unresolved',
        call_type: 'method',
        reason,
        file_path: 'src/app/thing.py',
      })
    }
  }
  return { unresolved_calls } as unknown as SymbolRegistry
}

interface Built {
  graph: CallGraph
  index: SymbolIndex
  metrics: ReturnType<typeof deriveCallMetrics>
}

function build(
  nodes: GraphNode[],
  edges: GraphEdge[] = [],
  registry: SymbolRegistry | null = null,
): Built {
  const index = indexSymbols(nodes)
  const graph = deriveCallGraph(edges, index)
  const points = deriveEntryPoints(graph, index)
  return { graph, index, metrics: deriveCallMetrics(graph, index, points, registry) }
}

const metric = (built: Built, id: string) => built.metrics.metricOf.get(id)!

describe('deriveCallMetrics: rank', () => {
  it('gives an entry point rank 0 and counts layers from it', () => {
    const { metrics } = build([fn('a'), fn('b'), fn('c')], [calls('a', 'b'), calls('b', 'c')])
    expect(metrics.metricOf.get('a')?.rank).toBe(0)
    expect(metrics.metricOf.get('b')?.rank).toBe(1)
    expect(metrics.metricOf.get('c')?.rank).toBe(2)
    expect(metrics.maxRank).toBe(2)
  })

  it('takes the NEAREST entry when several reach the same function', () => {
    // far -> mid -> shared, and near -> shared directly. Both far and near
    // are entries; shared must rank 1, not 2.
    const built = build(
      [fn('far'), fn('mid'), fn('near'), fn('shared')],
      [calls('far', 'mid'), calls('mid', 'shared'), calls('near', 'shared')],
    )
    expect(metric(built, 'shared').rank).toBe(1)
  })

  it('leaves a function no entry can reach unranked', () => {
    // An orphan is not an entry and nothing calls it, so no layer contains
    // it. Null rather than a sentinel number, so a consumer has to decide
    // where to put it instead of it landing at one end of a sort.
    const built = build([fn('a'), fn('b'), fn('lonely')], [calls('a', 'b')])
    expect(metric(built, 'lonely').rank).toBeNull()
  })

  it('shares one rank across a cyclic component', () => {
    const built = build(
      [fn('root'), fn('x'), fn('y')],
      [calls('root', 'x'), calls('x', 'y'), calls('y', 'x')],
    )
    expect(metric(built, 'x').rank).toBe(1)
    expect(metric(built, 'y').rank).toBe(1)
  })
})

describe('deriveCallMetrics: reach', () => {
  it('counts everything downstream, excluding the function itself', () => {
    const built = build([fn('a'), fn('b'), fn('c')], [calls('a', 'b'), calls('b', 'c')])
    expect(metric(built, 'a').reachDown).toBe(2)
    expect(metric(built, 'b').reachDown).toBe(1)
    expect(metric(built, 'c').reachDown).toBe(0)
  })

  it('counts everything upstream, excluding the function itself', () => {
    const built = build([fn('a'), fn('b'), fn('c')], [calls('a', 'b'), calls('b', 'c')])
    expect(metric(built, 'c').reachUp).toBe(2)
    expect(metric(built, 'b').reachUp).toBe(1)
    expect(metric(built, 'a').reachUp).toBe(0)
  })

  it('counts a diamond once, not twice', () => {
    // top -> left -> bottom, top -> right -> bottom.
    const built = build(
      [fn('top'), fn('left'), fn('right'), fn('bottom')],
      [
        calls('top', 'left'),
        calls('top', 'right'),
        calls('left', 'bottom'),
        calls('right', 'bottom'),
      ],
    )
    expect(metric(built, 'top').reachDown).toBe(3)
    expect(metric(built, 'bottom').reachUp).toBe(3)
  })

  it('gives every member of a cyclic component the same reach', () => {
    // root -> x <-> y -> leaf. x and y are mutually recursive, so each can
    // reach exactly what the other can; that is a fact, not an approximation.
    const built = build(
      [fn('root'), fn('x'), fn('y'), fn('leaf')],
      [calls('root', 'x'), calls('x', 'y'), calls('y', 'x'), calls('y', 'leaf')],
    )
    const x = metric(built, 'x')
    const y = metric(built, 'y')
    expect(x.reachDown).toBe(y.reachDown)
    expect(x.reachUp).toBe(y.reachUp)
    // Each reaches the other plus the leaf.
    expect(x.reachDown).toBe(2)
    // Each is reached by root plus the other.
    expect(x.reachUp).toBe(2)
  })

  it('gives an isolated function zero reach in both directions', () => {
    const built = build([fn('lonely')])
    expect(metric(built, 'lonely').reachDown).toBe(0)
    expect(metric(built, 'lonely').reachUp).toBe(0)
  })
})

describe('deriveCallMetrics: shape', () => {
  /** A hub-and-spoke graph big enough that the p90 thresholds are meaningful. */
  function spokes(callers: number, callees: number) {
    const nodes = [fn('centre')]
    const edges: GraphEdge[] = []
    for (let i = 0; i < callers; i++) {
      nodes.push(fn(`in${i}`))
      edges.push(calls(`in${i}`, 'centre'))
    }
    for (let i = 0; i < callees; i++) {
      nodes.push(fn(`out${i}`))
      edges.push(calls('centre', `out${i}`))
    }
    return build(nodes, edges)
  }

  it('calls a function that calls nothing a leaf', () => {
    const built = build([fn('a'), fn('b')], [calls('a', 'b')])
    expect(metric(built, 'b').shape).toBe('leaf')
  })

  it('calls a one-in one-out function a pipe', () => {
    const built = build(
      [fn('a'), fn('b'), fn('c')],
      [calls('a', 'b'), calls('b', 'c')],
    )
    expect(metric(built, 'b').shape).toBe('pipe')
  })

  it('calls a heavily-called, heavily-calling function a hub', () => {
    expect(metric(spokes(6, 6), 'centre').shape).toBe('hub')
  })

  it('calls a heavily-called function that calls little a facade', () => {
    expect(metric(spokes(6, 2), 'centre').shape).toBe('facade')
  })

  it('calls a lightly-called function that calls heavily an orchestrator', () => {
    expect(metric(spokes(1, 6), 'centre').shape).toBe('orchestrator')
  })

  it('exposes the thresholds it used, and never lets "many" mean fewer than 3', () => {
    const built = build([fn('a'), fn('b')], [calls('a', 'b')])
    expect(built.metrics.highFanIn).toBeGreaterThanOrEqual(3)
    expect(built.metrics.highFanOut).toBeGreaterThanOrEqual(3)
  })

  it('reports raw fan-in and fan-out regardless of shape', () => {
    const built = spokes(6, 2)
    expect(metric(built, 'centre').fanIn).toBe(6)
    expect(metric(built, 'centre').fanOut).toBe(2)
  })
})

describe('deriveCallMetrics: testOnly', () => {
  it('is true when every caller lives in a test file', () => {
    const built = build(
      [testFn('test_one'), testFn('test_two'), fn('helper')],
      [calls('test_one', 'helper'), calls('test_two', 'helper')],
    )
    expect(metric(built, 'helper').testOnly).toBe(true)
  })

  it('is false when even one caller is production code', () => {
    const built = build(
      [testFn('test_one'), fn('real'), fn('helper')],
      [calls('test_one', 'helper'), calls('real', 'helper')],
    )
    expect(metric(built, 'helper').testOnly).toBe(false)
  })

  it('is false for a function with no callers at all', () => {
    // Vacuously true would dress "nothing calls this" up as a finding; the
    // entry-point classification already says that, and says it better.
    const built = build([fn('lonely')])
    expect(metric(built, 'lonely').testOnly).toBe(false)
  })
})

describe('deriveCallMetrics: coverage', () => {
  it('is null for every function until the registry is supplied', () => {
    const built = build([fn('a'), fn('b')], [calls('a', 'b')])
    expect(metric(built, 'a').coverage).toBeNull()
  })

  it('counts resolved call sites from the edges and unresolved from the registry', () => {
    const built = build(
      [fn('a'), fn('b')],
      [calls('a', 'b', 3)],
      registryWith([['a', 5]]),
    )
    expect(metric(built, 'a').coverage).toEqual({
      resolved: 3,
      unresolved: 5,
      total: 8,
      dynamic: 0,
    })
  })

  it('reports a function whose every call site failed to resolve', () => {
    // The shape that makes `leaf` a lie: it looks terminal but is only opaque.
    const built = build([fn('a')], [], registryWith([['a', 4]]))
    expect(metric(built, 'a').shape).toBe('leaf')
    expect(metric(built, 'a').coverage).toEqual({
      resolved: 0,
      unresolved: 4,
      total: 4,
      dynamic: 0,
    })
  })

  it('reports a genuinely call-free function as total 0', () => {
    const built = build([fn('a'), fn('b')], [calls('a', 'b')], registryWith([]))
    expect(metric(built, 'b').coverage).toEqual({
      resolved: 0,
      unresolved: 0,
      total: 0,
      dynamic: 0,
    })
  })

  it('does not count the derived class -> __init__ edge as a resolved call site', () => {
    // No call site produced it, so counting it would inflate the numerator of
    // a figure whose whole job is to be honest.
    const nodes = [
      fn('caller'),
      node('Foo', 'class'),
      node('Foo.__init__', 'method', { parent: 'Foo', name: '__init__' }),
    ]
    const built = build(nodes, [calls('caller', 'Foo')], registryWith([]))
    expect(metric(built, 'Foo').coverage).toEqual({
      resolved: 0,
      unresolved: 0,
      total: 0,
      dynamic: 0,
    })
  })

  it('counts computed callees as the dynamic subset of unresolved (tic-171f)', () => {
    // "Flow leaves the map here" is a different fact from "the resolver was
    // not clever enough here", and the dynamic-hole badge needs it apart.
    const built = build(
      [fn('a'), fn('b')],
      [calls('a', 'b', 2)],
      registryWith([['a', 3]], 'computed callee'),
    )
    expect(metric(built, 'a').coverage).toEqual({
      resolved: 2,
      unresolved: 3,
      total: 5,
      dynamic: 3,
    })
    expect(metric(built, 'b').coverage!.dynamic).toBe(0)
  })
})

describe('deriveCallMetrics: plumbing', () => {
  it('classifies every node of the call graph', () => {
    const built = build([fn('a'), fn('b'), fn('lonely')], [calls('a', 'b')])
    for (const id of built.graph.nodes) expect(built.metrics.metricOf.has(id)).toBe(true)
  })

  it('handles a long chain without a stack overflow', () => {
    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []
    for (let i = 0; i < 2000; i++) {
      nodes.push(fn(`f${i}`))
      edges.push(calls(`f${i}`, `f${i + 1}`))
    }
    nodes.push(fn('f2000'))
    expect(() => build(nodes, edges)).not.toThrow()
    const built = build(nodes, edges)
    expect(metric(built, 'f0').reachDown).toBe(2000)
    expect(metric(built, 'f2000').reachUp).toBe(2000)
  })

  it('memoises per (callGraph, entryPoints, registry)', () => {
    const nodes = [fn('a'), fn('b')]
    const index = indexSymbols(nodes)
    const edges = [calls('a', 'b')]
    const graph = deriveCallGraph(edges, index)
    const points = deriveEntryPoints(graph, index)

    expect(deriveCallMetrics(graph, index, points)).toBe(deriveCallMetrics(graph, index, points))

    const registry = registryWith([['a', 1]])
    expect(deriveCallMetrics(graph, index, points, registry)).not.toBe(
      deriveCallMetrics(graph, index, points),
    )
    expect(deriveCallMetrics(graph, index, points, registry)).toBe(
      deriveCallMetrics(graph, index, points, registry),
    )
  })
})
