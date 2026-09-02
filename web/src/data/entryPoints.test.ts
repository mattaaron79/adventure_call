import { describe, expect, it } from 'vitest'
import { deriveCallGraph, deriveReferences, indexSymbols } from './derive'
import { deriveEntryPoints } from './entryPoints'
import type { RoleRule } from './roles'
import type { GraphEdge, GraphNode, SymbolKind } from './types'

function node(
  id: string,
  kind: SymbolKind,
  overrides: Partial<GraphNode> = {},
): GraphNode {
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

function classify(nodes: GraphNode[], edges: GraphEdge[] = [], rules?: readonly RoleRule[]) {
  const index = indexSymbols(nodes)
  return deriveEntryPoints(deriveCallGraph(edges, index), index, rules)
}

describe('deriveEntryPoints', () => {
  it('calls a symbol with an in-project caller internal', () => {
    const points = classify([fn('a'), fn('b')], [calls('a', 'b')])
    expect(points.roleOf.get('b')?.role).toBe('internal')
    expect(points.entries).not.toContain('b')
  })

  it('calls an uncalled function that calls things an entry', () => {
    const points = classify([fn('a'), fn('b')], [calls('a', 'b')])
    expect(points.roleOf.get('a')?.role).toBe('entry')
    expect(points.roleOf.get('a')?.framework).toBeNull()
    expect(points.entries).toContain('a')
  })

  it('calls a symbol with no callers, no callees and no explanation an orphan', () => {
    const points = classify([fn('lonely')])
    expect(points.roleOf.get('lonely')?.role).toBe('orphan')
    expect(points.orphans).toEqual(['lonely'])
    expect(points.entries).toEqual([])
  })

  it('rescues a decorated function from looking orphaned', () => {
    const points = classify([fn('handler', { decorators: ['@on(Button.Pressed)'] })])
    const role = points.roleOf.get('handler')
    expect(role?.role).toBe('framework-entry')
    expect(role?.framework).toBe('handler')
    expect(role?.reason).toBe('decorator @on')
    expect(points.orphans).toEqual([])
    expect(points.entries).toEqual(['handler'])
    expect(points.rescued).toBe(1)
  })

  it('rescues a test function, which is collected by name rather than decorator', () => {
    const points = classify([
      fn('test_it', { file_path: 'tests/test_it.py', module: 'tests.test_it' }),
    ])
    expect(points.roleOf.get('test_it')?.role).toBe('framework-entry')
    expect(points.roleOf.get('test_it')?.framework).toBe('test')
  })

  it('falls through to plain in-degree logic for an unknown decorator', () => {
    // The whole point of the map being extensible: a decorator it has never
    // heard of must not silently rescue anything.
    const points = classify([fn('measure', { decorators: ['@metric("bleed")'] })])
    expect(points.roleOf.get('measure')?.role).toBe('orphan')
    expect(points.roleOf.get('measure')?.framework).toBeNull()
    expect(points.rescued).toBe(0)
  })

  it('honours a caller-supplied rule list instead of the defaults', () => {
    const rules: RoleRule[] = [{ role: 'plugin', decorator: 'metric' }]
    const points = classify([fn('measure', { decorators: ['@metric("bleed")'] })], [], rules)
    expect(points.roleOf.get('measure')?.role).toBe('framework-entry')
    expect(points.roleOf.get('measure')?.framework).toBe('plugin')
  })

  it('keeps a framework role on a symbol the project also calls', () => {
    // Being a @property stays true and worth showing even when something in
    // the project calls it directly -- but it is reached internally, so the
    // ROLE is internal and it is not nominated as a root.
    const points = classify(
      [fn('caller'), fn('value', { decorators: ['@property'] })],
      [calls('caller', 'value')],
    )
    const role = points.roleOf.get('value')
    expect(role?.role).toBe('internal')
    expect(role?.framework).toBe('property')
    expect(points.entries).not.toContain('value')
  })

  it('does not nominate every constructor as an entry point', () => {
    // The derived class -> __init__ edge counts as a caller: constructing the
    // class really does reach __init__.
    const nodes = [
      fn('caller'),
      node('Foo', 'class'),
      node('Foo.__init__', 'method', { parent: 'Foo', name: '__init__' }),
    ]
    const points = classify(nodes, [calls('caller', 'Foo')])
    expect(points.roleOf.get('Foo.__init__')?.role).toBe('internal')
    expect(points.entries).not.toContain('Foo.__init__')
  })

  it('classifies every node of the call graph', () => {
    const nodes = [fn('a'), fn('b'), fn('lonely')]
    const points = classify(nodes, [calls('a', 'b')])
    const index = indexSymbols(nodes)
    for (const id of deriveCallGraph([calls('a', 'b')], index).nodes) {
      expect(points.roleOf.has(id)).toBe(true)
    }
  })

  it('counts only rule-rescued symbols in `rescued`', () => {
    const points = classify([
      fn('decorated', { decorators: ['@property'] }),
      fn('plain'),
      fn('root'),
      fn('called'),
    ], [calls('root', 'called')])
    expect(points.rescued).toBe(1)
    expect([...points.entries].sort()).toEqual(['decorated', 'root'])
    expect(points.orphans).toEqual(['plain'])
  })

  it('memoises per (callGraph, rules) pair', () => {
    const nodes = [fn('a')]
    const index = indexSymbols(nodes)
    const graph = deriveCallGraph([], index)
    expect(deriveEntryPoints(graph, index)).toBe(deriveEntryPoints(graph, index))

    const rules: RoleRule[] = [{ role: 'x', decorator: 'y' }]
    expect(deriveEntryPoints(graph, index, rules)).not.toBe(deriveEntryPoints(graph, index))
    expect(deriveEntryPoints(graph, index, rules)).toBe(deriveEntryPoints(graph, index, rules))
  })
})

describe('deriveEntryPoints and self-recursion (tic-d8a8)', () => {
  it('does not treat a self-call as something reaching the function', () => {
    // A directly recursive function is its own caller in the graph. Counting
    // that would classify a recursive root as `internal` and drop it from the
    // entry set -- which is exactly how mode 3 failed to draw one.
    const points = classify([fn('recurse'), fn('helper')], [
      calls('recurse', 'recurse'),
      calls('recurse', 'helper'),
    ])
    expect(points.roleOf.get('recurse')?.role).toBe('entry')
    expect(points.entries).toContain('recurse')
  })

  it('calls a function that only ever calls itself an orphan, not an entry', () => {
    // It heads no flow: nothing reaches it and it reaches nothing.
    const points = classify([fn('spin')], [calls('spin', 'spin')])
    expect(points.roleOf.get('spin')?.role).toBe('orphan')
    expect(points.orphans).toEqual(['spin'])
  })

  it('still counts a real caller of a recursive function', () => {
    const points = classify([fn('caller'), fn('recurse')], [
      calls('caller', 'recurse'),
      calls('recurse', 'recurse'),
    ])
    expect(points.roleOf.get('recurse')?.role).toBe('internal')
  })
})


// -- references (tic-89fa) --------------------------------------------------

function references(source: string, target: string): GraphEdge {
  return {
    source,
    target,
    type: 'REFERENCES',
    types: ['REFERENCES'],
    count: 1,
    lines: [1],
    confidence: 'exact',
    call_types: [],
    aliases: [],
  } as GraphEdge
}

describe('deriveReferences (tic-89fa)', () => {
  const NODES = [fn('m.urls'), fn('m.home'), fn('m.detail')]
  const index = indexSymbols(NODES)

  it('indexes who names each callable', () => {
    const edges = [references('m.urls', 'm.home'), references('m.urls', 'm.detail')]
    const derived = deriveReferences(edges, index)
    expect(derived.referrers.get('m.home')).toEqual(['m.urls'])
    expect(derived.referrers.get('m.detail')).toEqual(['m.urls'])
  })

  it('lists each referrer once however many times it names the target', () => {
    const edges = [references('m.urls', 'm.home'), references('m.urls', 'm.home')]
    expect(deriveReferences(edges, index).referrers.get('m.home')).toEqual(['m.urls'])
  })

  it('ignores CALLS edges, which are a different claim entirely', () => {
    expect(deriveReferences([calls('m.urls', 'm.home')], index).referrers.size).toBe(0)
  })

  it('drops an edge whose end the excludes or the file query removed', () => {
    // The same guard every derivation here applies; its absence crashed elk
    // in tic-56b2.
    const edges = [references('m.urls', 'm.gone'), references('m.vanished', 'm.home')]
    expect(deriveReferences(edges, index).referrers.size).toBe(0)
  })

  it('drops a self-reference, which says nothing', () => {
    expect(deriveReferences([references('m.home', 'm.home')], index).referrers.size).toBe(0)
  })

  it('is memoised per (edges, index) pair', () => {
    const edges = [references('m.urls', 'm.home')]
    expect(deriveReferences(edges, index)).toBe(deriveReferences(edges, index))
  })
})

describe('entry points and references (tic-89fa)', () => {
  const NODES = [fn('m.urls'), fn('m.home'), fn('m.lonely'), fn('m.helper')]
  const index = indexSymbols(NODES)
  const CALL_EDGES = [calls('m.urls', 'm.helper')]
  const graph = deriveCallGraph(CALL_EDGES, index)

  it('calls a named-but-uncalled function `referenced`, not an orphan', () => {
    // Django's URLconf: nothing CALLS the view, and it calls nothing itself,
    // so before this it was indistinguishable from dead code.
    const refs = deriveReferences([references('m.urls', 'm.home')], index)
    const points = deriveEntryPoints(graph, index, undefined, refs)
    expect(points.roleOf.get('m.home')!.role).toBe('referenced')
    expect(points.entries).toContain('m.home')
    expect(points.orphans).not.toContain('m.home')
  })

  it('leaves a function nothing names an orphan', () => {
    const refs = deriveReferences([references('m.urls', 'm.home')], index)
    const points = deriveEntryPoints(graph, index, undefined, refs)
    expect(points.roleOf.get('m.lonely')!.role).toBe('orphan')
  })

  it('says who named it, so a UI can explain rather than assert', () => {
    const refs = deriveReferences([references('m.urls', 'm.home')], index)
    const points = deriveEntryPoints(graph, index, undefined, refs)
    expect(points.roleOf.get('m.home')!.reason).toBe('named by urls')
  })

  it('names two referrers, and counts beyond that', () => {
    const edges = [
      references('m.urls', 'm.home'),
      references('m.lonely', 'm.home'),
      references('m.helper', 'm.home'),
    ]
    const refs = deriveReferences(edges, index)
    const points = deriveEntryPoints(graph, index, undefined, refs)
    expect(points.roleOf.get('m.home')!.reason).toBe('named by urls and 2 others')
  })

  it('lets a CALL outrank a reference, because a call is the stronger fact', () => {
    const refs = deriveReferences([references('m.urls', 'm.helper')], index)
    const points = deriveEntryPoints(graph, index, undefined, refs)
    expect(points.roleOf.get('m.helper')!.role).toBe('internal')
  })

  it('lets a role RULE outrank a reference, because it names the mechanism', () => {
    // A rule says "the framework calls this"; a reference only says "this
    // code hands it somewhere".  Both are evidence; the rule is specific.
    const rules: RoleRule[] = [{ role: 'route', name: '^home$' }]
    const refs = deriveReferences([references('m.urls', 'm.home')], index)
    const points = deriveEntryPoints(graph, index, rules, refs)
    expect(points.roleOf.get('m.home')!.role).toBe('framework-entry')
  })

  it('behaves exactly as before when no reference data is supplied', () => {
    const points = deriveEntryPoints(graph, index)
    expect(points.roleOf.get('m.home')!.role).toBe('orphan')
    expect(points.orphans).toContain('m.home')
  })

  it('counts a reference among the rescues, since that is what it is', () => {
    const refs = deriveReferences([references('m.urls', 'm.home')], index)
    expect(deriveEntryPoints(graph, index, undefined, refs).rescued).toBe(1)
  })

  it('memoises per reference index as well as per rule list', () => {
    const refs = deriveReferences([references('m.urls', 'm.home')], index)
    expect(deriveEntryPoints(graph, index, undefined, refs)).toBe(
      deriveEntryPoints(graph, index, undefined, refs),
    )
    expect(deriveEntryPoints(graph, index, undefined, refs)).not.toBe(
      deriveEntryPoints(graph, index),
    )
  })
})
