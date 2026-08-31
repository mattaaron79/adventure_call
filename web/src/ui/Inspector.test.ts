import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { FsDir, SymbolIndex, Workspace } from '../data/derive'
import type { GraphNode, SymbolKind } from '../data/types'
import {
  Inspector,
  buildImportRows,
  countSymbolsByKind,
  lineRange,
  vscodeFileLink,
} from './Inspector'

function node(id: string, kind: SymbolKind, name?: string, module?: string): GraphNode {
  return {
    id,
    symbol_id: id,
    name: name ?? id.split('.').pop()!,
    kind,
    file_path: 'src/app/loop.py',
    module: module ?? 'app.loop',
    parent: null,
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    end_line: 2,
    params: [],
    signature: '',
    docstring: null,
    decorators: [],
    bases: [],
    is_async: false,
    stub: '',
  }
}

/**
 * A minimal workspace with just the slices buildImportRows reads: the file's
 * internal import edge (resolved through the index) and its external imports.
 */
const byId = new Map<string, GraphNode>([
  ['app.errors.PluginError', node('app.errors.PluginError', 'class', 'PluginError', 'app.errors')],
])

const index: SymbolIndex = {
  byId,
  byModule: new Map(),
  byParent: new Map(),
  rootsByModule: new Map(),
  moduleByFile: new Map(),
  moduleById: new Map(),
}

const tree: FsDir = { type: 'dir', name: '', path: '', fileCount: 0, children: [] }

const WORKSPACE: Workspace = {
  nodes: [],
  modules: [],
  index,
  tree,
  fileImports: [
    {
      source: 'src/app/loop.py',
      target: 'src/app/errors.py',
      count: 2,
      symbolIds: ['app.errors.PluginError'],
    },
    { source: 'src/other.py', target: 'src/app/errors.py', count: 1, symbolIds: [] },
  ],
  externalImports: [
    { source: 'src/app/loop.py', target: 'collections.abc', count: 1 },
    { source: 'src/app/loop.py', target: 'typing', count: 2 },
    { source: 'src/other.py', target: 'os', count: 1 },
  ],
  excludedFiles: 0,
}

describe('vscodeFileLink', () => {
  it('builds the vscode:// deep link from an absolute root and file path', () => {
    expect(vscodeFileLink('/repo/carnot', 'src/app/loop.py', 42)).toBe(
      'vscode://file//repo/carnot/src/app/loop.py:42:1',
    )
  })

  it('normalises a Windows root to forward slashes for a valid URI', () => {
    expect(vscodeFileLink('Y:\\repo\\carnot', 'src/app/loop.py', 7)).toBe(
      'vscode://file/Y:/repo/carnot/src/app/loop.py:7:1',
    )
  })

  it('strips trailing slashes from the root and leading slashes from the file', () => {
    expect(vscodeFileLink('/repo/carnot/', '/src/app/loop.py', 3)).toBe(
      'vscode://file//repo/carnot/src/app/loop.py:3:1',
    )
  })

  it('degrades to null when the absolute root is unavailable', () => {
    expect(vscodeFileLink(null, 'src/app/loop.py', 1)).toBeNull()
    expect(vscodeFileLink('', 'src/app/loop.py', 1)).toBeNull()
  })

  it('degrades to null without a file path', () => {
    expect(vscodeFileLink('/repo', '', 1)).toBeNull()
  })
})

