import { describe, expect, it } from 'vitest'
import { deriveCallGraph, indexSymbols } from './derive'
import { deriveDominators, SUPER_ROOT } from './dominators'
import { deriveEntryPoints } from './entryPoints'
import type { GraphEdge, GraphNode, SymbolKind } from './types'

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

const fn = (id: string): GraphNode => node(id, 'function')

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
 * Build the dominator index over a graph named by its edges, plus any isolated
 * nodes listed separately.  `a -> b` is spelled `['a', 'b']`.
 */
function dominatorsOf(pairs: readonly (readonly [string, string])[], extra: string[] = []) {
  const ids = new Set<string>(extra)
  for (const [source, target] of pairs) {
    ids.add(source)
    ids.add(target)
  }
  const index = indexSymbols([...ids].map(fn))
  const graph = deriveCallGraph(
    pairs.map(([source, target]) => calls(source, target)),
    index,
  )
  return { graph, index, dom: deriveDominators(graph, deriveEntryPoints(graph, index)) }
}

/** The component holding a symbol, for the component-keyed maps. */
function componentOf(graph: ReturnType<typeof dominatorsOf>['graph'], id: string): number {
  return graph.componentOf.get(id)!
}

describe('deriveDominators (tic-d8f2)', () => {
  describe('a chain', () => {
    // a -> b -> c -> d.  Everything below a is exclusively below a.
    const pairs = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ] as const

    it('gates everything beneath it, and nothing beside it', () => {
      const { dom } = dominatorsOf(pairs)
      expect(dom.gatesOf.get('a')).toBe(3)
      expect(dom.gatesOf.get('b')).toBe(2)
      expect(dom.gatesOf.get('c')).toBe(1)
      expect(dom.gatesOf.get('d')).toBe(0)
    })

    it('names the last thing that must happen before each one can', () => {
      const { dom } = dominatorsOf(pairs)
      expect(dom.immediateDominatorOf.get('d')).toEqual(['c'])
      expect(dom.immediateDominatorOf.get('c')).toEqual(['b'])
      expect(dom.immediateDominatorOf.get('b')).toEqual(['a'])
    })

    it('leaves the entry with nothing above it', () => {
      const { graph, dom } = dominatorsOf(pairs)
      expect(dom.immediateDominatorOf.get('a')).toEqual([])
      expect(dom.idomOf.get(componentOf(graph, 'a'))).toBe(SUPER_ROOT)
    })
  })

  describe('a diamond', () => {
    // a -> b -> d, a -> c -> d.  The classic: neither arm dominates the join.
    const pairs = [
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'd'],
      ['c', 'd'],
    ] as const

    it('gates the join from the fork, not from either arm', () => {
      const { dom } = dominatorsOf(pairs)
      expect(dom.gatesOf.get('a')).toBe(3)
      expect(dom.gatesOf.get('b')).toBe(0)
      expect(dom.gatesOf.get('c')).toBe(0)
    })

    it('hands the join point back past both arms to the fork', () => {
      // The whole reason this is not a reachability question: `d` is BELOW
      // both arms and dominated by NEITHER, because removing either leaves a
      // path.
      const { dom } = dominatorsOf(pairs)
      expect(dom.immediateDominatorOf.get('d')).toEqual(['a'])
    })
  })

  describe('more than one entry', () => {
    // e1 -> x -> z, e2 -> x.  Two ways in, so neither entry gates x.
    const pairs = [
      ['e1', 'x'],
      ['e2', 'x'],
      ['x', 'z'],
    ] as const

    it('leaves a shared callee dominated by neither entry', () => {
      const { graph, dom } = dominatorsOf(pairs)
      expect(dom.gatesOf.get('e1')).toBe(0)
      expect(dom.gatesOf.get('e2')).toBe(0)
      expect(dom.immediateDominatorOf.get('x')).toEqual([])
      expect(dom.idomOf.get(componentOf(graph, 'x'))).toBe(SUPER_ROOT)
    })

    it('still gates what hangs off the shared callee alone', () => {
      const { dom } = dominatorsOf(pairs)
      expect(dom.gatesOf.get('x')).toBe(1)
      expect(dom.immediateDominatorOf.get('z')).toEqual(['x'])
    })

    it('hangs every root off the super-root', () => {
      const { graph, dom } = dominatorsOf(pairs)
      expect(dom.childrenOf.get(SUPER_ROOT)).toEqual(
        [componentOf(graph, 'e1'), componentOf(graph, 'x'), componentOf(graph, 'e2')].sort(
          (a, b) => a - b,
        ),
      )
    })
  })

  describe('mutual recursion', () => {
    // a -> b <-> c -> d.  Tarjan's folds {b, c} into one component, and the
    // dominance claim is about the PAIR: removing b alone leaves c standing.
    const pairs = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'b'],
      ['c', 'd'],
    ] as const

    it('gives both members the figure the group earns', () => {
      const { dom } = dominatorsOf(pairs)
      expect(dom.gatesOf.get('b')).toBe(1)
      expect(dom.gatesOf.get('c')).toBe(1)
      expect(dom.gatesOf.get('a')).toBe(3)
    })

    it('names the whole group as the immediate dominator, not one member', () => {
      const { dom } = dominatorsOf(pairs)
      expect(dom.immediateDominatorOf.get('d')).toEqual(['b', 'c'])
    })

    it('ranks the group once, as a group', () => {
      const { dom } = dominatorsOf(pairs)
      expect(dom.chokepoints).toEqual([
        { members: ['a'], gated: 3 },
        { members: ['b', 'c'], gated: 1 },
      ])
    })
  })

  describe('the root set is entries UNION sources', () => {
    // p <-> q -> r, and nothing outside calls either.  Both p and q have a
    // caller (each other), so tic-22db classifies them `internal` and the
    // entry set is EMPTY -- yet {p, q} is a source of the condensation and
    // execution plainly starts there.
    const pairs = [
      ['p', 'q'],
      ['q', 'p'],
      ['p', 'r'],
    ] as const

    it('reaches a subgraph headed by a component with no entry member', () => {
      const { graph, index, dom } = dominatorsOf(pairs)
      expect(deriveEntryPoints(graph, index).entries).toEqual([])
      expect(dom.gatesOf.get('p')).toBe(1)
      expect(dom.immediateDominatorOf.get('r')).toEqual(['p', 'q'])
    })
  })

  describe('a node nothing reaches and that reaches nothing', () => {
    it('is in the tree, under the super-root, gating nothing', () => {
      const { graph, dom } = dominatorsOf([['a', 'b']], ['lonely'])
      expect(dom.gatesOf.get('lonely')).toBe(0)
      expect(dom.immediateDominatorOf.get('lonely')).toEqual([])
      expect(dom.idomOf.get(componentOf(graph, 'lonely'))).toBe(SUPER_ROOT)
    })
  })

  describe('dominance is not fan-in', () => {
    it('gives a symbol everything calls a rank of zero', () => {
      // ../carnot's `ToolResult.success` in miniature: 59 callers, gates 0.
      // Popularity is precisely what stops it being load-bearing -- every
      // caller reaches it directly, so removing it disconnects nobody from
      // anything else.  Fan-in and dominance rank almost disjoint sets on the
      // real export (top twenty overlap: one symbol).
      const pairs = [
        ['e1', 'popular'],
        ['e2', 'popular'],
        ['e3', 'popular'],
        ['e1', 'quiet'],
        ['quiet', 'hidden'],
      ] as const
      const { dom } = dominatorsOf(pairs)
      expect(dom.gatesOf.get('popular')).toBe(0)
      expect(dom.gatesOf.get('quiet')).toBe(1)
      // The most-called symbol in the graph does not appear in the ranking at
      // all, while the one nothing much calls does.
      expect(dom.chokepoints.map((c) => c.members[0])).toEqual(['e1', 'quiet'])
    })
  })

  describe('the index as a whole', () => {
    it('ranks chokepoints most-gating first and omits everything else', () => {
      const pairs = [
        ['big', 'm1'],
        ['m1', 'm2'],
        ['m2', 'm3'],
        ['small', 'only'],
      ] as const
      const { dom } = dominatorsOf(pairs)
      expect(dom.chokepoints.map((c) => [c.members[0], c.gated])).toEqual([
        ['big', 3],
        ['m1', 2],
        ['m2', 1],
        ['small', 1],
      ])
    })

    it('gives every symbol a figure, so a UI never has to guess at absence', () => {
      const { graph, dom } = dominatorsOf([['a', 'b']], ['lonely'])
      for (const id of graph.nodes) {
        expect(dom.gatesOf.has(id)).toBe(true)
        expect(dom.immediateDominatorOf.has(id)).toBe(true)
      }
    })

    it('is memoised per (call graph, entry points) pair', () => {
      const index = indexSymbols([fn('a'), fn('b')])
      const graph = deriveCallGraph([calls('a', 'b')], index)
      const entries = deriveEntryPoints(graph, index)
      expect(deriveDominators(graph, entries)).toBe(deriveDominators(graph, entries))
    })
  })
})
