import { describe, expect, it } from 'vitest'
import {
  calleesStep,
  callersStep,
  closureFrom,
  CLOSURE_BUDGET,
  deriveAccesses,
  stateTouchedBy,
  variableImpact,
} from './dataFlow'
import { deriveCallGraph, indexSymbols } from './derive'
import type { EdgeType, GraphEdge, GraphNode, SymbolKind } from './types'

function node(id: string, kind: SymbolKind, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    symbol_id: id,
    name: id.split('.').pop()!,
    kind,
    file_path: 'm.py',
    module: 'm',
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

const fn = (id: string): GraphNode => node(id, 'function')
const variable = (id: string): GraphNode => node(id, 'variable')
const attribute = (id: string, parent: string): GraphNode =>
  node(id, 'attribute', { parent })

function edge(source: string, target: string, ...types: EdgeType[]): GraphEdge {
  return {
    source,
    target,
    type: types[0],
    types,
    count: 1,
    lines: [1],
    confidence: 'exact',
    call_types: [],
    aliases: [],
  }
}

const calls = (source: string, target: string) => edge(source, target, 'CALLS')
const reads = (source: string, target: string) => edge(source, target, 'READS')
const writes = (source: string, target: string) => edge(source, target, 'WRITES')

describe('deriveAccesses (tic-675a)', () => {
  const NODES = [fn('m.a'), fn('m.b'), variable('m.X'), variable('m.Y')]
  const index = indexSymbols(NODES)

  it('indexes both edge types in both directions', () => {
    const accesses = deriveAccesses([reads('m.a', 'm.X'), writes('m.b', 'm.X')], index)
    expect(accesses.readersOf.get('m.X')).toEqual(['m.a'])
    expect(accesses.writersOf.get('m.X')).toEqual(['m.b'])
    expect(accesses.readsBy.get('m.a')).toEqual(['m.X'])
    expect(accesses.writesBy.get('m.b')).toEqual(['m.X'])
  })

  it('puts a pair that is both into both indexes', () => {
    // `x += 1` produces one edge carrying both type names (tic-13d7).
    const accesses = deriveAccesses([edge('m.a', 'm.X', 'READS', 'WRITES')], index)
    expect(accesses.readersOf.get('m.X')).toEqual(['m.a'])
    expect(accesses.writersOf.get('m.X')).toEqual(['m.a'])
  })

  it('ignores CALLS, which is a different claim entirely', () => {
    expect(deriveAccesses([calls('m.a', 'm.b')], index).readersOf.size).toBe(0)
  })

  it('drops an edge whose end the excludes or the file query removed', () => {
    const accesses = deriveAccesses([reads('m.a', 'm.gone'), reads('m.vanished', 'm.X')], index)
    expect(accesses.readersOf.size).toBe(0)
  })

  it('lists each accessor once however many times it touches the target', () => {
    const accesses = deriveAccesses([reads('m.a', 'm.X'), reads('m.a', 'm.X')], index)
    expect(accesses.readersOf.get('m.X')).toEqual(['m.a'])
  })

  it('is memoised per (edges, index) pair', () => {
    const edges = [reads('m.a', 'm.X')]
    expect(deriveAccesses(edges, index)).toBe(deriveAccesses(edges, index))
  })

  describe('shared mutable state', () => {
    it('flags a module variable more than one function writes', () => {
      // The cheapest finding in the module: no analysis beyond counting.
      const accesses = deriveAccesses([writes('m.a', 'm.X'), writes('m.b', 'm.X')], index)
      expect(accesses.sharedState).toEqual(['m.X'])
    })

    it('says nothing about a variable with one writer', () => {
      const accesses = deriveAccesses([writes('m.a', 'm.X'), reads('m.b', 'm.X')], index)
      expect(accesses.sharedState).toEqual([])
    })

    it('does not flag a class attribute, which is ordinary object state', () => {
      // Two methods writing `self.x` is every class ever written; flagging it
      // would cry wolf on the whole project.
      const withClass = indexSymbols([
        fn('m.K.a'),
        fn('m.K.b'),
        node('m.K', 'class'),
        attribute('m.K.x', 'm.K'),
      ])
      const accesses = deriveAccesses(
        [writes('m.K.a', 'm.K.x'), writes('m.K.b', 'm.K.x')],
        withClass,
      )
      expect(accesses.sharedState).toEqual([])
    })
  })
})

describe('closureFrom (tic-675a)', () => {
  it('walks transitively and excludes the seeds', () => {
    const next = new Map([
      ['a', ['b']],
      ['b', ['c']],
    ])
    const result = closureFrom(['a'], (id) => next.get(id) ?? [])
    expect(result.reached).toEqual(['b', 'c'])
    expect(result.truncated).toBe(false)
  })

  it('terminates on a cycle', () => {
    // Mutual recursion is ordinary in a call graph, not exotic, and a
    // traversal that hung on it would be useless on any real codebase.
    const next = new Map([
      ['a', ['b']],
      ['b', ['a', 'c']],
      ['c', ['b']],
    ])
    expect([...closureFrom(['a'], (id) => next.get(id) ?? []).reached].sort()).toEqual(['b', 'c'])
  })

  it('stops at the budget and says it stopped', () => {
    const chain = (id: string) => [String(Number(id) + 1)]
    const result = closureFrom(['0'], chain, 3)
    expect(result.reached).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('knows nothing about edges, so any adjacency composes', () => {
    // The generic half tic-675a asked for: CALLS + READS here, CALLS +
    // IMPORTS unchanged.
    const index = indexSymbols([fn('m.a'), fn('m.b'), fn('m.c')])
    const graph = deriveCallGraph([calls('m.a', 'm.b'), calls('m.b', 'm.c')], index)
    expect(closureFrom(['m.a'], calleesStep(graph)).reached).toEqual(['m.b', 'm.c'])
    expect(closureFrom(['m.c'], callersStep(graph)).reached).toEqual(['m.b', 'm.a'])
  })

  it('does not count a self-call as reaching anywhere', () => {
    const index = indexSymbols([fn('m.loop')])
    const graph = deriveCallGraph([calls('m.loop', 'm.loop')], index)
    expect(closureFrom(['m.loop'], calleesStep(graph)).reached).toEqual([])
  })
})

describe('variableImpact (tic-675a)', () => {
  //  outer -> mid -> reader -> X,  writer -> X
  const NODES = [fn('m.outer'), fn('m.mid'), fn('m.reader'), fn('m.writer'), variable('m.X')]
  const index = indexSymbols(NODES)
  const EDGES = [
    calls('m.outer', 'm.mid'),
    calls('m.mid', 'm.reader'),
    reads('m.reader', 'm.X'),
    writes('m.writer', 'm.X'),
  ]
  const graph = deriveCallGraph(EDGES, index)
  const accesses = deriveAccesses(EDGES, index)

  it('separates what the edges say from what the composition says', () => {
    const impact = variableImpact(graph, accesses, 'm.X')
    expect(impact.readers).toEqual(['m.reader'])
    expect(impact.writers).toEqual(['m.writer'])
    expect([...impact.reached].sort()).toEqual(['m.mid', 'm.outer'])
  })

  it('reaches a caller that never names the variable at all', () => {
    // The whole point: `outer` is two calls above the read and is affected by
    // a change to X, and no single edge type says so.
    expect(variableImpact(graph, accesses, 'm.X').reached).toContain('m.outer')
  })

  it('walks callers and not callees', () => {
    // A function the reader CALLS is not affected on this evidence -- that
    // would need arguments followed through the call, which the export does
    // not record.
    const withCallee = [...EDGES, calls('m.reader', 'm.helper')]
    const wider = indexSymbols([...NODES, fn('m.helper')])
    const impact = variableImpact(
      deriveCallGraph(withCallee, wider),
      deriveAccesses(withCallee, wider),
      'm.X',
    )
    expect(impact.reached).not.toContain('m.helper')
  })

  it('reports a variable nothing touches as empty rather than absent', () => {
    // "Nothing reads this" is a finding worth rendering, not a gap.
    const impact = variableImpact(graph, accesses, 'm.untouched')
    expect(impact).toMatchObject({ readers: [], writers: [], reached: [], shared: false })
  })

  it('carries the shared-state flag through', () => {
    const shared = [writes('m.reader', 'm.X'), writes('m.writer', 'm.X')]
    expect(variableImpact(graph, deriveAccesses(shared, index), 'm.X').shared).toBe(true)
  })

  it('terminates when the callers are a cycle', () => {
    const cyclic = [
      calls('m.outer', 'm.mid'),
      calls('m.mid', 'm.outer'),
      calls('m.mid', 'm.reader'),
      reads('m.reader', 'm.X'),
    ]
    const impact = variableImpact(
      deriveCallGraph(cyclic, index),
      deriveAccesses(cyclic, index),
      'm.X',
    )
    expect([...impact.reached].sort()).toEqual(['m.mid', 'm.outer'])
  })

  it('says when the budget stopped it, because the list is then a floor', () => {
    const impact = variableImpact(graph, accesses, 'm.X', 1)
    expect(impact.truncated).toBe(true)
    expect(CLOSURE_BUDGET).toBeGreaterThan(1)
  })
})

describe('stateTouchedBy (tic-675a)', () => {
  //  top -> deep -> writes m.X;  top reads m.Y itself
  const NODES = [fn('m.top'), fn('m.deep'), variable('m.X'), variable('m.Y')]
  const index = indexSymbols(NODES)
  const EDGES = [calls('m.top', 'm.deep'), writes('m.deep', 'm.X'), reads('m.top', 'm.Y')]
  const graph = deriveCallGraph(EDGES, index)
  const accesses = deriveAccesses(EDGES, index)

  it('separates state it touches itself from state it reaches through calls', () => {
    const touched = stateTouchedBy(graph, accesses, 'm.top')
    expect(touched.reads).toEqual(['m.Y'])
    expect(touched.writes).toEqual([])
    expect(touched.throughCalls).toEqual(['m.X'])
  })

  it('finds state under a function whose own body touches none', () => {
    // The surprise this exists for: a function that reads as pure, five calls
    // above something that mutates a module global.
    const touched = stateTouchedBy(graph, accesses, 'm.top')
    expect(touched.reads.concat(touched.writes)).not.toContain('m.X')
    expect(touched.throughCalls).toContain('m.X')
  })

  it('never repeats a variable the function touches directly', () => {
    const both = [...EDGES, reads('m.deep', 'm.Y')]
    const touched = stateTouchedBy(graph, deriveAccesses(both, index), 'm.top')
    expect(touched.throughCalls).not.toContain('m.Y')
  })

  it('terminates when the callees are a cycle', () => {
    const cyclic = [
      calls('m.top', 'm.deep'),
      calls('m.deep', 'm.top'),
      writes('m.deep', 'm.X'),
    ]
    expect(
      stateTouchedBy(deriveCallGraph(cyclic, index), deriveAccesses(cyclic, index), 'm.top')
        .throughCalls,
    ).toEqual(['m.X'])
  })
})
