import { describe, expect, it } from 'vitest'
import { deriveWorkspace } from '../data/derive'
import type { CodebaseGraph, GraphEdge, GraphNode, SymbolKind } from '../data/types'
import { placeholderScene } from './placeholderScene'
import { rectsIntersect } from './viewport'

function node(id: string, kind: SymbolKind, file: string, module: string): GraphNode {
  return {
    id,
    symbol_id: id,
    name: id.split('.').pop()!,
    kind,
    file_path: file,
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
  }
}

function imports(source: string, target: string): GraphEdge {
  return {
    source,
    target,
    type: 'IMPORTS',
    types: ['IMPORTS'],
    count: 1,
    lines: [1],
    confidence: 'exact',
    call_types: [],
    aliases: [],
  }
}

const GRAPH = {
  directed: true,
  multigraph: false,
  graph: { schema_version: 1, generated_at: '', root: '.', stats: {} },
  nodes: [
    node('app.loop', 'module', 'src/app/loop.py', 'app.loop'),
    node('app.loop.run', 'function', 'src/app/loop.py', 'app.loop'),
    node('app.errors', 'module', 'src/app/errors.py', 'app.errors'),
    node('app.cli', 'module', 'src/app/cli/main.py', 'app.cli'),
    node('conftest', 'module', 'conftest.py', 'conftest'),
  ],
  edges: [imports('app.cli', 'app.loop.run'), imports('app.loop', 'third_party.click.option')],
} as unknown as CodebaseGraph

const workspace = deriveWorkspace(GRAPH, [])
const scene = placeholderScene(workspace)

describe('placeholderScene', () => {
  it('emits one node per file, identified by its path', () => {
    expect(scene.nodes.map((n) => n.id).sort()).toEqual([
      'conftest.py',
      'src/app/cli/main.py',
      'src/app/errors.py',
      'src/app/loop.py',
    ])
  })

  it('labels a chip with its filename and symbol count', () => {
    const loop = scene.nodes.find((n) => n.id === 'src/app/loop.py')
    expect(loop?.label).toBe('loop.py')
    expect(loop?.sublabel).toBe('1 symbol')
    expect(scene.nodes.find((n) => n.id === 'conftest.py')?.sublabel).toBe('0 symbols')
  })

  it('boxes each directory that holds files', () => {
    expect(scene.groups.map((g) => g.label).sort()).toEqual([
      '/',
      'src/app',
      'src/app/cli',
    ])
  })

  it('overlaps nothing', () => {
    for (const a of scene.nodes) {
      for (const b of scene.nodes) {
        if (a.id !== b.id) expect(rectsIntersect(a, b)).toBe(false)
      }
    }
    for (const a of scene.groups) {
      for (const b of scene.groups) {
        if (a.id !== b.id) expect(rectsIntersect(a, b)).toBe(false)
      }
    }
  })

  it('keeps every chip inside its directory box', () => {
    const box = scene.groups.find((g) => g.label === 'src/app')!
    for (const id of ['src/app/loop.py', 'src/app/errors.py']) {
      const chip = scene.nodes.find((n) => n.id === id)!
      expect(chip.x).toBeGreaterThanOrEqual(box.x)
      expect(chip.y).toBeGreaterThanOrEqual(box.y)
      expect(chip.x + chip.width).toBeLessThanOrEqual(box.x + box.width)
      expect(chip.y + chip.height).toBeLessThanOrEqual(box.y + box.height)
    }
  })

  it('draws only the edges whose ends both landed on the canvas', () => {
    // The import of a symbol outside the graph is already dropped upstream.
    expect(scene.edges).toHaveLength(1)
    expect(scene.edges[0].id).toBe('src/app/cli/main.py->src/app/loop.py')
  })

  it('is deterministic', () => {
    expect(placeholderScene(workspace)).toEqual(scene)
  })

  it('is empty without a workspace', () => {
    expect(placeholderScene(null)).toEqual({ groups: [], edges: [], nodes: [] })
  })
})
