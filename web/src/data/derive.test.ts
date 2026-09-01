import { describe, expect, it } from 'vitest'
import {
  buildFsTree,
  deriveExternalImports,
  deriveFileImporters,
  deriveFileImports,
  deriveStronglyConnectedComponents,
  deriveWorkspace,
  indexSymbols,
  walkFiles,
  type FileImportEdge,
  type FsDir,
} from './derive'
import type {
  BindingRecord,
  CodebaseGraph,
  GraphEdge,
  GraphNode,
  ImportRecord,
  ModuleRecord,
  SymbolKind,
  SymbolRegistry,
} from './types'

/**
 * A six-file stand-in for a real export.  It reproduces the shapes that make
 * the derivations non-trivial: top-level symbols with a null parent, methods
 * parented to a class, two import statements between the same pair of files,
 * a file importing itself, an import of a symbol that is not in the graph,
 * and a tree that is deeper on one branch than the other.
 */
function node(
  id: string,
  kind: SymbolKind,
  file_path: string,
  module: string,
  parent: string | null = null,
): GraphNode {
  return {
    id,
    symbol_id: id,
    name: id.split('.').pop()!,
    kind,
    file_path,
    module,
    parent,
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
  }
}

function imports(source: string, target: string, count = 1): GraphEdge {
  return {
    source,
    target,
    type: 'IMPORTS',
    types: ['IMPORTS'],
    count,
    lines: [1],
    confidence: 'exact',
    call_types: [],
    aliases: [],
  }
}

function calls(source: string, target: string): GraphEdge {
  return { ...imports(source, target), type: 'CALLS', types: ['CALLS'] }
}

/** An `import a.b` / `from a.b import c` as the registry records it. */
function importRecord(
  module: string,
  alias: string,
  target_module: string,
  target_symbol: string | null,
  overrides: Partial<ImportRecord> = {},
): ImportRecord {
  const target = target_symbol
    ? target_module
      ? `${target_module}.${target_symbol}`
      : target_symbol
    : target_module
  return {
    module,
    alias,
    target_module,
    target_symbol,
    is_relative: false,
    level: 1,
    is_wildcard: false,
    line: 1,
    target,
    ...overrides,
  }
}

function binding(alias: string, kind: string, target: string): BindingRecord {
  return { alias, kind, target, line: 1, statement_module: '', is_relative: false }
}

/** A minimal symbol_registry.json: just the modules and bindings a test needs. */
function makeRegistry(
  modules: Record<string, { file_path: string; imports: ImportRecord[] }>,
  bindings: Record<string, Record<string, BindingRecord>>,
): SymbolRegistry {
  const mods: Record<string, ModuleRecord> = {}
  for (const [id, m] of Object.entries(modules)) {
    mods[id] = {
      file_path: m.file_path,
      language: 'python',
      docstring: null,
      symbol_ids: [],
      imports: m.imports,
    }
  }
  return {
    schema_version: 1,
    generated_at: '2026-08-30T00:00:00+00:00',
    root: '../fixture',
    includes_source: false,
    stats: GRAPH.graph.stats,
    symbols: {},
    modules: mods,
    bindings,
    unresolved_calls: [],
    diagnostics: [],
  }
}

const NODES: GraphNode[] = [
  node('app.loop', 'module', 'src/app/loop.py', 'app.loop'),
  node('app.loop.Agent', 'class', 'src/app/loop.py', 'app.loop'),
  node('app.loop.Agent.step', 'method', 'src/app/loop.py', 'app.loop', 'app.loop.Agent'),
  node('app.loop.run', 'function', 'src/app/loop.py', 'app.loop'),

  node('app.errors', 'module', 'src/app/errors.py', 'app.errors'),
  node('app.errors.PluginError', 'class', 'src/app/errors.py', 'app.errors'),
  node('app.errors.Aborted', 'class', 'src/app/errors.py', 'app.errors'),

  node('app.cli', 'module', 'src/app/cli/main.py', 'app.cli'),
  node('app.cli.main', 'function', 'src/app/cli/main.py', 'app.cli'),

  node('tests.test_loop', 'module', 'tests/test_loop.py', 'tests.test_loop'),
  node('tests.test_loop.test_run', 'function', 'tests/test_loop.py', 'tests.test_loop'),

  node('conftest', 'module', 'conftest.py', 'conftest'),

  node('scratch.spike', 'module', 'scratch/spike.py', 'scratch.spike'),
  node('scratch.spike.poke', 'function', 'scratch/spike.py', 'scratch.spike'),
]

