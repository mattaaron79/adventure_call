import { describe, expect, it } from 'vitest'
import { nodesInRect, placedRect, sceneBounds, type Scene } from './scene'

function node(id: string, x: number, y: number, draggable = true) {
  return { id, x, y, width: 100, height: 40, label: id, fill: '#000', stroke: '#111', draggable }
}

const SCENE: Scene = {
  groups: [{ id: 'g', x: -20, y: -20, width: 400, height: 200, label: 'g', fill: '', stroke: '' }],
  edges: [{ id: 'e', points: [0, 0, 600, 40], stroke: '#222' }],
  nodes: [node('a', 0, 0), node('b', 200, 100), node('pinned', 0, 300, false)],
}

describe('sceneBounds', () => {
  it('covers groups, edge vertices and nodes', () => {
    expect(sceneBounds(SCENE)).toEqual({ x: -20, y: -20, width: 620, height: 360 })
  })

  it('follows a dragged node', () => {
    const bounds = sceneBounds(SCENE, { a: { x: -500, y: 0 } })
    expect(bounds).toEqual({ x: -500, y: -20, width: 1100, height: 360 })
  })

  it('is null for an empty scene', () => {
    expect(sceneBounds({ groups: [], edges: [], nodes: [] })).toBeNull()
  })
})

describe('placedRect', () => {
  it('prefers the override and keeps the size', () => {
    expect(placedRect(node('a', 0, 0), { x: 7, y: 9 })).toEqual({
      x: 7,
      y: 9,
      width: 100,
      height: 40,
    })
  })
})

describe('nodesInRect', () => {
  it('takes anything the band touches, not only what it swallows', () => {
    expect(nodesInRect(SCENE, { x: 90, y: 30, width: 130, height: 80 })).toEqual(['a', 'b'])
  })

  it('tests the dragged position, not the laid-out one', () => {
    const band = { x: -600, y: -10, width: 50, height: 50 }
    expect(nodesInRect(SCENE, band)).toEqual([])
    expect(nodesInRect(SCENE, band, { a: { x: -580, y: 0 } })).toEqual(['a'])
  })

  it('leaves undraggable nodes alone', () => {
    expect(nodesInRect(SCENE, { x: -1000, y: -1000, width: 5000, height: 5000 })).toEqual([
      'a',
      'b',
    ])
  })
})
