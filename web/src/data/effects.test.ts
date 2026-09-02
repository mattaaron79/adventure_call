import { describe, expect, it } from 'vitest'
import { deriveCallGraph, indexSymbols } from './derive'
import {
  DEFAULT_EFFECT_RULES,
  deriveEffects,
  effectsForTarget,
  type EffectRule,
} from './effects'
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

function external(callerId: string, target: string): UnresolvedCall {
  return {
    caller_id: callerId,
    raw_name: target,
    line: 1,
    callee_id: null,
    confidence: 'unresolved',
    call_type: 'call',
    reason: `external: ${target}`,
    file_path: 'src/app/thing.py',
  }
}

function registry(unresolved: UnresolvedCall[]): SymbolRegistry {
  return {
    schema_version: 1,
    generated_at: '',
    root: '.',
    includes_source: false,
    stats: {
      files: 1,
      files_with_diagnostics: 0,
      symbols: 0,
      nodes: 0,
      edges: 0,
      node_kinds: {},
      edge_types: {},
      calls_resolved: 0,
      calls_heuristic: 0,
      calls_unresolved: unresolved.length,
      calls_builtin: 0,
      diagnostics: 0,
    },
    symbols: {},
    modules: {},
    bindings: {},
    unresolved_calls: unresolved,
    diagnostics: [],
  }
}

function build(nodes: GraphNode[], edges: GraphEdge[]) {
  const index = indexSymbols(nodes)
  return deriveCallGraph(edges, index)
}

describe('effectsForTarget', () => {
  it('matches a bare module target and its dotted children', () => {
    expect(effectsForTarget('subprocess')).toEqual(['process'])
    expect(effectsForTarget('subprocess.run')).toEqual(['process'])
  })

  it('does not match a target that merely starts with the same text', () => {
    expect(effectsForTarget('subprocess_only')).toEqual([])
    expect(effectsForTarget('timeless.util')).toEqual([])
  })

  it('matches a dotted rule only at its own depth', () => {
    // `os.environ` fires; plain `os` does not, because `os.path.join` is pure.
    expect(effectsForTarget('os.environ')).toEqual(['env'])
    expect(effectsForTarget('os')).toEqual([])
    expect(effectsForTarget('os.path')).toEqual([])
  })

  it('unions every matching rule, in canonical kind order', () => {
    const rules: EffectRule[] = [
      { target: 'db', kinds: ['nondeterminism', 'filesystem'] },
      { target: 'db.execute', kinds: ['network'] },
    ]
    expect(effectsForTarget('db.execute', rules)).toEqual([
      'filesystem',
      'network',
      'nondeterminism',
    ])
  })

  it('matches nothing under an empty rule list', () => {
    expect(effectsForTarget('subprocess', [])).toEqual([])
  })
})