const EDGES: GraphEdge[] = [
  imports('app.loop', 'app.errors.PluginError'),
  imports('app.loop', 'app.errors.Aborted', 2), // same file pair, second statement
  imports('app.cli', 'app.loop.Agent'),
  imports('app.loop', 'app.loop.run'), // self-edge: dropped
  imports('app.cli', 'third_party.click.command'), // unknown target: dropped
  imports('tests.test_loop', 'scratch.spike.poke'),
  calls('app.cli.main', 'app.loop.run'), // not an import: ignored
]

const GRAPH: CodebaseGraph = {
  directed: true,
  multigraph: false,
  graph: {
    schema_version: 1,
    generated_at: '2026-08-30T00:00:00+00:00',
    root: '../fixture',
    stats: {
      files: 6,
      files_with_diagnostics: 0,
      symbols: 8,
      nodes: NODES.length,
      edges: EDGES.length,
      node_kinds: {},
      edge_types: {},
      calls_resolved: 0,
      calls_heuristic: 0,
      calls_unresolved: 0,
      calls_builtin: 0,
      diagnostics: 0,
    },
  },
  nodes: NODES,
  edges: EDGES,
}

const MODULES = NODES.filter((n) => n.kind === 'module')

function dir(root: FsDir, path: string): FsDir {
  for (const segment of path.split('/')) {
    const next = root.children.find((c) => c.type === 'dir' && c.name === segment)
    if (!next || next.type !== 'dir') throw new Error(`no directory ${path}`)
    root = next
  }
  return root
}

describe('indexSymbols', () => {
  const index = indexSymbols(NODES)

  it('keys every node by id, modules included', () => {
    expect(index.byId.size).toBe(NODES.length)
    expect(index.byId.get('app.loop.Agent.step')?.kind).toBe('method')
    expect(index.byId.get('app.loop')?.kind).toBe('module')
  })

  it('groups non-module symbols under their module', () => {
    expect(index.byModule.get('app.loop')?.map((n) => n.id)).toEqual([
      'app.loop.Agent',
      'app.loop.Agent.step',
      'app.loop.run',
    ])
    expect(index.byModule.has('conftest')).toBe(false) // module with no symbols
  })

  it('lists children under their parent', () => {
    expect(index.byParent.get('app.loop.Agent')?.map((n) => n.id)).toEqual([
      'app.loop.Agent.step',
    ])
    expect(index.byParent.has('app.loop')).toBe(false) // parent is null, not the module
  })

  it('collects the null-parent symbols of each module as roots', () => {
    expect(index.rootsByModule.get('app.loop')?.map((n) => n.id)).toEqual([
      'app.loop.Agent',
      'app.loop.run',
    ])
  })

  it('maps modules by file and by id', () => {
    expect(index.moduleByFile.get('src/app/cli/main.py')?.id).toBe('app.cli')
    expect(index.moduleById.get('app.cli')?.file_path).toBe('src/app/cli/main.py')
    expect(index.moduleById.size).toBe(MODULES.length)
  })

  it('memoises on the array identity', () => {
    expect(indexSymbols(NODES)).toBe(index)
    expect(indexSymbols([...NODES])).not.toBe(index)
  })
})

describe('buildFsTree', () => {
  const tree = buildFsTree(MODULES)

  it('splits file paths into nested directories', () => {
    expect(dir(tree, 'src/app/cli').children.map((c) => c.name)).toEqual(['main.py'])
    expect(dir(tree, 'src/app').children.map((c) => c.name)).toEqual([
      'cli',
      'errors.py',
      'loop.py',
    ])
  })

  it('sorts directories before files', () => {
    expect(tree.children.map((c) => `${c.type}:${c.name}`)).toEqual([
      'dir:scratch',
      'dir:src',
      'dir:tests',
      'file:conftest.py',
    ])
  })

  it('rolls file counts up the tree', () => {
    expect(tree.fileCount).toBe(MODULES.length)
    expect(dir(tree, 'src').fileCount).toBe(3)
    expect(dir(tree, 'src/app/cli').fileCount).toBe(1)
  })

  it('keeps root-level files at the root with their full path', () => {
    const files = [...walkFiles(tree)].map((f) => f.path)
    expect(files).toContain('conftest.py')
    expect(files).toHaveLength(MODULES.length)
    expect([...walkFiles(tree)].every((f) => f.module.kind === 'module')).toBe(true)
  })

  it('memoises on the array identity', () => {
    expect(buildFsTree(MODULES)).toBe(tree)
  })
})

