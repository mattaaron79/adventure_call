import { describe, expect, it } from 'vitest'
import { deriveWorkspace, type FsFile } from '../data/derive'
import type { CodebaseGraph, GraphEdge, GraphNode, SymbolKind } from '../data/types'
import { fileRows, rowId } from './fileDetail'

/**
 * The shared expanded-file rows (tic-0680).  The section ordering, container
 * geometry and the default (fs-tree) row output are already guarded by
 * fsTree.test.ts -- which is the point of the extraction, so those
 * expectations are not restated here.  What this suite owns is the part that
 * is new: the optional "Imported By" section built from the reverse index.
 */

function node(
  id: string,
  kind: SymbolKind,
  file_path: string,
  module: string,
  parent: string | null = null,
  signature = '',
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
    signature,
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

/**
 * A chain plus a fan-in: `a.py` and `d.py` both import `b.py`, and `b.py`
 * imports two symbols from `c.py`.  So `b.py` is the file that both imports
 * and is imported (the ordering case), and `c.py` is imported by one file
 * through two symbols (the "one row per file, not per symbol" case).
 * `e.py` is an island, connected to nothing either way.
 */
const NODES: GraphNode[] = [
  node('app.a', 'module', 'src/a.py', 'app.a'),
  node('app.a.run', 'function', 'src/a.py', 'app.a', null, 'def run():'),

  node('app.b', 'module', 'src/b.py', 'app.b'),
  node('app.b.Middle', 'class', 'src/b.py', 'app.b', null, 'class Middle:'),

  node('app.c', 'module', 'src/c.py', 'app.c'),
  node('app.c.Leaf', 'class', 'src/c.py', 'app.c', null, 'class Leaf:'),
  node('app.c.Other', 'class', 'src/c.py', 'app.c', null, 'class Other:'),

  node('app.d', 'module', 'src/d.py', 'app.d'),

  // An island: imports nothing internal, and nothing imports it.
  node('app.e', 'module', 'src/e.py', 'app.e'),
]

const EDGES: GraphEdge[] = [
  imports('app.a', 'app.b.Middle'),
  imports('app.d', 'app.b.Middle'),
  imports('app.b', 'app.c.Leaf'),
  imports('app.b', 'app.c.Other'), // same file pair, second symbol
]

const GRAPH: CodebaseGraph = {
  directed: true,
  multigraph: false,
  graph: {
    schema_version: 1,
    generated_at: '2026-08-30T00:00:00+00:00',
    root: '../fixture',
    stats: {
      files: 5,
      files_with_diagnostics: 0,
      symbols: 4,
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

const WORKSPACE = deriveWorkspace(GRAPH, [])

/** The FsFile for a root-relative path in the fixture's tree. */
function file(path: string): FsFile {
  const dir = WORKSPACE.tree.children.find((c) => c.type === 'dir' && c.name === 'src')
  if (!dir || dir.type !== 'dir') throw new Error('no src directory')
  const found = dir.children.find((c) => c.type === 'file' && c.path === path)
  if (!found || found.type !== 'file') throw new Error(`no file ${path}`)
  return found
}

const sections = (rows: { kind: string; label: string }[]): string[] =>
  rows.filter((r) => r.kind === 'section').map((r) => r.label)

describe('fileRows importedBy (tic-0680)', () => {
  it('omits the Imported By section by default, so fs-tree is untouched', () => {
    expect(sections(fileRows(WORKSPACE, file('src/b.py')))).toEqual([
      'Imports',
      'Classes',
    ])
    expect(fileRows(WORKSPACE, file('src/b.py')).some((r) => r.id.includes('impby:'))).toBe(
      false,
    )
  })

  it('puts Imported By above Imports when asked for it', () => {
    const rows = fileRows(WORKSPACE, file('src/b.py'), { importedBy: true })
    expect(sections(rows)).toEqual(['Imported By', 'Imports', 'Classes'])
  })

  it('emits one row per importing file, not per imported symbol', () => {
    // b.py imports two symbols from c.py, so the forward Imports section of
    // b.py has two rows -- but c.py's Imported By has exactly one.
    expect(fileRows(WORKSPACE, file('src/b.py'), { importedBy: true }).filter(
      (r) => r.id.startsWith(rowId('src/b.py', 'imp:')),
    )).toHaveLength(2)

    const incoming = fileRows(WORKSPACE, file('src/c.py'), { importedBy: true }).filter((r) =>
      r.id.startsWith(rowId('src/c.py', 'impby:')),
    )
    expect(incoming).toHaveLength(1)
    expect(incoming[0].gotoTo).toBe('src/b.py')
  })

  it('lists every importer of a fanned-in file', () => {
    const rows = fileRows(WORKSPACE, file('src/b.py'), { importedBy: true })
    const incoming = rows.filter((r) => r.id.startsWith(rowId('src/b.py', 'impby:')))
    expect(incoming.map((r) => r.gotoTo).sort()).toEqual(['src/a.py', 'src/d.py'])
  })

  it('names a file, not a symbol: null symbolId, module kind, goto to the importer', () => {
    const rows = fileRows(WORKSPACE, file('src/b.py'), { importedBy: true })
    const row = rows.find((r) => r.id === rowId('src/b.py', 'impby:src/a.py'))!
    expect(row).toBeDefined()
    expect(row.symbolId).toBeNull()
    expect(row.kind).toBe('module')
    expect(row.indent).toBe(false)
    expect(row.external).toBeUndefined()
    expect(row.gotoTo).toBe('src/a.py')
    // Shaped like the Imports rows (`name · module`) so the sections read as
    // siblings.
    expect(row.label).toBe('a · app.a')
  })

  it('omits the section entirely for a file nobody imports', () => {
    const rows = fileRows(WORKSPACE, file('src/a.py'), { importedBy: true })
    expect(sections(rows)).toEqual(['Imports', 'Functions'])
  })

  it('emits no sections at all for a file with no imports either way', () => {
    expect(sections(fileRows(WORKSPACE, file('src/e.py'), { importedBy: true }))).toEqual([])
  })
})
