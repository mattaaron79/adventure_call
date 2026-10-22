import { describe, expect, it } from 'vitest'
import { deriveWorkspace } from '../data/derive'
import type { CodebaseGraph, GraphEdge, GraphNode, SymbolKind } from '../data/types'
import { escapeLabel, exportModeMermaid, sceneToMermaid } from './mermaid'
import { MODES } from './registry'
import type { SceneSpec, SpecNode, StyleMap } from './types'

function spec(id: string, role: string, label: string, children: SpecNode[] = [], sublabel?: string): SpecNode {
  return { id, role, label, sublabel, symbolId: null, expandable: false, children }
}

describe('sceneToMermaid', () => {
  // A directory joined to its files by nesting edges, one file opened onto
  // two rows, and an import from a row to the other file.
  const tree: SceneSpec = {
    root: spec('dir:', 'dir', '/', [
      spec('a.py', 'file', 'a.py', [spec('a.py#f', 'row', 'def f()'), spec('a.py#g', 'row', 'def g()')]),
      spec('b.py', 'file', 'b.py', [], '2 symbols'),
    ]),
    groups: [{ id: 'dir::group', label: '/', of: 'dir:' }],
    edges: [
      { id: 'n1', from: 'dir:', to: 'a.py', kind: 'nesting' },
      { id: 'n2', from: 'dir:', to: 'b.py', kind: 'nesting' },
      { id: 'i1', from: 'a.py#g', to: 'b.py', kind: 'import', directional: true, detail: 'x | y' },
    ],
  }

  it('draws edge-joined children as nodes and other children inside their parent', () => {
    const { text, nodes, edges } = sceneToMermaid(tree, { direction: 'TB', title: 'fs' })
    expect(text.split('\n').slice(0, 2)).toEqual(['%% fs', 'flowchart TB'])
    expect(text).toContain('  n0("/")')
    expect(text).toContain('  subgraph n1["a.py"]\n    n2["def f()"]\n    n3["def g()"]\n  end')
    expect(text).toContain('  n4["b.py<br/>2 symbols"]')
    expect(text).toContain('  n0 --- n1')
    expect(text).toContain('  n3 -->|"x | y"| n4')
    expect(nodes).toBe(5)
    expect(edges).toBe(3)
  })

  it('leaves out a bare root and edges to elements that are not drawn', () => {
    const flat: SceneSpec = {
      root: spec('root', 'root', '', [spec('m.a', 'call', 'a'), spec('ext', 'external', 'os.path')]),
      groups: [],
      edges: [
        { id: 'e1', from: 'm.a', to: 'ext', kind: 'call', directional: true },
        { id: 'e2', from: 'm.a', to: 'gone', kind: 'call', directional: true },
      ],
    }
    const { text, nodes, edges } = sceneToMermaid(flat)
    expect(text).not.toContain('root')
    expect(text).toContain('  n1[["os.path"]]')
    expect(nodes).toBe(2)
    expect(edges).toBe(1)
  })

  it('carries hex strokes and dashes from the style phase, and nothing else', () => {
    const styles: StyleMap = {
      nodes: new Map([
        ['a.py', { fill: '#000000', stroke: '#111111', accent: '#89b4fa' }],
        ['b.py', { fill: '#000000', stroke: 'rgba(0,0,0,0)' }],
      ]),
      groups: new Map(),
      edges: new Map([
        ['n1', { stroke: '#45475a' }],
        ['n2', { stroke: '#45475a' }],
        ['i1', { stroke: '#f38ba8', dash: [4, 3] }],
      ]),
    }
    const { text } = sceneToMermaid(tree, { styles })
    expect(text).toContain('classDef s0 stroke:#89b4fa,stroke-width:2px\n  class n1 s0')
    expect(text).not.toContain('rgba')
    expect(text).not.toContain('fill')
    expect(text).toContain('linkStyle 0,1 stroke:#45475a')
    expect(text).toContain('linkStyle 2 stroke:#f38ba8,stroke-dasharray:4 3')
  })

  it('names the unnamed root directory, since Mermaid rejects an empty label', () => {
    const sunburst: SceneSpec = {
      root: spec('dir:', 'dir', '', [spec('a.py', 'file', 'a.py')]),
      groups: [],
      edges: [],
    }
    expect(sceneToMermaid(sunburst).text).toContain('  subgraph n0["/"]\n    n1["a.py"]\n  end')
  })

  it('escapes the characters that would end a label', () => {
    expect(escapeLabel('<module> "x" #1')).toBe('#60;module#62; #34;x#34; #35;1')
  })
})