describe('deriveFileImports', () => {
  const index = indexSymbols(NODES)
  const edges = deriveFileImports(EDGES, index)
  const find = (source: string, target: string) =>
    edges.find((e) => e.source === source && e.target === target)

  it('collapses statements between the same pair into one edge', () => {
    expect(find('src/app/loop.py', 'src/app/errors.py')).toEqual({
      source: 'src/app/loop.py',
      target: 'src/app/errors.py',
      count: 3, // 1 + 2
      symbolIds: ['app.errors.PluginError', 'app.errors.Aborted'],
    })
  })

  it('keeps the contributing symbol ids so the edge can re-anchor', () => {
    expect(find('src/app/cli/main.py', 'src/app/loop.py')?.symbolIds).toEqual([
      'app.loop.Agent',
    ])
  })

  it('drops self-edges, unresolvable targets and non-IMPORTS edges', () => {
    expect(find('src/app/loop.py', 'src/app/loop.py')).toBeUndefined()
    expect(edges.some((e) => e.target.includes('third_party'))).toBe(false)
    expect(edges).toHaveLength(3)
  })

  it('memoises per (edges, index) pair', () => {
    expect(deriveFileImports(EDGES, index)).toBe(edges)
    expect(deriveFileImports(EDGES, indexSymbols([...NODES]))).not.toBe(edges)
  })
})

describe('deriveExternalImports', () => {
  const index = indexSymbols(NODES)

  const REGISTRY = makeRegistry(
    {
      'app.loop': {
        file_path: 'src/app/loop.py',
        imports: [
          importRecord('app.loop', 'typing', 'typing', null),
          importRecord('app.loop', 'typing', 'typing', null), // repeated -> grouped
          importRecord('app.loop', 'Optional', 'typing', 'Optional'),
          importRecord('app.loop', 'PluginError', 'app.errors', 'PluginError'), // resolves
          importRecord('app.loop', 'click', 'click', null), // no binding -> index fallback
          importRecord('app.loop', 'errors_star', 'app.errors', null, { is_wildcard: true }), // no binding, resolves
        ],
      },
      'tests.test_loop': {
        file_path: 'tests/test_loop.py',
        imports: [importRecord('tests.test_loop', 'pytest', 'pytest', null)],
      },
    },
    {
      'app.loop': {
        typing: binding('typing', 'external', 'typing'),
        Optional: binding('Optional', 'external', 'typing.Optional'),
        PluginError: binding('PluginError', 'symbol', 'app.errors.PluginError'),
      },
    },
  )

  const external = deriveExternalImports(REGISTRY, index)

  it('keeps imports the registry labelled external, grouped per file and target', () => {
    expect(external.filter((imp) => imp.source === 'src/app/loop.py')).toEqual([
      { source: 'src/app/loop.py', target: 'typing', count: 2 },
      { source: 'src/app/loop.py', target: 'typing.Optional', count: 1 },
      { source: 'src/app/loop.py', target: 'click', count: 1 },
    ])
    expect(external).toContainEqual({ source: 'tests/test_loop.py', target: 'pytest', count: 1 })
  })

  it('drops imports that resolve to a known symbol or module, by binding kind', () => {
    // PluginError has a `symbol` binding; errors_star has none but its target
    // module resolves in the index, so neither is external.
    expect(external.some((imp) => imp.target.includes('PluginError'))).toBe(false)
    expect(external.some((imp) => imp.target === 'app.errors')).toBe(false)
  })

  it('falls back to the index for imports the resolver did not bind', () => {
    // `import click` has no binding and does not resolve -> external.
    expect(external).toContainEqual({ source: 'src/app/loop.py', target: 'click', count: 1 })
  })

  it('only surfaces files present in the workspace index', () => {
    // A filtered index drops scratch.spike; its external imports vanish too.
    const filtered = indexSymbols(NODES.filter((n) => n.module !== 'scratch.spike'))
    const scratchImports = deriveExternalImports(
      makeRegistry(
        { 'scratch.spike': { file_path: 'scratch/spike.py', imports: [importRecord('scratch.spike', 'click', 'click', null)] } },
        { 'scratch.spike': { click: binding('click', 'external', 'click') } },
      ),
      filtered,
    )
    expect(scratchImports).toEqual([])
    expect(
      deriveExternalImports(
        makeRegistry(
          { 'scratch.spike': { file_path: 'scratch/spike.py', imports: [importRecord('scratch.spike', 'click', 'click', null)] } },
          { 'scratch.spike': { click: binding('click', 'external', 'click') } },
        ),
        indexSymbols(NODES),
      ),
    ).toEqual([{ source: 'scratch/spike.py', target: 'click', count: 1 }])
  })

  it('memoises per (registry, index) pair', () => {
    expect(deriveExternalImports(REGISTRY, index)).toBe(external)
    expect(deriveExternalImports(REGISTRY, indexSymbols([...NODES]))).not.toBe(external)
  })
})

