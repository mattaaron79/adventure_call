import { describe, expect, it } from 'vitest'
import { elbow } from '../layout/tidyTree'
import {
  highlightedEdgesLast,
  importEdgesIncidentTo,
  nodesInRect,
  placedRect,
  placedRects,
  reproject,
  sceneBounds,
  type Scene,
} from './scene'

function node(id: string, x: number, y: number, draggable = true) {
  return { id, x, y, width: 100, height: 40, label: id, fill: '#000', stroke: '#111', draggable }
}

const SCENE: Scene = {
  groups: [{ id: 'g', x: -20, y: -20, width: 400, height: 200, label: 'g', fill: '', stroke: '' }],
  edges: [{ id: 'e', points: [0, 0, 600, 40], stroke: '#222' }],
  nodes: [node('a', 0, 0), node('b', 200, 100), node('pinned', 0, 300, false)],
}

/** A scene whose edges and group carry the endpoint/member ids reproject needs. */
const ROUTED: Scene = {
  groups: [
    { id: 'g1', x: -12, y: -12, width: 324, height: 164, label: 'g1', fill: '', stroke: '', members: ['a', 'b'] },
    { id: 'g2', x: 0, y: 0, width: 10, height: 10, label: 'g2', fill: '', stroke: '' },
  ],
  edges: [
    {
      id: 'e1',
      points: elbow({ x: 0, y: 0, width: 100, height: 40 }, { x: 200, y: 100, width: 100, height: 40 }, 'lr'),
      stroke: '#222',
      from: 'a',
      to: 'b',
      route: 'elbow',
    },
    { id: 'e2', points: [250, 120, 450, 20], stroke: '#222', from: 'b', to: 'c' },
    { id: 'e3', points: [0, 0, 10, 10], stroke: '#222' },
  ],
  nodes: [node('a', 0, 0), node('b', 200, 100), node('c', 400, 0)],
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

describe('reproject', () => {
  it('re-routes the edges incident to a dragged node, and only those', () => {
    const { edges } = reproject(ROUTED, { a: { x: 50, y: 200 } })
    // a->b elbows out of a's new right edge into b's left edge.
    expect(edges[0].points).toEqual([150, 220, 175, 220, 175, 120, 200, 120])
    // b and c did not move, so b->c keeps its baked polyline.
    expect(edges[1].points).toEqual([250, 120, 450, 20])
    // An edge without endpoint ids is not re-derivable; it passes through.
    expect(edges[2].points).toEqual([0, 0, 10, 10])
  })

  it('recomputes a group box from the placed rects of its members', () => {
    const { groups } = reproject(ROUTED, { a: { x: 50, y: 200 } })
    // union(a@50,200, b@200,100) padded by the layout's group padding.
    expect(groups[0]).toMatchObject({ x: 38, y: 88, width: 274, height: 164 })
    // A group without members keeps its laid-out rect.
    expect(groups[1]).toMatchObject({ x: 0, y: 0, width: 10, height: 10 })
  })

  it('follows a multi-select drag', () => {
    const { edges, groups } = reproject(ROUTED, { a: { x: 50, y: 200 }, b: { x: 300, y: 200 } })
    // a and b now sit level, so the elbow collapses to a straight line.
    expect(edges[0].points).toEqual([150, 220, 300, 220])
    expect(edges[1].points).toEqual([350, 220, 450, 20])
    expect(groups[0]).toMatchObject({ x: 38, y: 188, width: 374, height: 64 })
  })

  it('defaults to centre-to-centre routing when no route is given', () => {
    const { edges } = reproject(ROUTED, { b: { x: 300, y: 200 } })
    expect(edges[1].points).toEqual([350, 220, 450, 20])
  })

  it('leaves anchor placement alone and does not mutate the scene', () => {
    const before = JSON.stringify(ROUTED)
    const out = reproject(ROUTED, { a: { x: 50, y: 200 }, b: { x: 300, y: 200 } })
    expect(JSON.stringify(ROUTED)).toBe(before)
    // Nodes pass through untouched: overrides apply at render time.
    expect(out.nodes).toBe(ROUTED.nodes)
    expect(out.nodes[0]).toMatchObject({ x: 0, y: 0, width: 100, height: 40 })
  })

  it('is the identity for a scene with no overrides', () => {
    const out = reproject(ROUTED, {})
    expect(out.edges.map((e) => e.points)).toEqual(ROUTED.edges.map((e) => e.points))
    expect(out.groups.map((g) => [g.x, g.y, g.width, g.height])).toEqual(
      ROUTED.groups.map((g) => [g.x, g.y, g.width, g.height]),
    )
  })
})

// -- ancestor translation (tic-2697) ------------------------------------------

/** An expanded container with two rows, a wrapping group and one incident
 *  edge; the rows carry the container as their `parent`. */
const CONTAINER: Scene = {
  groups: [
    {
      id: 'g',
      x: -12,
      y: -12,
      width: 324,
      height: 124,
      label: 'g',
      fill: '',
      stroke: '',
      members: ['c', 'r1', 'r2'],
    },
  ],
  edges: [
    { id: 'e', points: [262, 190, 450, 20], stroke: '#222', from: 'r2', to: 'x', route: 'center' },
  ],
  nodes: [
    node('c', 0, 0),
    { ...node('r1', 12, 40), parent: 'c' },
    { ...node('r2', 12, 70), parent: 'c' },
    node('x', 400, 0),
  ],
}

describe('ancestor translation (tic-2697)', () => {
  it('a moved container carries its rows, which keep their in-container offsets', () => {
    const placed = placedRects(CONTAINER, { c: { x: 200, y: 100 } })
    expect(placed.get('c')).toMatchObject({ x: 200, y: 100, width: 100, height: 40 })
    expect(placed.get('r1')).toMatchObject({ x: 212, y: 140 })
    expect(placed.get('r2')).toMatchObject({ x: 212, y: 170 })
    // Unrelated nodes stay put.
    expect(placed.get('x')).toMatchObject({ x: 400, y: 0 })
  })

  it('re-routes the incident edges and regrows the group box around the moved container', () => {
    const { edges, groups } = reproject(CONTAINER, { c: { x: 200, y: 100 } })
    // r2 moved from (12,70) to (212,170), so its edge leaves the new centre.
    expect(edges[0].points).toEqual([262, 190, 450, 20])
    // union(c@200,100, r1@212,140, r2@212,170) padded by the layout's padding.
    expect(groups[0]).toMatchObject({ x: 188, y: 88, width: 136, height: 134 })
  })

  it('a node with its own override keeps it absolute, without double-counting', () => {
    const placed = placedRects(CONTAINER, { c: { x: 200, y: 100 }, r2: { x: 300, y: 300 } })
    // r2 was dragged by hand: it sits exactly there, not on top of c's delta.
    expect(placed.get('r2')).toMatchObject({ x: 300, y: 300 })
    // r1 still follows the container.
    expect(placed.get('r1')).toMatchObject({ x: 212, y: 140 })
  })

  it('drag-collapsed-then-expand and drag-expanded land the rows in the same place', () => {
    // Drag a collapsed chip by (150,60), then expand: the fresh layout puts
    // the container at (100,200) and the rows at (112,240)/(112,270).
    const collapsedThenExpanded: Scene = {
      groups: [],
      edges: [],
      nodes: [
        node('c', 100, 200),
        { ...node('r1', 112, 240), parent: 'c' },
        { ...node('r2', 112, 270), parent: 'c' },
      ],
    }
    // Drag an already-expanded container by (100,50): it was laid out at
    // (150,210) with rows at (162,250)/(162,280).
    const expandedThenDragged: Scene = {
      groups: [],
      edges: [],
      nodes: [
        node('c', 150, 210),
        { ...node('r1', 162, 250), parent: 'c' },
        { ...node('r2', 162, 280), parent: 'c' },
      ],
    }
    const override = { c: { x: 250, y: 260 } }
    const a = placedRects(collapsedThenExpanded, override)
    const b = placedRects(expandedThenDragged, override)
    expect(a.get('c')).toEqual(b.get('c'))
    expect(a.get('r1')).toEqual(b.get('r1'))
    expect(a.get('r2')).toEqual(b.get('r2'))
    // Both place every row at the container + its in-container offset.
    expect(a.get('r1')).toMatchObject({ x: 262, y: 300 })
    expect(a.get('r2')).toMatchObject({ x: 262, y: 330 })
  })
})

// -- selection highlighting (tic-5393) ----------------------------------------

/** Import and nesting edges sharing endpoints, plus one edge with no kind. */
const HIGHLIGHT: Scene = {
  groups: [],
  nodes: [node('a', 0, 0), node('b', 200, 100), node('row', 0, 200)],
  edges: [
    { id: 'imp:a->b', points: [50, 20, 250, 120], stroke: '#45475a', kind: 'import', from: 'a', to: 'b' },
    { id: 'imp:b->row', points: [250, 120, 50, 220], stroke: '#45475a', kind: 'import', from: 'b', to: 'row' },
    { id: 'nest:a->b', points: [0, 0, 100, 0], stroke: '#45475a', kind: 'nesting', from: 'a', to: 'b' },
    { id: 'no-kind', points: [0, 0, 10, 10], stroke: '#45475a', from: 'a', to: 'row' },
  ],
}

describe('importEdgesIncidentTo', () => {
  it('lights the import edges touching the element, either end', () => {
    expect(importEdgesIncidentTo(HIGHLIGHT, new Set(['a']))).toEqual(new Set(['imp:a->b']))
    expect(importEdgesIncidentTo(HIGHLIGHT, new Set(['b']))).toEqual(
      new Set(['imp:a->b', 'imp:b->row']),
    )
    expect(importEdgesIncidentTo(HIGHLIGHT, new Set(['row']))).toEqual(new Set(['imp:b->row']))
  })

  it('ignores nesting edges and edges without a kind', () => {
    // 'a' is incident to nest:a->b and no-kind too, but only the import is lit.
    expect(importEdgesIncidentTo(HIGHLIGHT, new Set(['a']))).toEqual(new Set(['imp:a->b']))
    expect(importEdgesIncidentTo(HIGHLIGHT, new Set(['row']))).toEqual(new Set(['imp:b->row']))
  })

  it('unions the result across a multi-selection', () => {
    expect(importEdgesIncidentTo(HIGHLIGHT, new Set(['a', 'row']))).toEqual(
      new Set(['imp:a->b', 'imp:b->row']),
    )
  })

  it('is empty for an empty element set or a scene with no import edges', () => {
    expect(importEdgesIncidentTo(HIGHLIGHT, new Set())).toEqual(new Set())
    expect(importEdgesIncidentTo({ groups: [], nodes: [], edges: [] }, new Set(['a']))).toEqual(
      new Set(),
    )
  })
})

describe('highlightedEdgesLast', () => {
  it('returns the input untouched when nothing is highlighted', () => {
    const edges = HIGHLIGHT.edges
    expect(highlightedEdgesLast(edges, new Set())).toBe(edges)
  })

  it('moves highlighted edges to the end, keeping relative order otherwise', () => {
    const ordered = highlightedEdgesLast(HIGHLIGHT.edges, new Set(['imp:a->b', 'imp:b->row']))
    expect(ordered.map((e) => e.id)).toEqual(['nest:a->b', 'no-kind', 'imp:a->b', 'imp:b->row'])
  })

  it('leaves already-last highlights in place', () => {
    const ordered = highlightedEdgesLast(HIGHLIGHT.edges, new Set(['no-kind']))
    expect(ordered.map((e) => e.id)).toEqual(['imp:a->b', 'imp:b->row', 'nest:a->b', 'no-kind'])
  })
})