describe('deriveEffects', () => {
  it('records a function’s own direct effects', () => {
    const graph = build([fn('m.save')], [])
    const effects = deriveEffects(graph, registry([external('m.save', 'pathlib.Path')]))
    expect(effects.effectsOf.get('m.save')).toEqual(['filesystem'])
    expect(effects.probablyPure).toEqual([])
  })

  it('propagates one hop: a caller inherits its callee’s effects', () => {
    const graph = build([fn('m.top'), fn('m.save')], [calls('m.top', 'm.save')])
    const effects = deriveEffects(graph, registry([external('m.save', 'httpx')]))
    expect(effects.effectsOf.get('m.save')).toEqual(['network'])
    expect(effects.effectsOf.get('m.top')).toEqual(['network'])
    expect(effects.probablyPure).toEqual([])
  })

  it('propagates multiple hops and unions sibling branches', () => {
    // top -> left -> httpx, top -> right -> time.  top touches both.
    const graph = build(
      [fn('m.top'), fn('m.left'), fn('m.right')],
      [calls('m.top', 'm.left'), calls('m.top', 'm.right')],
    )
    const effects = deriveEffects(
      graph,
      registry([external('m.left', 'httpx'), external('m.right', 'time')]),
    )
    expect(effects.effectsOf.get('m.left')).toEqual(['network'])
    expect(effects.effectsOf.get('m.right')).toEqual(['nondeterminism'])
    expect(effects.effectsOf.get('m.top')).toEqual(['network', 'nondeterminism'])
  })

  it('gives every member of a cyclic component the shared effect set', () => {
    // root -> ping <-> pong -> save(pathlib).  ping and pong are mutually
    // recursive, so each genuinely reaches everything the other can; both
    // carry the filesystem effect, and root inherits it through the knot.
    const graph = build(
      [fn('m.root'), fn('m.ping'), fn('m.pong'), fn('m.save')],
      [
        calls('m.root', 'm.ping'),
        calls('m.ping', 'm.pong'),
        calls('m.pong', 'm.ping'),
        calls('m.pong', 'm.save'),
      ],
    )
    const effects = deriveEffects(graph, registry([external('m.save', 'pathlib.Path')]))
    expect(effects.effectsOf.get('m.ping')).toEqual(['filesystem'])
    expect(effects.effectsOf.get('m.pong')).toEqual(['filesystem'])
    expect(effects.effectsOf.get('m.root')).toEqual(['filesystem'])
    expect(effects.probablyPure).toEqual([])
  })

  it('calls a genuinely pure leaf probably pure', () => {
    // A leaf with no external calls and no callees: nothing known touches I/O.
    const graph = build([fn('m.add')], [])
    const effects = deriveEffects(graph, registry([external('m.other', 'httpx')]))
    expect(effects.effectsOf.get('m.add')).toEqual([])
    expect(effects.probablyPure).toEqual(['m.add'])
  })

  it('keeps a caller pure when its only external call matches no rule', () => {
    const graph = build([fn('m.mathy')], [])
    const effects = deriveEffects(graph, registry([external('m.mathy', 'math')]))
    expect(effects.effectsOf.get('m.mathy')).toEqual([])
    expect(effects.probablyPure).toEqual(['m.mathy'])
  })

  it('drops external calls from callers that are not call-graph nodes', () => {
    const graph = build([fn('m.kept')], [])
    const effects = deriveEffects(
      graph,
      registry([external('m.excluded', 'httpx'), external('m.kept', 'subprocess')]),
    )
    expect(effects.effectsOf.get('m.kept')).toEqual(['process'])
    expect(effects.probablyPure).toEqual([])
  })

  it('is vacuously all-pure without a registry, and stays honest about it', () => {
    const graph = build([fn('m.a'), fn('m.b')], [calls('m.a', 'm.b')])
    const effects = deriveEffects(graph, null)
    expect(effects.probablyPure).toEqual(['m.a', 'm.b'])
  })

  it('honours a user-supplied rule list over the defaults', () => {
    const graph = build([fn('m.query')], [])
    const rules: EffectRule[] = [{ target: 'db', kinds: ['network'] }]
    const effects = deriveEffects(graph, registry([external('m.query', 'db.execute')]), rules)
    expect(effects.effectsOf.get('m.query')).toEqual(['network'])
    expect(effects.rules).toBe(rules)
  })

  it('is memoised per (callGraph, registry, rules)', () => {
    const graph = build([fn('m.a')], [])
    const reg = registry([external('m.a', 'httpx')])
    const first = deriveEffects(graph, reg)
    const second = deriveEffects(graph, reg)
    expect(second).toBe(first)
    // A different rule array is a different derivation.
    const custom = deriveEffects(graph, reg, [])
    expect(custom).not.toBe(first)
    expect(custom.probablyPure).toEqual(['m.a'])
  })

  it('orders effects canonically however the call sites arrived', () => {
    const graph = build([fn('m.both')], [])
    const effects = deriveEffects(
      graph,
      registry([external('m.both', 'time'), external('m.both', 'subprocess')]),
    )
    expect(effects.effectsOf.get('m.both')).toEqual(['process', 'nondeterminism'])
  })

  it('includes every default seed target the ticket names', () => {
    const targets = DEFAULT_EFFECT_RULES.map((rule) => rule.target)
    for (const expected of [
      'open',
      'pathlib',
      'subprocess',
      'socket',
      'requests',
      'httpx',
      'os.environ',
      'print',
      'logging',
      'random',
      'time',
      'datetime.now',
    ]) {
      expect(targets).toContain(expected)
    }
  })

  it('treats a self-recursive function like any other component of one', () => {
    // A self-edge is direct recursion, not a cycle: Tarjan's puts the function
    // in a component of one, and its own direct effects stay its own.
    const graph = build([fn('m.spin')], [calls('m.spin', 'm.spin')])
    const effects = deriveEffects(graph, registry([external('m.spin', 'random')]))
    expect(effects.effectsOf.get('m.spin')).toEqual(['nondeterminism'])
  })
})