describe('deriveWorkspace', () => {
  it('applies excludes before deriving anything', () => {
    const ws = deriveWorkspace(GRAPH, ['scratch/**'])

    expect(ws.modules).toHaveLength(5)
    expect(ws.excludedFiles).toBe(1)
    expect(ws.tree.children.map((c) => c.name)).toEqual(['src', 'tests', 'conftest.py'])
    expect(ws.index.byId.has('scratch.spike.poke')).toBe(false)
    // tests -> scratch went with it; loop -> errors and cli -> loop remain.
    expect(ws.fileImports).toHaveLength(2)
  })

  it('derives the whole graph when nothing is excluded', () => {
    const ws = deriveWorkspace(GRAPH, [])
    expect(ws.modules).toHaveLength(MODULES.length)
    expect(ws.excludedFiles).toBe(0)
    expect(ws.fileImports).toHaveLength(3)
  })

  it('memoises per (graph, excludes) pair', () => {
    const ws = deriveWorkspace(GRAPH, ['scratch/**'])
    expect(deriveWorkspace(GRAPH, ['scratch/**'])).toBe(ws)
    expect(deriveWorkspace(GRAPH, [])).not.toBe(ws)
  })

  it('keeps only the files the query matches, with their symbols (tic-9098)', () => {
    // 'loop' is in both paths; 'errors' only in one.
    const ws = deriveWorkspace(GRAPH, [], 'errors')
    expect(ws.modules.map((m) => m.id)).toEqual(['app.errors'])
    expect(ws.excludedFiles).toBe(MODULES.length - 1)
    expect(ws.index.byId.has('app.errors.PluginError')).toBe(true)
    expect(ws.index.byId.has('app.loop.run')).toBe(false)
    expect([...walkFiles(ws.tree)].map((f) => f.path)).toEqual(['src/app/errors.py'])
  })

  it('matches an all-properties query through a symbol deep inside a file', () => {
    // 'step' is a method of Agent in src/app/loop.py; it appears in no path.
    const ws = deriveWorkspace(GRAPH, [], '>step')
    expect(ws.modules.map((m) => m.id)).toEqual(['app.loop'])
    expect(ws.index.byId.has('app.loop.Agent.step')).toBe(true)
  })

  it('does not widen a path-only query into symbol properties', () => {
    expect(deriveWorkspace(GRAPH, [], 'step').modules).toHaveLength(0)
  })

  it('supports the regex forms', () => {
    expect(deriveWorkspace(GRAPH, [], 'r:^src/app/\\w+\\.py$').modules.map((m) => m.id)).toEqual([
      'app.loop',
      'app.errors',
    ])
    expect(deriveWorkspace(GRAPH, [], '>r:^run$').modules.map((m) => m.id)).toEqual([
      'app.loop',
    ])
  })

  it('matches nothing for an invalid regex rather than throwing', () => {
    const ws = deriveWorkspace(GRAPH, [], 'r:(')
    expect(ws.modules).toHaveLength(0)
    expect(ws.excludedFiles).toBe(MODULES.length)
  })

  it('applies the query after the excludes', () => {
    const ws = deriveWorkspace(GRAPH, ['scratch/**'], 'spike')
    expect(ws.modules).toHaveLength(0)
    expect(ws.excludedFiles).toBe(MODULES.length)
  })

  it('memoises per (graph, excludes, query) triple', () => {
    const ws = deriveWorkspace(GRAPH, [], 'loop')
    expect(deriveWorkspace(GRAPH, [], 'loop')).toBe(ws)
    expect(deriveWorkspace(GRAPH, [], 'errors')).not.toBe(ws)
    expect(deriveWorkspace(GRAPH, [], '')).not.toBe(ws)
  })

  it('stays on codebase_graph.json alone: external imports are empty until the registry lands', () => {
    expect(deriveWorkspace(GRAPH, []).externalImports).toEqual([])
    expect(deriveWorkspace(GRAPH, ['scratch/**']).externalImports).toEqual([])
  })

  it('populates the external-import layer once a registry is passed (tic-314c)', () => {
    const registry = makeRegistry(
      {
        'app.loop': {
          file_path: 'src/app/loop.py',
          imports: [importRecord('app.loop', 'typing', 'typing', null)],
        },
      },
      { 'app.loop': { typing: binding('typing', 'external', 'typing') } },
    )
    const ws = deriveWorkspace(GRAPH, [], '', registry)
    expect(ws.externalImports).toEqual([
      { source: 'src/app/loop.py', target: 'typing', count: 1 },
    ])
  })

  it('memoises the registry-aware workspace per (graph, excludes, query, registry)', () => {
    const registry = makeRegistry(
      { 'app.loop': { file_path: 'src/app/loop.py', imports: [importRecord('app.loop', 'typing', 'typing', null)] } },
      { 'app.loop': { typing: binding('typing', 'external', 'typing') } },
    )
    const ws = deriveWorkspace(GRAPH, [], '', registry)
    expect(deriveWorkspace(GRAPH, [], '', registry)).toBe(ws)
    // A missing or different registry is a different derivation.
    expect(deriveWorkspace(GRAPH, [], '')).not.toBe(ws)
    expect(deriveWorkspace(GRAPH, [], '', makeRegistry({}, {}))).not.toBe(ws)
  })
})

