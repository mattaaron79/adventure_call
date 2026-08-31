import { describe, expect, it } from 'vitest'
import { fileFacts, matchFile, parseQuery } from './query'
import type { GraphNode } from './types'

function symbol(overrides: Partial<GraphNode>): GraphNode {
  return {
    id: 'sym',
    symbol_id: 'sym',
    name: 'sym',
    kind: 'function',
    file_path: 'src/app.py',
    module: 'app',
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

const MODULE = symbol({
  id: 'app',
  name: 'app',
  kind: 'module',
  docstring: 'Utilities for the agent loop.',
})

const FACTS = fileFacts(MODULE, [
  symbol({ id: 'app.step', name: 'step', signature: 'def step(self, n: int) -> bool' }),
  symbol({
    id: 'app.Agent',
    name: 'Agent',
    kind: 'class',
    docstring: 'Drives the loop.',
    decorators: ['@dataclass'],
    bases: ['BasePlugin'],
  }),
])

describe('parseQuery', () => {
  it('parses blank input as the empty query', () => {
    expect(parseQuery('')).toEqual({ kind: 'empty' })
    expect(parseQuery('   ')).toEqual({ kind: 'empty' })
  })

  it('parses plain text as a case-insensitive path substring', () => {
    const query = parseQuery('Loop')
    expect(query).toEqual({ kind: 'text', text: 'loop', all: false })
  })

  it('parses r: as a case-insensitive regex on the path', () => {
    const query = parseQuery('r:loop\\.py$')
    expect(query.kind).toBe('regex')
    if (query.kind !== 'regex') return
    expect(query.source).toBe('loop\\.py$')
    expect(query.all).toBe(false)
    expect(query.re.flags).toContain('i')
  })

  it('parses > as an all-properties text query', () => {
    const query = parseQuery('>agent')
    expect(query).toEqual({ kind: 'text', text: 'agent', all: true })
  })

  it('parses >r: as an all-properties regex query', () => {
    const query = parseQuery('>r:^def step')
    expect(query.kind).toBe('regex')
    if (query.kind !== 'regex') return
    expect(query.source).toBe('^def step')
    expect(query.all).toBe(true)
  })

  it('treats anything else as literal text, including stray prefixes', () => {
    expect(parseQuery('r')).toEqual({ kind: 'text', text: 'r', all: false })
    expect(parseQuery('xr:foo')).toEqual({ kind: 'text', text: 'xr:foo', all: false })
    expect(parseQuery('>')).toEqual({ kind: 'text', text: '', all: true })
    expect(parseQuery('a>r:b')).toEqual({ kind: 'text', text: 'a>r:b', all: false })
  })

  it('reports an invalid regex as an error instead of throwing', () => {
    const query = parseQuery('r:foo(')
    expect(query.kind).toBe('error')
    if (query.kind !== 'error') return
    expect(query.message).toBeTruthy()
    expect(parseQuery('>r:[a-').kind).toBe('error')
  })
})

describe('matchFile', () => {
  it('matches everything for the empty query and nothing for an error', () => {
    expect(matchFile(parseQuery(''), FACTS)).toBe(true)
    expect(matchFile(parseQuery('r:('), FACTS)).toBe(false)
  })

  it('matches plain text against the path only', () => {
    expect(matchFile(parseQuery('app.py'), FACTS)).toBe(true)
    expect(matchFile(parseQuery('APP'), FACTS)).toBe(true)
    // 'loop' appears in the module docstring and a symbol, but not the path.
    expect(matchFile(parseQuery('loop'), FACTS)).toBe(false)
  })

  it('matches r: as a regex against the path', () => {
    expect(matchFile(parseQuery('r:^src/'), FACTS)).toBe(true)
    expect(matchFile(parseQuery('r:SRC'), FACTS)).toBe(true) // case-insensitive
    expect(matchFile(parseQuery('r:^def step'), FACTS)).toBe(false)
  })

  it('matches > text through any symbol property', () => {
    expect(matchFile(parseQuery('>loop'), FACTS)).toBe(true) // module docstring
    expect(matchFile(parseQuery('>step'), FACTS)).toBe(true) // symbol name
    expect(matchFile(parseQuery('>def step(self'), FACTS)).toBe(true) // signature
    expect(matchFile(parseQuery('>drives'), FACTS)).toBe(true) // symbol docstring
    expect(matchFile(parseQuery('>dataclass'), FACTS)).toBe(true) // decorator
    expect(matchFile(parseQuery('>baseplugin'), FACTS)).toBe(true) // base, case-insensitive
    expect(matchFile(parseQuery('>nope'), FACTS)).toBe(false)
  })

  it('matches >r: as a regex across all properties', () => {
    expect(matchFile(parseQuery('>r:^def step\\('), FACTS)).toBe(true)
    expect(matchFile(parseQuery('>r:Drives the'), FACTS)).toBe(true)
    expect(matchFile(parseQuery('>r:^src/'), FACTS)).toBe(true)
    expect(matchFile(parseQuery('>r:('), FACTS)).toBe(false) // invalid regex
  })

  it('does not widen a path-only query into symbol properties', () => {
    expect(matchFile(parseQuery('r:loop'), FACTS)).toBe(false)
  })
})

describe('fileFacts', () => {
  it('normalises the path and carries the searched properties', () => {
    const facts = fileFacts(
      symbol({ id: 'm', kind: 'module', file_path: 'src\\app\\loop.py', docstring: 'doc' }),
      [symbol({ id: 'm.f', name: 'f', signature: 'f()', docstring: 'd', decorators: ['@x'], bases: ['B'] })],
    )
    expect(facts.path).toBe('src/app/loop.py')
    expect(facts.docstring).toBe('doc')
    expect(facts.symbols).toEqual([
      { name: 'f', signature: 'f()', docstring: 'd', decorators: ['@x'], bases: ['B'] },
    ])
  })
})
