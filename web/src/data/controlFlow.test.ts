/**
 * Control-flow tags (tic-5069).
 *
 * The vocabulary is the point as much as the arithmetic: every assertion here
 * is about a claim the data supports, and `unguarded` never means "always".
 */
import { describe, expect, it } from 'vitest'
import { deriveWorkspace } from './derive'
import {
  deriveControlFlowTags,
  edgeKey,
  edgeTagsOf,
  type EdgeTags,
} from './controlFlow'
import type { CodebaseGraph, GraphEdge, GraphNode, SymbolKind } from './types'

function node(id: string, kind: SymbolKind, overrides: Partial<GraphNode> = {}): GraphNode {
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

function calls(source: string, target: string, controls: string[][]): GraphEdge {
  return {
    source,
    target,
    type: 'CALLS',
    types: ['CALLS'],
    count: controls.length,
    lines: controls.map((_, i) => i + 1),
    confidence: 'exact',
    call_types: [],
    aliases: [],
    controls,
  } as GraphEdge
}

function workspaceOf(nodes: GraphNode[], edges: GraphEdge[]) {
  const graph: CodebaseGraph = {
    directed: true,
    multigraph: false,
    graph: {
      schema_version: 3,
      generated_at: '',
      root: '',
      stats: {} as CodebaseGraph['graph']['stats'],
    },
    nodes,
    edges,
  }
  return deriveWorkspace(graph, [])
}

const tags = (controls: string[][]): EdgeTags => edgeTagsOf(controls)!

describe('edgeTagsOf', () => {
  it('calls an edge unguarded when nothing could skip any of its sites', () => {
    expect(tags([[], []]).guard).toBe('unguarded')
  })

  it('calls it guarded when every site sits inside something that could skip it', () => {
    expect(tags([['if'], ['for']]).guard).toBe('guarded')
  })

  it('calls it mixed when the same pair is reached both ways', () => {
    // The case the ticket cared most about -- and, measured, the rarest:
    // 2.2% of carnot's edges and 1.5% of hypermenu's.
    expect(tags([[], ['if']]).guard).toBe('mixed')
  })

  it('does not treat a with, a try body or a finally as a guard', () => {
    // Reaching them runs them.  Only a construct that can SKIP the call
    // counts, which is why a loop body does and these do not.
    expect(tags([['with'], ['try'], ['try:finally']]).guard).toBe('unguarded')
  })

  it('treats a loop body as a guard, because it may iterate zero times', () => {
    expect(tags([['for']]).guard).toBe('guarded')
    expect(tags([['while']]).guard).toBe('guarded')
  })

  it('separates "can fire twice" from "always fires in a loop"', () => {
    // `looped` is a claim about what can happen, so one site is enough;
    // `allLooped` is a claim about every site, and feeds the `hot` roll-up.
    const some = tags([['for'], []])
    expect([some.looped, some.allLooped]).toEqual([true, false])
    const all = tags([['for'], ['while']])
    expect([all.looped, all.allLooped]).toEqual([true, true])
  })

  it('counts a while test as a loop position but not as a guarded one', () => {
    // It runs whenever the loop is reached, and again per iteration.
    const tag = tags([['while:test']])
    expect([tag.guard, tag.looped]).toEqual(['unguarded', true])
  })

  it('calls an edge error-path only when EVERY site is on one', () => {
    expect(tags([['try:except'], ['try:finally']]).errorPath).toBe(true)
    expect(tags([['try:except'], []]).errorPath).toBe(false)
  })

  it('calls an edge type-checking-only when every site is under TYPE_CHECKING', () => {
    // Correct, and measured at ZERO on both codebases: `if TYPE_CHECKING`
    // guards imports, not calls.  tic-23eb should not spend budget on it.
    expect(tags([['type-checking']]).typeCheckingOnly).toBe(true)
    expect(tags([['type-checking'], ['if']]).typeCheckingOnly).toBe(false)
  })

  it('counts the sites behind the edge', () => {
    expect(tags([[], ['if'], ['for']]).sites).toBe(3)
  })

  it('refuses to tag an edge with no call sites behind it', () => {
    // The implicit `class -> __init__` edge, or a pre-v3 export.  There is no
    // honest tag for a call that was never made.
    expect(edgeTagsOf(undefined)).toBeNull()
    expect(edgeTagsOf([])).toBeNull()
  })
})

describe('deriveControlFlowTags', () => {
  const NODES = [
    node('m', 'module', { module: 'm', file_path: 'm.py' }),
    node('m.caller', 'function'),
    node('m.other', 'function'),
    node('m.always', 'function'),
    node('m.rescue', 'function'),
    node('m.inner', 'function'),
    node('m.lonely', 'function'),
  ]

  const workspace = workspaceOf(NODES, [
    calls('m.caller', 'm.always', [[]]),
    calls('m.caller', 'm.rescue', [['try:except']]),
    calls('m.other', 'm.rescue', [['try:except'], ['try:finally']]),
    calls('m.caller', 'm.inner', [['for']]),
    calls('m.other', 'm.inner', [['while'], ['comprehension']]),
  ])
  const derived = deriveControlFlowTags(workspace.callGraph)

  it('keys edge tags by the pair they belong to', () => {
    expect(derived.edgeOf.get(edgeKey('m.caller', 'm.always'))!.guard).toBe('unguarded')
    expect(derived.edgeOf.get(edgeKey('m.other', 'm.rescue'))!.sites).toBe(2)
  })

  it('finds an error handler by its wiring rather than by its name', () => {
    // On carnot this picked out _repair_json, _loose_load and PluginError --
    // the error-recovery layer, identified without reading a single name.
    expect(derived.nodeOf.get('m.rescue')!.errorHandler).toBe(true)
    expect(derived.nodeOf.get('m.always')!.errorHandler).toBe(false)
  })

  it('calls a function hot only when every call site is in a loop', () => {
    expect(derived.nodeOf.get('m.inner')!.hot).toBe(true)
    expect(derived.nodeOf.get('m.always')!.hot).toBe(false)
  })

  it('is not fooled by an edge that is only SOMETIMES in a loop', () => {
    // The distinction `allLooped` exists for.  Rolling `hot` up from `looped`
    // instead lets an edge with one looped site and one ordinary one vote
    // yes, which on carnot was the difference between 83 hot functions and
    // 97 -- and the 14 extra ones are simply not hot.
    const sometimes = deriveControlFlowTags(
      workspaceOf(NODES, [calls('m.caller', 'm.inner', [['for'], []])]).callGraph,
    )
    expect(sometimes.edgeOf.get(edgeKey('m.caller', 'm.inner'))!.looped).toBe(true)
    expect(sometimes.nodeOf.get('m.inner')!.hot).toBe(false)
  })

  it('lets one ordinary caller sink a roll-up', () => {
    const mixed = deriveControlFlowTags(
      workspaceOf(NODES, [
        calls('m.caller', 'm.rescue', [['try:except']]),
        calls('m.other', 'm.rescue', [[]]),
      ]).callGraph,
    )
    expect(mixed.nodeOf.get('m.rescue')!.errorHandler).toBe(false)
  })

  it('says nothing at all about a symbol nothing calls', () => {
    // "Every one of no callers is an error handler" is a vacuous truth, and
    // reporting it as a finding is the mistake `testOnly` avoids elsewhere.
    expect(derived.nodeOf.has('m.lonely')).toBe(false)
    expect(derived.nodeOf.has('m.caller')).toBe(false)
  })

  it('counts the callers a roll-up is built from', () => {
    expect(derived.nodeOf.get('m.rescue')!.callers).toBe(2)
  })

  it('marks a symbol no caller ever reaches unguarded', () => {
    expect(derived.nodeOf.get('m.inner')!.alwaysGuarded).toBe(true)
    expect(derived.nodeOf.get('m.always')!.alwaysGuarded).toBe(false)
  })

  it('is memoised on the call graph', () => {
    expect(deriveControlFlowTags(workspace.callGraph)).toBe(derived)
  })

  it('survives an export whose edges carry no breadcrumbs at all', () => {
    const bare = workspaceOf(NODES, [
      { ...calls('m.caller', 'm.always', [[]]), controls: undefined } as GraphEdge,
    ])
    const empty = deriveControlFlowTags(bare.callGraph)
    expect(empty.edgeOf.size).toBe(0)
    expect(empty.nodeOf.size).toBe(0)
  })
})

describe('certain (tic-3a20)', () => {
  it('is true only when every site behind the edge is', () => {
    // The same rule as `allLooped`, for the same reason: letting one certain
    // site vote for three uncertain ones would restate the very claim the CFG
    // exists to replace.
    expect(edgeTagsOf([[], []], [true, true])!.certain).toBe(true)
    expect(edgeTagsOf([[], []], [true, false])!.certain).toBe(false)
    expect(edgeTagsOf([[], []], [false, false])!.certain).toBe(false)
  })

  it('is null on an export that could not say, which is not false', () => {
    // A pre-v9 export carries no `certains`.  A UI reading that as "no" would
    // report every call in the codebase as avoidable.
    expect(edgeTagsOf([[], []])!.certain).toBeNull()
    expect(edgeTagsOf([[], []], [])!.certain).toBeNull()
  })

  it('is a strictly stronger claim than unguarded', () => {
    // An early `return` above a call leaves it unguarded and not certain,
    // which is the 27% of ../carnot's unguarded sites this exists for.
    const tags = edgeTagsOf([[]], [false])!
    expect(tags.guard).toBe('unguarded')
    expect(tags.certain).toBe(false)
  })

  it('never claims certainty for a guarded call', () => {
    expect(edgeTagsOf([['if']], [false])!.certain).toBe(false)
  })
})
