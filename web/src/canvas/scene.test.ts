import { describe, expect, it } from 'vitest'
import { elbow } from '../layout/tidyTree'
import {
  ANTS_DASH,
  ANTS_SPEED_PX_PER_SEC,
  antsDashOffset,
  describeConnections,
  distanceToPolyline,
  edgesNearPoint,
  endpointNodesOf,
  highlightedEdgesLast,
  importEdgesIncidentTo,
  isAntsEdge,
  nodesInRect,
  placedRect,
  placedRects,
  reproject,
  sceneBounds,
  type Scene,
  type SceneEdge,
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

  it('re-routes a wrapped elbow with a pipe derived from the child, not a stale absolute coordinate', () => {
    // A wrapped second-column edge carries its pipe as a fixed offset from the
    // child's leading edge (tic-3d87); a drag re-derives the pipe from the
    // child's current position instead of reverting to the midpoint.
    const wrapped: Scene = {
      groups: [],
      edges: [
        {
          id: 'p->c2',
          points: [100, 72, 296, 72, 296, 20, 328, 20],
          stroke: '#222',
          from: 'p',
          to: 'c2',
          route: 'elbow',
          orientation: 'lr',
          pipe: { dx: -32 }, // 32px before c2's left edge (328 - 32 = 296)
        },
      ],
      nodes: [node('p', 0, 52), node('c1', 164, 0), node('c2', 328, 0)],
    }
    // Dragging the parent re-routes and keeps the pipe relative to the child.
    const parentDragged = reproject(wrapped, { p: { x: 0, y: 100 } })
    expect(parentDragged.edges[0].points[2]).toBe(296) // not the naive midpoint 214
    // Dragging the child too moves the pipe with it (still 32px before c2).
    const childDragged = reproject(wrapped, { p: { x: 0, y: 100 }, c2: { x: 400, y: 0 } })
    expect(childDragged.edges[0].points[2]).toBe(400 - 32)
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
    // The LAID-OUT line: r2's centre (62,90) to x's centre (450,20).  It has
    // to be the pre-drag geometry -- reproject now moves an edge's ends by how
    // far their nodes have travelled from the layout (tic-556d), so a fixture
    // baked at the post-drag position would be translated a second time.
    { id: 'e', points: [62, 90, 450, 20], stroke: '#222', from: 'r2', to: 'x', route: 'center' },
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

// -- connected endpoints (tic-ece1) -------------------------------------------

/** An import line anchored to a row inside an expanded container inside a
 *  directory chip, so the ancestor walk has two levels to climb; plus an
 *  import edge that never carried endpoints. */
const NESTED: Scene = {
  groups: [],
  nodes: [
    node('dir', 0, 0),
    { ...node('file', 12, 40), parent: 'dir' },
    { ...node('row', 24, 80), parent: 'file' },
    node('far', 400, 0),
  ],
  edges: [
    { id: 'imp:row->far', points: [24, 80, 400, 0], stroke: '#45475a', kind: 'import', from: 'row', to: 'far' },
    { id: 'imp:loose', points: [0, 0, 10, 10], stroke: '#45475a', kind: 'import' },
  ],
}

/** A malformed scene whose parent chain loops, to pin the walk's termination. */
const CYCLIC_PARENTS: Scene = {
  groups: [],
  nodes: [
    { ...node('p', 0, 0), parent: 'q' },
    { ...node('q', 200, 0), parent: 'p' },
  ],
  edges: [
    { id: 'imp:p->q', points: [0, 0, 200, 0], stroke: '#45475a', kind: 'import', from: 'p', to: 'q' },
  ],
}

describe('endpointNodesOf', () => {
  it('returns the nodes at both ends of a lit edge', () => {
    expect(endpointNodesOf(HIGHLIGHT, new Set(['imp:a->b']))).toEqual(new Set(['a', 'b']))
    expect(endpointNodesOf(HIGHLIGHT, new Set(['imp:b->row']))).toEqual(new Set(['b', 'row']))
  })

  it('unions the endpoints across every named edge', () => {
    expect(endpointNodesOf(HIGHLIGHT, new Set(['imp:a->b', 'imp:b->row']))).toEqual(
      new Set(['a', 'b', 'row']),
    )
  })

  it('includes the container ancestors of each endpoint', () => {
    // The line lands on 'row', but what a viewer sees at that end is the file
    // container and the directory chip it sits in, so both light up too.
    expect(endpointNodesOf(NESTED, new Set(['imp:row->far']))).toEqual(
      new Set(['row', 'file', 'dir', 'far']),
    )
  })

  it('ignores edges with no endpoints and ids naming no edge', () => {
    expect(endpointNodesOf(NESTED, new Set(['imp:loose']))).toEqual(new Set())
    expect(endpointNodesOf(NESTED, new Set(['nope']))).toEqual(new Set())
  })

  it('is empty for an empty edge set or a scene with no edges', () => {
    expect(endpointNodesOf(NESTED, new Set())).toEqual(new Set())
    expect(endpointNodesOf({ groups: [], nodes: [], edges: [] }, new Set(['imp:a->b']))).toEqual(
      new Set(),
    )
  })

  it('terminates on a looping parent chain', () => {
    expect(endpointNodesOf(CYCLIC_PARENTS, new Set(['imp:p->q']))).toEqual(new Set(['p', 'q']))
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

// -- marching ants (tic-2b2b) ------------------------------------------------

describe('isAntsEdge', () => {
  const importEdge: SceneEdge = {
    id: 'imp',
    points: [0, 0, 100, 0],
    stroke: '#222',
    kind: 'import',
    directional: true,
  }
  const nesting: SceneEdge = { id: 'nest', points: [0, 0, 100, 0], stroke: '#222', kind: 'nesting' }
  const unkinded: SceneEdge = { id: 'p', points: [0, 0, 100, 0], stroke: '#222' }

  it('animates a highlighted directional import edge', () => {
    expect(isAntsEdge(importEdge, true, false)).toBe(true)
  })

  it('never animates an import edge that is not highlighted', () => {
    expect(isAntsEdge(importEdge, false, false)).toBe(false)
  })

  it('never animates a non-import edge, highlighted or not', () => {
    expect(isAntsEdge(nesting, true, false)).toBe(false)
    expect(isAntsEdge(nesting, false, false)).toBe(false)
  })

  it('animate-all marches every import edge, regardless of highlight (tic-5196)', () => {
    expect(isAntsEdge(importEdge, false, true)).toBe(true)
    expect(isAntsEdge(importEdge, true, true)).toBe(true)
  })

  it('animate-all never animates folder/nesting or unkinded edges (tic-1ea2)', () => {
    expect(isAntsEdge(nesting, true, true)).toBe(false)
    expect(isAntsEdge(nesting, false, true)).toBe(false)
    expect(isAntsEdge(unkinded, true, true)).toBe(false)
  })
})

describe('antsDashOffset', () => {
  it('starts at zero and walks the dashes toward the path end over time', () => {
    expect(antsDashOffset(0)).toBeCloseTo(0)
    const at500 = antsDashOffset(500)
    const at1000 = antsDashOffset(1000)
    // Decreasing offset moves the pattern toward the polyline's end (from ->
    // to); the magnitude follows the configured speed.
    expect(at1000).toBeLessThan(at500)
    expect(at500).toBeCloseTo(-0.5 * ANTS_SPEED_PX_PER_SEC)
    expect(at1000).toBeCloseTo(-1 * ANTS_SPEED_PX_PER_SEC)
  })

  it('uses a short, subtle repeating dash pattern', () => {
    expect(ANTS_DASH).toEqual([6, 6])
  })
})

// -- routed polylines survive a drag (tic-556d) -------------------------------

/**
 * What elk hands the import graph: real polylines with bends, anchored on the
 * files' borders rather than their centres, plus the junction dots of a merged
 * trunk.  `a -> c` and `b -> c` share the trunk that enters c.
 */
const ROUTED_GRAPH: Scene = {
  groups: [],
  edges: [
    { id: 'a->c', points: [50, 40, 50, 70, 250, 70, 250, 100], stroke: '#222', from: 'a', to: 'c' },
    { id: 'b->c', points: [250, 40, 250, 70, 250, 100], stroke: '#222', from: 'b', to: 'c' },
  ],
  nodes: [node('a', 0, 0), node('b', 200, 0), node('c', 200, 100)],
  junctions: [{ x: 250, y: 70 }],
}

describe('reproject keeps the routing a drag did not touch (tic-556d)', () => {
  it('leaves an edge whose ends both stayed put exactly as the layout drew it', () => {
    // The bug: every edge was re-derived on every drag, so moving one chip
    // flattened every routed line in the scene into a centre-to-centre stick.
    const { edges } = reproject(ROUTED_GRAPH, { b: { x: 600, y: 400 } })
    const untouched = edges.find((e) => e.id === 'a->c')!
    expect(untouched.points).toEqual([50, 40, 50, 70, 250, 70, 250, 100])
    expect(untouched).toBe(ROUTED_GRAPH.edges[0])
  })

  it('moves the dragged end and keeps every bend in between', () => {
    const { edges } = reproject(ROUTED_GRAPH, { b: { x: 600, y: 400 } })
    const moved = edges.find((e) => e.id === 'b->c')!
    // b travelled (+400,+400): its end of the line goes with it, the bend at
    // (250,70) and the anchor on c are exactly where elk put them.
    expect(moved.points).toEqual([650, 440, 250, 70, 250, 100])
  })

  it('carries both ends when the whole edge travels', () => {
    const { edges } = reproject(ROUTED_GRAPH, { b: { x: 210, y: 10 }, c: { x: 210, y: 110 } })
    expect(edges.find((e) => e.id === 'b->c')!.points).toEqual([260, 50, 250, 70, 260, 110])
  })

  it('keeps the junction dots while nothing has moved, and drops them once something has', () => {
    // A dot marks where merged trunks part; an endpoint that travels can leave
    // one sitting on routing that no longer parts there.  But a scene
    // reprojected with overrides that move nothing has nothing to invalidate.
    expect(reproject(ROUTED_GRAPH, {}).junctions).toEqual([{ x: 250, y: 70 }])
    expect(reproject(ROUTED_GRAPH, { a: { x: 0, y: 0 } }).junctions).toEqual([{ x: 250, y: 70 }])
    expect(reproject(ROUTED_GRAPH, { b: { x: 600, y: 400 } }).junctions).toBeUndefined()
  })
})

// -- the near-pointer edge query (tic-f1d7) -----------------------------------

describe('distanceToPolyline', () => {
  /** A right-angled route: (0,0) across to (100,0), then down to (100,100). */
  const L = [0, 0, 100, 0, 100, 100]

  it('measures perpendicular to the segment a point sits beside', () => {
    expect(distanceToPolyline(L, { x: 50, y: 10 })).toBe(10)
    expect(distanceToPolyline(L, { x: 90, y: 50 })).toBe(10)
  })

  it('is zero on the line itself, corners included', () => {
    expect(distanceToPolyline(L, { x: 50, y: 0 })).toBe(0)
    expect(distanceToPolyline(L, { x: 100, y: 0 })).toBe(0)
  })

  it('measures to the nearer END for a point past either one', () => {
    // Not to the infinite line the segment lies on: a point beyond the start
    // of a horizontal run is 10 away from that start, not 0 away from the
    // line through it.
    expect(distanceToPolyline(L, { x: -10, y: 0 })).toBe(10)
    expect(distanceToPolyline(L, { x: 100, y: 130 })).toBe(30)
  })

  it('takes the closest of several segments', () => {
    // Nearest the corner: 10 from the horizontal run, ~14 from the vertical.
    expect(distanceToPolyline(L, { x: 90, y: -10 })).toBe(10)
  })

  it('handles a zero-length segment as the distance to that point', () => {
    // A doubled point is a real thing a layout can emit, and the projection
    // maths divides by the segment length.
    expect(distanceToPolyline([50, 50, 50, 50], { x: 50, y: 60 })).toBe(10)
    expect(distanceToPolyline([0, 0, 0, 0, 10, 0], { x: 5, y: 3 })).toBe(3)
  })

  it('measures to a single point, and puts an empty polyline out of reach', () => {
    expect(distanceToPolyline([10, 10], { x: 13, y: 14 })).toBe(5)
    expect(distanceToPolyline([], { x: 0, y: 0 })).toBe(Infinity)
  })
})

/** Three parallel horizontal lines 20 apart, as a bundle running past a point. */
const BUNDLE: Scene = {
  groups: [],
  nodes: [],
  edges: [
    { id: 'near', points: [0, 100, 200, 100], stroke: '#222' },
    { id: 'mid', points: [0, 120, 200, 120], stroke: '#222' },
    { id: 'far', points: [0, 160, 200, 160], stroke: '#222' },
    { id: 'elsewhere', points: [0, 900, 200, 900], stroke: '#222' },
  ],
}

describe('edgesNearPoint', () => {
  it('returns the edges within the radius, nearest first', () => {
    const found = edgesNearPoint(BUNDLE, { x: 100, y: 95 }, 30, 8)
    expect(found.edges.map((e) => e.edge.id)).toEqual(['near', 'mid'])
    expect(found.edges[0].distance).toBe(5)
    expect(found.edges[1].distance).toBe(25)
    expect(found.total).toBe(2)
  })

  it('respects the radius', () => {
    expect(edgesNearPoint(BUNDLE, { x: 100, y: 95 }, 4, 8).edges).toEqual([])
    expect(edgesNearPoint(BUNDLE, { x: 100, y: 95 }, 70, 8).total).toBe(3)
  })

  it('honours the limit while still reporting how many there were', () => {
    // The merged-trunk case: the cap is what keeps the popup off the canvas,
    // and the total is what lets it say how much it is not showing.
    const found = edgesNearPoint(BUNDLE, { x: 100, y: 95 }, 70, 2)
    expect(found.edges.map((e) => e.edge.id)).toEqual(['near', 'mid'])
    expect(found.total).toBe(3)
  })

  it('finds nothing in an empty scene, or with a radius or limit of zero', () => {
    expect(edgesNearPoint({ groups: [], nodes: [], edges: [] }, { x: 0, y: 0 }, 30, 8)).toEqual({
      edges: [],
      total: 0,
    })
    expect(edgesNearPoint(BUNDLE, { x: 100, y: 100 }, 0, 8).edges).toEqual([])
    expect(edgesNearPoint(BUNDLE, { x: 100, y: 100 }, 30, 0).edges).toEqual([])
  })

  it('measures the whole polyline, not just its bounding box', () => {
    // A point inside an L's bounding box but far from either run must not be
    // picked up: the bbox is only the cheap reject in front of the maths.
    const l: Scene = {
      groups: [],
      nodes: [],
      edges: [{ id: 'l', points: [0, 0, 100, 0, 100, 100], stroke: '#222' }],
    }
    expect(edgesNearPoint(l, { x: 10, y: 90 }, 30, 8).edges).toEqual([])
    expect(edgesNearPoint(l, { x: 10, y: 90 }, 120, 8).edges).toHaveLength(1)
  })
})

describe('describeConnections', () => {
  const scene: Scene = {
    groups: [],
    nodes: [
      { ...node('src/a.py', 0, 0), label: 'a.py', role: 'file' },
      { ...node('src/b.py', 300, 0), label: 'b.py', role: 'file' },
      { ...node('dir:src', 0, 0), label: 'src', role: 'dir' },
      { ...node('row:src/a.py:imp:1', 10, 10), label: 'Thing', role: 'row', parent: 'src/a.py' },
    ],
    edges: [],
  }

  it('names both ends by their node labels', () => {
    const line = { id: 'e', points: [0, 0, 1, 1], stroke: '', from: 'src/a.py', to: 'src/b.py' }
    expect(describeConnections(scene, [line])).toEqual(['a.py → b.py'])
  })

  it('lifts a row endpoint to the file container it sits in', () => {
    // A row's own label is a symbol name; "Thing → b.py" would not say which
    // files are connected, which is the whole point of the summary.
    const line = {
      id: 'e',
      points: [0, 0, 1, 1],
      stroke: '',
      from: 'row:src/a.py:imp:1',
      to: 'src/b.py',
    }
    expect(describeConnections(scene, [line])).toEqual(['a.py → b.py'])
  })

  it('does not lift a file to its directory', () => {
    // In the fs-tree a file chip's parent IS its directory chip, so walking to
    // the outermost ancestor would name every connection after the root folder.
    const withParent: Scene = {
      ...scene,
      nodes: scene.nodes.map((n) => (n.id === 'src/a.py' ? { ...n, parent: 'dir:src' } : n)),
    }
    const line = { id: 'e', points: [0, 0, 1, 1], stroke: '', from: 'src/a.py', to: 'src/b.py' }
    expect(describeConnections(withParent, [line])).toEqual(['a.py → b.py'])
  })

  it('falls back to the endpoint id when the node is not in the scene', () => {
    // An edge can cross the viewport with both its files culled out of it; the
    // id is a file path, which is more use than a placeholder.
    const line = { id: 'e', points: [0, 0, 1, 1], stroke: '', from: 'src/gone.py', to: 'src/b.py' }
    expect(describeConnections(scene, [line])).toEqual(['src/gone.py → b.py'])
  })

  it('is empty for no edges', () => {
    expect(describeConnections(scene, [])).toEqual([])
  })
})