// -- import cycles (tic-56b2) -------------------------------------------------

function fileImport(source: string, target: string): FileImportEdge {
  return { source, target, count: 1, symbolIds: [] }
}

describe('deriveStronglyConnectedComponents', () => {
  it('puts every file in its own singleton component when there is no cycle', () => {
    const scc = deriveStronglyConnectedComponents([fileImport('a', 'b'), fileImport('b', 'c')])
    expect(scc.cyclic.size).toBe(0)
    expect(scc.componentOf.get('a')).not.toBe(scc.componentOf.get('b'))
    expect(scc.componentOf.get('b')).not.toBe(scc.componentOf.get('c'))
  })

  it('finds a direct two-file cycle', () => {
    const scc = deriveStronglyConnectedComponents([fileImport('a', 'b'), fileImport('b', 'a')])
    const id = scc.componentOf.get('a')
    expect(id).toBeDefined()
    expect(scc.componentOf.get('b')).toBe(id)
    expect(scc.cyclic.has(id!)).toBe(true)
  })

  it('finds a longer cycle (a -> b -> c -> a)', () => {
    const scc = deriveStronglyConnectedComponents([
      fileImport('a', 'b'),
      fileImport('b', 'c'),
      fileImport('c', 'a'),
    ])
    const id = scc.componentOf.get('a')
    expect(scc.componentOf.get('b')).toBe(id)
    expect(scc.componentOf.get('c')).toBe(id)
    expect(scc.cyclic.has(id!)).toBe(true)
  })

  it('does not merge a file that only feeds into a cycle from outside it', () => {
    // entry -> a -> b -> a (a/b cycle; entry is not part of it)
    const scc = deriveStronglyConnectedComponents([
      fileImport('entry', 'a'),
      fileImport('a', 'b'),
      fileImport('b', 'a'),
    ])
    const cycleId = scc.componentOf.get('a')!
    expect(scc.componentOf.get('b')).toBe(cycleId)
    expect(scc.cyclic.has(cycleId)).toBe(true)
    expect(scc.componentOf.get('entry')).not.toBe(cycleId)
    expect(scc.cyclic.has(scc.componentOf.get('entry')!)).toBe(false)
  })

  it('keeps two disjoint cycles as separate components', () => {
    const scc = deriveStronglyConnectedComponents([
      fileImport('a', 'b'),
      fileImport('b', 'a'),
      fileImport('x', 'y'),
      fileImport('y', 'x'),
    ])
    const abId = scc.componentOf.get('a')!
    const xyId = scc.componentOf.get('x')!
    expect(abId).not.toBe(xyId)
    expect(scc.cyclic.has(abId)).toBe(true)
    expect(scc.cyclic.has(xyId)).toBe(true)
  })

  it('handles a graph with hundreds of files without a stack overflow', () => {
    // A long chain -- the shape most likely to blow a naive recursive DFS.
    const edges: FileImportEdge[] = []
    for (let i = 0; i < 2000; i++) edges.push(fileImport(`f${i}`, `f${i + 1}`))
    expect(() => deriveStronglyConnectedComponents(edges)).not.toThrow()
  })

  it('memoises per fileImports array', () => {
    const edges = [fileImport('a', 'b')]
    expect(deriveStronglyConnectedComponents(edges)).toBe(deriveStronglyConnectedComponents(edges))
    expect(deriveStronglyConnectedComponents([fileImport('a', 'b')])).not.toBe(
      deriveStronglyConnectedComponents(edges),
    )
  })
})

