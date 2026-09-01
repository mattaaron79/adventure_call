import type { ElkNode } from 'elkjs/lib/elk-api.js'
import { describe, expect, it } from 'vitest'
import { fromElkResult, toElkNode } from './elkConvert'
import type { ElkGraphInput } from './elkTypes'

const GRAPH: ElkGraphInput = {
  id: 'root',
  nodes: [
    { id: 'a', width: 120, height: 36 },
    {
      id: 'b',
      width: 200,
      height: 80,
      ports: [{ id: 'b:row0' }],
      children: [{ id: 'b:child', width: 10, height: 10 }],
    },
  ],
  edges: [{ id: 'a->b:row0', source: 'a', target: 'b:row0' }],
}

describe('toElkNode', () => {
  it('sets the layered algorithm with direction DOWN so sources rank above targets', () => {
    const elkNode = toElkNode(GRAPH)
    expect(elkNode.layoutOptions).toMatchObject({
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
    })
  })

  it('applies default spacing matching tidyTree gaps, overridable per call', () => {
    expect(toElkNode(GRAPH).layoutOptions).toMatchObject({
      'elk.layered.spacing.nodeNodeBetweenLayers': '64',
      'elk.spacing.nodeNode': '12',
    })
    expect(toElkNode(GRAPH, { layerGap: 32, nodeGap: 8 }).layoutOptions).toMatchObject({
      'elk.layered.spacing.nodeNodeBetweenLayers': '32',
      'elk.spacing.nodeNode': '8',
    })
  })

  it('emits the layered mergeEdges option for both values of the toggle', () => {
    // Always emitted, never conditionally omitted, so the option set has the
    // same shape whichever way the checkbox is set (tic-531b).
    expect(toElkNode(GRAPH).layoutOptions).toMatchObject({
      'elk.layered.mergeEdges': 'false',
    })
    expect(toElkNode(GRAPH, { mergeEdges: false }).layoutOptions).toMatchObject({
      'elk.layered.mergeEdges': 'false',
    })
    expect(toElkNode(GRAPH, { mergeEdges: true }).layoutOptions).toMatchObject({
      'elk.layered.mergeEdges': 'true',
    })
  })

  it('carries node sizes, nested children and ports through', () => {
    const elkNode = toElkNode(GRAPH)
    const [a, b] = elkNode.children!
    expect(a).toMatchObject({ id: 'a', width: 120, height: 36 })
    expect(b).toMatchObject({ id: 'b', width: 200, height: 80 })
    expect(b.ports).toEqual([{ id: 'b:row0', width: 1, height: 1 }])
    expect(b.children).toEqual([{ id: 'b:child', width: 10, height: 10 }])
  })

  it('turns each edge into a single-source, single-target ElkExtendedEdge', () => {
    const elkNode = toElkNode(GRAPH)
    expect(elkNode.edges).toEqual([{ id: 'a->b:row0', sources: ['a'], targets: ['b:row0'] }])
  })

  it('omits ports/children keys entirely when a node has none', () => {
    const elkNode = toElkNode(GRAPH)
    const [a] = elkNode.children!
    expect(a).not.toHaveProperty('ports')
    expect(a).not.toHaveProperty('children')
  })
})

describe('fromElkResult', () => {
  it('resolves a flat child to an absolute rect from the root origin', () => {
    const laidOut: ElkNode = {
      id: 'root',
      x: 0,
      y: 0,
      children: [{ id: 'a', x: 10, y: 20, width: 120, height: 36 }],
    }
    const result = fromElkResult(laidOut)
    expect(result.rects.get('a')).toEqual({ x: 10, y: 20, width: 120, height: 36 })
    expect(result.rects.has('root')).toBe(false)
  })

  it('accumulates ancestor offsets for a nested child', () => {
    const laidOut: ElkNode = {
      id: 'root',
      children: [
        {
          id: 'b',
          x: 100,
          y: 50,
          width: 200,
          height: 80,
          children: [{ id: 'b:child', x: 5, y: 5, width: 10, height: 10 }],
        },
      ],
    }
    const result = fromElkResult(laidOut)
    expect(result.rects.get('b:child')).toEqual({ x: 105, y: 55, width: 10, height: 10 })
  })

  it('resolves a port rect relative to its owning node, in absolute space', () => {
    const laidOut: ElkNode = {
      id: 'root',
      children: [
        {
          id: 'b',
          x: 100,
          y: 50,
          width: 200,
          height: 80,
          ports: [{ id: 'b:row0', x: 0, y: 30, width: 1, height: 12 }],
        },
      ],
    }
    const result = fromElkResult(laidOut)
    expect(result.rects.get('b:row0')).toEqual({ x: 100, y: 80, width: 1, height: 12 })
  })

  it('flattens an edge section (with bend points) into a world-space polyline', () => {
    const laidOut: ElkNode = {
      id: 'root',
      x: 0,
      y: 0,
      children: [
        { id: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'b', x: 100, y: 100, width: 10, height: 10 },
      ],
      edges: [
        {
          id: 'a->b',
          sources: ['a'],
          targets: ['b'],
          sections: [
            {
              id: 'a->b_s0',
              startPoint: { x: 10, y: 5 },
              bendPoints: [{ x: 50, y: 5 }],
              endPoint: { x: 100, y: 105 },
            },
          ],
        },
      ],
    }
    const result = fromElkResult(laidOut)
    expect(result.edgePoints.get('a->b')).toEqual([10, 5, 50, 5, 100, 105])
  })

  it('reads an edge junction points and offsets them by the ancestor origin', () => {
    // elk reports junction points in the coordinate space of the node that
    // owns the edge, exactly like the section start/bend/end points, so they
    // take the identical accumulated offset (tic-531b).
    const laidOut: ElkNode = {
      id: 'root',
      children: [
        {
          id: 'box',
          x: 1000,
          y: 500,
          width: 400,
          height: 400,
          children: [
            { id: 'a', x: 0, y: 0, width: 10, height: 10 },
            { id: 'b', x: 100, y: 100, width: 10, height: 10 },
          ],
          edges: [
            {
              id: 'a->b',
              sources: ['a'],
              targets: ['b'],
              sections: [{ id: 'a->b_s0', startPoint: { x: 5, y: 10 }, endPoint: { x: 5, y: 100 } }],
              junctionPoints: [
                { x: 5, y: 60 },
                { x: 5, y: 80 },
              ],
            },
          ],
        },
      ],
    }
    const result = fromElkResult(laidOut)
    expect(result.junctionPoints.get('a->b')).toEqual([
      { x: 1005, y: 560 },
      { x: 1005, y: 580 },
    ])
  })

  it('leaves an edge elk computed no junctions for out of the map entirely', () => {
    // The unmerged layout is the default, and it must not pay for a feature
    // it never used.
    const laidOut: ElkNode = {
      id: 'root',
      children: [{ id: 'a', x: 0, y: 0, width: 10, height: 10 }],
      edges: [
        {
          id: 'a->a',
          sources: ['a'],
          targets: ['a'],
          sections: [{ id: 's', startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } }],
          junctionPoints: [],
        },
      ],
    }
    const result = fromElkResult(laidOut)
    expect(result.junctionPoints.has('a->a')).toBe(false)
    expect(result.junctionPoints.size).toBe(0)
  })
})
