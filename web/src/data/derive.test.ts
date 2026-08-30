import { describe, expect, it } from 'vitest'
import {
  buildFsTree,
  deriveFileImports,
  deriveWorkspace,
  indexSymbols,
  walkFiles,
  type FsDir,
} from './derive'
import type { CodebaseGraph, GraphEdge, GraphNode, SymbolKind } from './types'

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
})