describe('buildImportRows', () => {
  it('lists internal imports first, each carrying a goto target and display name', () => {
    const rows = buildImportRows(WORKSPACE, 'src/app/loop.py')
    const internal = rows.filter((r) => !r.external)
    expect(internal).toEqual([
      {
        key: 'imp:app.errors.PluginError',
        goto: 'src/app/errors.py',
        label: 'PluginError · app.errors',
        external: false,
        count: 2,
      },
    ])
  })

  it('lists external imports after the internal ones, linkless', () => {
    const rows = buildImportRows(WORKSPACE, 'src/app/loop.py')
    const external = rows.filter((r) => r.external)
    expect(external).toEqual([
      { key: 'ext:collections.abc', goto: null, label: 'collections.abc', external: true, count: 1 },
      { key: 'ext:typing', goto: null, label: 'typing', external: true, count: 2 },
    ])
    // Internal before external, matching the fs-tree Imports section.
    expect(rows.map((r) => r.external)).toEqual([false, true, true])
  })

  it('ignores imports of other files', () => {
    // errors.py appears nowhere as a source, so it has no rows at all.
    const rows = buildImportRows(WORKSPACE, 'src/app/errors.py')
    expect(rows).toEqual([])
    expect(buildImportRows(WORKSPACE, 'src/app/loop.py').length).toBe(3)
  })
})

describe('countSymbolsByKind', () => {
  it('counts symbols per kind, sorted alphabetically', () => {
    const nodes = [
      node('a.fn', 'function'),
      node('a.Cls', 'class'),
      node('a.var', 'variable'),
      node('a.other', 'function'),
    ]
    expect(countSymbolsByKind(nodes)).toEqual([
      { kind: 'class', count: 1 },
      { kind: 'function', count: 2 },
      { kind: 'variable', count: 1 },
    ])
  })

  it('is empty for no symbols', () => {
    expect(countSymbolsByKind([])).toEqual([])
  })
})

describe('lineRange', () => {
  it('renders a single line as L<n>', () => {
    const single = { ...node('a.fn', 'function'), start_line: 1, end_line: 1 }
    expect(lineRange(single)).toBe('L1')
  })

  it('renders a span as L<start>–L<end>', () => {
    const span = { ...node('a.fn', 'function'), start_line: 5, end_line: 12 }
    expect(lineRange(span)).toBe('L5\u2013L12')
  })
})

describe('Inspector collapse (tic-88ac)', () => {
  const sel = node('app.loop.run', 'function', 'run')
  const render = (collapsed: boolean) =>
    renderToStaticMarkup(
      createElement(Inspector, {
        node: sel,
        workspace: WORKSPACE,
        absoluteRoot: '/repo',
        collapsed,
        onToggleCollapsed: () => {},
      }),
    )

  it('renders the detail card expanded with an aria-expanded toggle button', () => {
    const html = render(false)
    // The control is a real button reporting the body region as expanded.
    expect(html).toMatch(/<button[^>]*class="inspector-toggle"[^>]*aria-expanded="true"/)
    // The full detail body is present when expanded.
    expect(html).toContain('id="inspector-body"')
    expect(html).toContain('inspector-facts')
    expect(html).toContain('inspector-imports')
  })

  it('collapses to a compact identifying bar still naming the selection', () => {
    const html = render(true)
    expect(html).toMatch(/<button[^>]*class="inspector-toggle"[^>]*aria-expanded="false"/)
    expect(html).toContain('inspector-collapsed')
    // The bar keeps the kind swatch, the name and the kind...
    expect(html).toContain('swatch')
    expect(html).toContain('run')
    expect(html).toContain('function')
    // ...but the detail body is gone.
    expect(html).not.toContain('id="inspector-body"')
    expect(html).not.toContain('inspector-facts')
    expect(html).not.toContain('inspector-imports')
  })

  it('keeps the compact bar identifying the newly selected node', () => {
    const html = renderToStaticMarkup(
      createElement(Inspector, {
        node: node('app.other.DoStuff', 'class', 'DoStuff'),
        workspace: WORKSPACE,
        absoluteRoot: null,
        collapsed: true,
        onToggleCollapsed: () => {},
      }),
    )
    // A changed selection shows through the collapsed bar without re-expanding.
    expect(html).toContain('DoStuff')
    expect(html).toContain('class')
    expect(html).not.toContain('inspector-facts')
  })
})
