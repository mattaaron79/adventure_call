import { describe, expect, it } from 'vitest'
import { DEFAULT_VIEWPORT, type Viewport } from './viewport'
import { CULL_MARGIN, cullScene, visibleWorldRect, type Scene } from './scene'

const at = (x: number, y: number) => ({ x, y, width: 10, height: 10 })

const SCENE: Scene = {
  groups: [{ id: 'g', label: 'g', ...at(0, 0), fill: 'x', stroke: 'y' }],
  edges: [
    { id: 'near', points: [0, 0, 100, 100], stroke: 's' },
    { id: 'far', points: [100000, 100000, 100050, 100050], stroke: 's' },
  ],
  nodes: [
    { id: 'in', label: 'in', ...at(10, 10), fill: 'f', stroke: 's' },
    { id: 'out', label: 'out', ...at(50000, 50000), fill: 'f', stroke: 's' },
  ],
}

const VIEWPORT: Viewport = { ...DEFAULT_VIEWPORT }
const SIZE = { width: 800, height: 600 }

describe('visibleWorldRect', () => {
  it('pads the screen rect by the cull margin on every side', () => {
    const visible = visibleWorldRect(VIEWPORT, SIZE)
    expect(visible.x).toBe(-CULL_MARGIN)
    expect(visible.y).toBe(-CULL_MARGIN)
    expect(visible.width).toBe(SIZE.width + 2 * CULL_MARGIN)
    expect(visible.height).toBe(SIZE.height + 2 * CULL_MARGIN)
  })

  it('stays a rect when the camera is flipped or zoomed', () => {
    const zoomed = visibleWorldRect({ x: 40, y: -40, scale: 0.1 }, SIZE)
    expect(zoomed.width).toBe(SIZE.width / 0.1 + 2 * CULL_MARGIN)
    expect(zoomed.height).toBe(SIZE.height / 0.1 + 2 * CULL_MARGIN)
  })
})

describe('cullScene', () => {
  it('keeps what intersects the visible rect and drops the rest', () => {
    const visible = visibleWorldRect(VIEWPORT, SIZE)
    const culled = cullScene(SCENE, visible)
    expect(culled.nodes.map((n) => n.id)).toEqual(['in'])
    expect(culled.edges.map((e) => e.id)).toEqual(['near'])
    expect(culled.groups.map((g) => g.id)).toEqual(['g'])
  })

  it('keeps an edge whose bounding box merely crosses the view', () => {
    const visible = { x: 90, y: 90, width: 10, height: 10 }
    const culled = cullScene(SCENE, visible)
    expect(culled.edges.map((e) => e.id)).toEqual(['near'])
  })

  it('never mutates the input scene', () => {
    const visible = { x: 99999, y: 99999, width: 1, height: 1 }
    cullScene(SCENE, visible)
    expect(SCENE.nodes).toHaveLength(2)
    expect(SCENE.edges).toHaveLength(2)
  })
})
