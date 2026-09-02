import { describe, expect, it } from 'vitest'
import { indexSymbols } from './derive'
import {
  deriveTypeFlow,
  normaliseAnnotation,
  resolveTypeName,
  typesOf,
} from './typeFlow'
import type { GraphNode, Param, SymbolKind, SymbolRegistry } from './types'

function node(id: string, kind: SymbolKind, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    symbol_id: id,
    name: id.split('.').pop()!,
    kind,
    file_path: 'm.py',
    module: id.split('.').slice(0, -1).join('.') || 'm',
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

const param = (name: string, annotation: string | null): Param =>
  ({ name, annotation, kind: 'positional', default: null }) as Param

describe('normaliseAnnotation (tic-59b1)', () => {
  it('keeps a bare name', () => {
    expect(normaliseAnnotation('ToolResult')).toEqual(['ToolResult'])
  })

  it('strips Optional and a PEP 604 None alike', () => {
    expect(normaliseAnnotation('Optional[ToolResult]')).toEqual(['ToolResult'])
    expect(normaliseAnnotation('ToolResult | None')).toEqual(['ToolResult'])
  })

  it('keeps BOTH members of a union, because either can flow', () => {
    expect(normaliseAnnotation('Union[A, B]')).toEqual(['A', 'B'])
    expect(normaliseAnnotation('A | B | None')).toEqual(['A', 'B'])
  })

  it('unwraps a container to its arguments', () => {
    expect(normaliseAnnotation('list[ToolResult]')).toEqual(['ToolResult'])
    expect(normaliseAnnotation('Sequence[ToolResult]')).toEqual(['ToolResult'])
  })

  it('takes ALL of a mapping arguments rather than guessing which is the payload', () => {
    // `str` costs nothing: it resolves to no project class and is dropped a
    // step later, whereas picking "the" element type would be a guess.
    expect(normaliseAnnotation('dict[str, ToolResult]')).toEqual(['str', 'ToolResult'])
  })

  it('unwraps a nested generic', () => {
    expect(normaliseAnnotation('list[Optional[ToolResult]]')).toEqual(['ToolResult'])
    expect(normaliseAnnotation('dict[str, list[Result]]')).toEqual(['str', 'Result'])
  })

  it('drops the quotes from a forward reference', () => {
    expect(normaliseAnnotation('"ToolResult"')).toEqual(['ToolResult'])
    expect(normaliseAnnotation("'ToolResult'")).toEqual(['ToolResult'])
    // The quotes have to come off BEFORE the generic is unwrapped, or the
    // bracket is never found and the whole annotation reads as one name.
    expect(normaliseAnnotation('"list[ToolResult]"')).toEqual(['ToolResult'])
  })

  it('keeps only the last segment of a dotted name', () => {
    // Which is what a module's import bindings are keyed by.
    expect(normaliseAnnotation('types.ToolResult')).toEqual(['ToolResult'])
    expect(normaliseAnnotation('Sequence[a.b.ToolResult]')).toEqual(['ToolResult'])
  })

  it('keeps the head of a generic it does not know', () => {
    // `Result[int]` is a Result; its arguments are the project's business.
    expect(normaliseAnnotation('Result[int]')).toEqual(['Result'])
  })

  it('yields nothing for an annotation that carries no type', () => {
    expect(normaliseAnnotation('None')).toEqual([])
    expect(normaliseAnnotation('Any')).toEqual([])
    expect(normaliseAnnotation(null)).toEqual([])
    expect(normaliseAnnotation('')).toEqual([])
  })

  it('splits a union only at the top level', () => {
    // `dict[str | int, X]` must not split into `dict[str` and `int, X]`.
    expect(normaliseAnnotation('dict[str | int, Result]')).toEqual(['str', 'int', 'Result'])
  })

  it('survives a tuple ellipsis and a Callable', () => {
    expect(normaliseAnnotation('tuple[int, ...]')).toEqual(['int'])
    expect(normaliseAnnotation('Callable[[int], str]')).toEqual(['Callable'])
  })
})

describe('resolveTypeName (tic-59b1)', () => {
  const NODES = [
    node('app.types.ToolResult', 'class'),
    node('app.types.helper', 'function'),
    node('app.use.run', 'function'),
    node('app.use.Local', 'class'),
  ]
  const index = indexSymbols(NODES)
  const registry = {
    bindings: {
      'app.use': {
        ToolResult: { alias: 'ToolResult', kind: 'symbol', target: 'app.types.ToolResult' },
      },
    },
  } as unknown as SymbolRegistry

  it('finds a class defined in the same module', () => {
    expect(resolveTypeName('Local', 'app.use', index, registry)).toBe('app.use.Local')
  })

  it('follows the module own import binding', () => {
    expect(resolveTypeName('ToolResult', 'app.use', index, registry)).toBe('app.types.ToolResult')
  })

  it('drops a name that resolves to nothing in the project', () => {
    // Builtins, stdlib and third-party types would otherwise link half the
    // codebase to the other half through `str`.
    expect(resolveTypeName('str', 'app.use', index, registry)).toBeNull()
    expect(resolveTypeName('Response', 'app.use', index, registry)).toBeNull()
  })

  it('drops a name that resolves to something that is not a class', () => {
    expect(resolveTypeName('helper', 'app.types', index, registry)).toBeNull()
  })

  it('never searches the whole project for a bare name', () => {
    // `Config` in four modules would resolve to whichever was indexed first,
    // and a wrong link is worse than a missing one.
    expect(resolveTypeName('ToolResult', 'app.other', index, registry)).toBeNull()
  })

  it('works with no registry, on same-module types only', () => {
    expect(resolveTypeName('Local', 'app.use', index, null)).toBe('app.use.Local')
    expect(resolveTypeName('ToolResult', 'app.use', index, null)).toBeNull()
  })

  it('resolves through the normaliser end to end', () => {
    expect(typesOf('list[ToolResult] | None', 'app.use', index, registry)).toEqual([
      'app.types.ToolResult',
    ])
  })
})

describe('deriveTypeFlow (tic-59b1)', () => {
  const NODES = [
    node('app.types.Rule', 'class'),
    node('app.parse.parse', 'function', { returns: 'list[Rule]' }),
    node('app.parse.also', 'function', { returns: 'Rule | None' }),
    node('app.apply.apply', 'function', { params: [param('rule', 'Rule')] }),
    node('app.apply.plain', 'function', { params: [param('n', 'int')] }),
  ]
  const index = indexSymbols(NODES)
  const registry = {
    bindings: {
      'app.parse': { Rule: { alias: 'Rule', kind: 'symbol', target: 'app.types.Rule' } },
      'app.apply': { Rule: { alias: 'Rule', kind: 'symbol', target: 'app.types.Rule' } },
    },
  } as unknown as SymbolRegistry

  it('indexes producers and consumers of a project class', () => {
    const types = deriveTypeFlow(index, registry)
    expect(types.producersOf.get('app.types.Rule')).toEqual(['app.parse.parse', 'app.parse.also'])
    expect(types.consumersOf.get('app.types.Rule')).toEqual(['app.apply.apply'])
  })

  it('indexes the reverse, so a function can name what it handles', () => {
    const types = deriveTypeFlow(index, registry)
    expect(types.returnsOf.get('app.parse.parse')).toEqual(['app.types.Rule'])
    expect(types.acceptsOf.get('app.apply.apply')).toEqual(['app.types.Rule'])
  })

  it('ignores a type the project does not define', () => {
    expect(deriveTypeFlow(index, registry).consumersOf.has('int')).toBe(false)
  })

  it('reports coverage, so a UI need not imply the picture is complete', () => {
    // 1132 of 2578 returns and 1285 of 2801 params on ../carnot: enough to be
    // useful, nowhere near enough to be authoritative.
    const coverage = deriveTypeFlow(index, registry).coverage
    expect(coverage.annotatedReturns).toBe(2)
    expect(coverage.totalReturns).toBe(4)
    expect(coverage.annotatedParams).toBe(2)
    expect(coverage.totalParams).toBe(2)
  })

  it('does not count a receiver as an unannotated parameter', () => {
    // `self` is almost never annotated, so counting it would drag the
    // parameter coverage figure down by one per method and understate how
    // typed the codebase actually is.
    const withSelf = indexSymbols([
      node('app.types.Rule', 'class'),
      node('app.types.Rule.check', 'method', {
        parent: 'app.types.Rule',
        module: 'app.types',
        params: [param('self', null), param('n', 'int')],
      }),
    ])
    const coverage = deriveTypeFlow(withSelf, registry).coverage
    expect(coverage.totalParams).toBe(1)
    expect(coverage.annotatedParams).toBe(1)
  })

  it('does not make a constructor a producer of its own class', () => {
    // `Foo()` reaching `Foo` is already a call edge; type flow earns its keep
    // on the pairs the call graph cannot see.
    const withInit = indexSymbols([
      node('app.types.Rule', 'class'),
      node('app.types.Rule.__init__', 'method', {
        parent: 'app.types.Rule',
        module: 'app.types',
        returns: 'Rule',
      }),
    ])
    expect(deriveTypeFlow(withInit, registry).producersOf.size).toBe(0)
  })

  it('does not make every method of a class a consumer of it', () => {
    const withSelf = indexSymbols([
      node('app.types.Rule', 'class'),
      node('app.types.Rule.check', 'method', {
        parent: 'app.types.Rule',
        module: 'app.types',
        params: [param('self', 'Rule'), param('other', 'Rule')],
      }),
    ])
    // `other: Rule` is a real parameter and still counts; only the receiver
    // is skipped, and it is skipped because a method taking its own class
    // would make every method of a class a consumer of it.
    const types = deriveTypeFlow(withSelf, registry)
    expect(types.acceptsOf.get('app.types.Rule.check') ?? []).toEqual([])
  })

  it('is memoised per (index, registry) pair', () => {
    expect(deriveTypeFlow(index, registry)).toBe(deriveTypeFlow(index, registry))
    expect(deriveTypeFlow(index, registry)).not.toBe(deriveTypeFlow(index, null))
  })
})