// -- importers reverse index (tic-0680) ---------------------------------------

describe('deriveFileImporters', () => {
  const index = indexSymbols(NODES)
  const forward = deriveFileImports(EDGES, index)

  it('keys the importing edges by the file they import', () => {
    const importers = deriveFileImporters(forward)
    expect(importers.get('src/app/errors.py')?.map((e) => e.source)).toEqual([
      'src/app/loop.py',
    ])
    expect(importers.get('src/app/loop.py')?.map((e) => e.source)).toEqual([
      'src/app/cli/main.py',
    ])
  })

  it('collects every importer of a fanned-in file', () => {
    const importers = deriveFileImporters([
      fileImport('a', 'shared'),
      fileImport('b', 'shared'),
      fileImport('c', 'shared'),
    ])
    expect(importers.get('shared')?.map((e) => e.source)).toEqual(['a', 'b', 'c'])
  })

  it('is absent -- not empty -- for a file nobody imports', () => {
    const importers = deriveFileImporters(forward)
    // main.py imports loop.py but nothing imports main.py.
    expect(importers.has('src/app/cli/main.py')).toBe(false)
    expect(importers.get('src/app/cli/main.py')).toBeUndefined()
  })

  it('buckets the very same edge objects as the forward array', () => {
    const importers = deriveFileImporters(forward)
    const forwardEdge = forward.find(
      (e) => e.source === 'src/app/loop.py' && e.target === 'src/app/errors.py',
    )
    expect(importers.get('src/app/errors.py')?.[0]).toBe(forwardEdge)
    // So `count` and `symbolIds` come along for free.
    expect(importers.get('src/app/errors.py')?.[0].symbolIds).toEqual([
      'app.errors.PluginError',
      'app.errors.Aborted',
    ])
  })

  it('covers exactly the targets the forward edges name', () => {
    const importers = deriveFileImporters(forward)
    expect([...importers.keys()].sort()).toEqual(
      [...new Set(forward.map((e) => e.target))].sort(),
    )
  })

  it('memoises per fileImports array', () => {
    const edges = [fileImport('a', 'b')]
    expect(deriveFileImporters(edges)).toBe(deriveFileImporters(edges))
    expect(deriveFileImporters([fileImport('a', 'b')])).not.toBe(deriveFileImporters(edges))
  })

  it('is exposed on the workspace, derived from its own fileImports', () => {
    const workspace = deriveWorkspace(GRAPH, [])
    expect(workspace.fileImporters).toBe(deriveFileImporters(workspace.fileImports))
    expect(workspace.fileImporters.get('src/app/errors.py')?.[0].source).toBe(
      'src/app/loop.py',
    )
  })
})
