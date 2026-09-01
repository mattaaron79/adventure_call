import { describe, expect, it } from 'vitest'
import type { Derived, SceneSpec, SizeMap, SpecNode, StyleMap, UiState, VizMode } from './types'
import { renderMode } from './types'

/**
 * The framework side of the focus affordance (tic-e7d2 / tic-d7d7).
 *
 * `assemble` is what turns a mode's spec into the scene the canvas draws, and
 * a field it forgets to copy is a mode feature that silently does nothing --
 * which is exactly how a mode-named glyph would fail.  Exercised through a
 * stub mode rather than a real one so the assertion is about the interface,
 * not about any mode's data: a mode that names an icon and a tooltip gets
 * them on the scene node, and one that names neither leaves both absent for
 * the canvas to default.
 */
const NODES: SpecNode[] = [
  {
    id: 'plain',
    role: 'dir',
    label: 'plain',
    symbolId: null,
    expandable: false,
    children: [],
    focusTo: 'src',
  },
  {
    id: 'fancy',
    role: 'file',
    label: 'fancy',
    symbolId: null,
    expandable: false,
    children: [],
    focusTo: 'src/a.py',
    focusIcon: 'local-view',
    focusLabel: 'Local View',
  },
]

const stubMode: VizMode<Record<string, never>> = {
  id: 'stub',
  label: 'Stub',
  defaultParams: {},
  select: (): SceneSpec => ({
    root: {
      id: 'root',
      role: 'root',
      label: '',
      symbolId: null,
      expandable: false,
      children: NODES,
    },
    groups: [],
    edges: [],
  }),
  measure: (): SizeMap => new Map(),
  layout: () => ({
    rects: new Map(NODES.map((n) => [n.id, { x: 0, y: 0, width: 10, height: 10 }])),
    edgePoints: new Map(),
  }),
  style: (): StyleMap => ({ nodes: new Map(), groups: new Map(), edges: new Map() }),
}

const EMPTY_UI: UiState = { expanded: {} }
const NO_DATA = null as unknown as Derived

describe('renderMode carries the focus affordance onto the scene', () => {
  const scene = renderMode(stubMode, NO_DATA, {}, EMPTY_UI).scene
  const byId = new Map(scene.nodes.map((n) => [n.id, n]))

  it('copies the mode-named glyph and tooltip through assembly', () => {
    expect(byId.get('fancy')).toMatchObject({
      focusTo: 'src/a.py',
      focusIcon: 'local-view',
      focusLabel: 'Local View',
    })
  })

  it('leaves both absent when the mode names neither, so the canvas defaults', () => {
    const plain = byId.get('plain')!
    expect(plain.focusTo).toBe('src')
    expect(plain.focusIcon).toBeUndefined()
    expect(plain.focusLabel).toBeUndefined()
  })
})