function node(id: string, kind: SymbolKind, file_path: string, module: string): GraphNode {
  return {
    id, symbol_id: id, name: id.split('.').pop()!, kind, file_path, module,
    parent: kind === 'module' ? null : module,
    start_byte: 0, end_byte: 0, start_line: 1, end_line: 1,
    params: [], signature: '', docstring: null, decorators: [], bases: [], is_async: false, stub: '',
  }
}

function edge(source: string, target: string, type: 'CALLS' | 'IMPORTS'): GraphEdge {
  return {
    source, target, type, types: [type], count: 1, lines: [1],
    confidence: 'exact', call_types: [], aliases: [],
  }
}

const NODES = [
  node('pkg.a', 'module', 'src/pkg/a.py', 'pkg.a'),
  node('pkg.a.main', 'function', 'src/pkg/a.py', 'pkg.a'),
  node('pkg.b', 'module', 'src/pkg/b.py', 'pkg.b'),
  node('pkg.b.helper', 'function', 'src/pkg/b.py', 'pkg.b'),
]
const EDGES = [edge('pkg.a', 'pkg.b.helper', 'IMPORTS'), edge('pkg.a.main', 'pkg.b.helper', 'CALLS')]
const GRAPH: CodebaseGraph = {
  directed: true,
  multigraph: false,
  graph: {
    schema_version: 1,
    generated_at: '2026-10-22T00:00:00+00:00',
    root: '../fixture',
    stats: {
      files: 2, files_with_diagnostics: 0, symbols: 4, nodes: NODES.length, edges: EDGES.length,
      node_kinds: {}, edge_types: {}, calls_resolved: 1, calls_heuristic: 0,
      calls_unresolved: 0, calls_builtin: 0, diagnostics: 0,
    },
  },
  nodes: NODES,
  edges: EDGES,
}

describe('exportModeMermaid', () => {
  const workspace = deriveWorkspace(GRAPH, [])

  it.each(MODES.map((mode) => [mode.id, mode] as const))('exports the %s view', (_, mode) => {
    const out = exportModeMermaid(mode, workspace, { ...mode.defaultParams }, { expanded: {} })
    expect(out.text).toMatch(new RegExp(`^%% adventure-call: ${mode.label}\nflowchart (LR|TB)\n`))
    expect(out.nodes).toBeGreaterThan(0)
    // Every drawn node id is declared once, and every edge joins declared ids.
    const declared = [...out.text.matchAll(/^\s*(?:subgraph )?(n\d+)[[("]/gm)].map((m) => m[1])
    expect(new Set(declared).size).toBe(declared.length)
    expect(declared.length).toBe(out.nodes)
    for (const [, from, to] of out.text.matchAll(/^\s*(n\d+) -(?:--|->)(?:\|"[^"]*"\|)? (n\d+)$/gm)) {
      expect(declared).toContain(from)
      expect(declared).toContain(to)
    }
  })

  it('follows the fs-tree orientation and ignores the zoom level', () => {
    const fsTree = MODES.find((mode) => mode.id === 'fs-tree')!
    const params = { ...fsTree.defaultParams, orientation: 'tb' }
    const near = exportModeMermaid(fsTree, workspace, params, { expanded: {}, lod: 0 })
    const far = exportModeMermaid(fsTree, workspace, params, { expanded: {}, lod: 3 })
    expect(near.text).toContain('flowchart TB')
    expect(far.text).toBe(near.text)
  })
})
