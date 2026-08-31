/**
 * What the workspace draws.
 *
 * A `Scene` is flat, positioned and free of behaviour: every item already
 * carries its world rectangle, so the canvas has no opinion about layout and
 * the layout engine (tic-cdeb) has no opinion about rendering.  Modes
 * (tic-83ec) will produce a Scene; the canvas primitives here render any of
 * them.  Ids are the currency of selection, hover, expansion and position
 * overrides, so they must be stable across a re-layout.
 */
import { DEFAULT_GROUP_PADDING, elbow } from '../layout/tidyTree'
import {
  rectsIntersect,
  screenToWorld,
  unionRects,
  type Point,
  type Rect,
  type Size,
  type Viewport,
} from './viewport'

export interface SceneNode extends Rect {
  id: string
  label: string
  /** Optional second line, e.g. a symbol count. Dropped when it will not fit. */
  sublabel?: string
  fill: string
  stroke: string
  /** Accent bar down the left edge; the kind colour in the fs-tree mode. */
  accent?: string
  /** False pins the node in place, e.g. a header row inside a container. */
  draggable?: boolean
  /**
   * A focus-scope target (tic-e7d2): when set, the canvas renders a 'go into'
   * affordance on the node that drills the scene into this path.  Absent
   * means no affordance.  Set by the mode, rendered generically.
   */
  focusTo?: string
}

/** How an edge's polyline is derived from its endpoint rects. */
export type EdgeRoute = 'elbow' | 'center'

/** A translucent rounded rect behind a subtree -- the grouping primitive. */
export interface SceneGroup extends Rect {
  id: string
  label: string
  fill: string
  stroke: string
  /**
   * The node ids the box wraps, so its bounds can be recomputed when a drag
   * moves members (tic-1d7c).  Absent on groups that were never given a
   * subtree; those keep their laid-out rect forever.
   */
  members?: readonly string[]
}

/** A polyline in world coordinates. Elbow routing lives in the layout module. */
export interface SceneEdge {
  id: string
  /** Flat `[x0, y0, x1, y1, ...]`, as Konva's `Line` wants it. */
  points: number[]
  stroke: string
  strokeWidth?: number
  dash?: number[]
  opacity?: number
  /**
   * Endpoint element ids, carried through from the spec so a drag can
   * re-route the polyline (tic-1d7c).  Both must be present for the edge to
   * be re-derivable; edges without them keep their laid-out points.
   */
  from?: string
  to?: string
  /** How the polyline follows the endpoint rects. Default 'center'. */
  route?: EdgeRoute
  /**
   * The spec's edge kind (e.g. 'nesting' | 'import'), carried through from
   * the spec so the canvas can tell import lines apart for selection
   * highlighting (tic-5393).  Absent on edges that never had a kind.
   */
  kind?: string
}

export interface Scene {
  groups: SceneGroup[]
  edges: SceneEdge[]
  nodes: SceneNode[]
}

export const EMPTY_SCENE: Scene = { groups: [], edges: [], nodes: [] }

/**
 * Re-derive edge polylines and group boxes from the placed rects (tic-1d7c).
 *
 * A drag override moves a node chip, but the scene's edge points and group
 * rects were baked by the mode's layout phase and know nothing about it.
 * This is the missing half: given the scene and the current overrides, it
 * returns a new Scene whose edges are re-routed between the placed endpoint
 * rects and whose group boxes are the padded bounding box of their placed
 * members.  The routing itself is not duplicated here -- elbows come from
 * {@link ../layout/tidyTree.elbow | elbow}, the same function the layout
 * phase used, so a reprojected edge lands exactly where a re-layout would
 * have put it.
 *
 * Pure: `scene` is never mutated, and nodes pass through untouched (their
 * positions are applied at render time via `placedRect`).  Edges without
 * endpoint ids and groups without members are returned as-is.
 */
export function reproject(scene: Scene, overrides: Readonly<Record<string, Point>>): Scene {
  const placed = new Map<string, Rect>()
  for (const node of scene.nodes) placed.set(node.id, placedRect(node, overrides[node.id]))

  const edges = scene.edges.map((edge) => {
    if (edge.from === undefined || edge.to === undefined) return edge
    const from = placed.get(edge.from)
    const to = placed.get(edge.to)
    if (!from || !to) return edge
    const points = edge.route === 'elbow' ? elbow(from, to, 'lr') : centerLine(from, to)
    return { ...edge, points }
  })

  const groups = scene.groups.map((group) => {
    if (!group.members || group.members.length === 0) return group
    const box = unionRects(
      group.members
        .map((id) => placed.get(id))
        .filter((rect): rect is Rect => rect !== undefined),
    )
    if (!box) return group
    return {
      ...group,
      x: box.x - DEFAULT_GROUP_PADDING,
      y: box.y - DEFAULT_GROUP_PADDING,
      width: box.width + 2 * DEFAULT_GROUP_PADDING,
      height: box.height + 2 * DEFAULT_GROUP_PADDING,
    }
  })

  return { groups, edges, nodes: scene.nodes }
}

/** Straight line between the centres of two rects -- the import-line routing. */
function centerLine(a: Rect, b: Rect): number[] {
  return [a.x + a.width / 2, a.y + a.height / 2, b.x + b.width / 2, b.y + b.height / 2]
}

/** Where a node actually sits, once the user's drag override is applied. */
export function placedRect(node: SceneNode, override: Point | undefined): Rect {
  if (!override) return node
  return { x: override.x, y: override.y, width: node.width, height: node.height }
}

/** The bounding box of everything drawn, for fit-to-content. */
export function sceneBounds(
  scene: Scene,
  overrides: Readonly<Record<string, Point>> = {},
): Rect | null {
  const rects: Rect[] = scene.groups.slice()
  for (const node of scene.nodes) rects.push(placedRect(node, overrides[node.id]))
  for (const edge of scene.edges) {
    for (let i = 0; i + 1 < edge.points.length; i += 2) {
      rects.push({ x: edge.points[i], y: edge.points[i + 1], width: 0, height: 0 })
    }
  }
  return unionRects(rects)
}

/** Ids of the nodes a marquee touches. Intersection, not containment: a rubber
 *  band that has to swallow a node whole is maddening at low zoom. */
export function nodesInRect(
  scene: Scene,
  rect: Rect,
  overrides: Readonly<Record<string, Point>> = {},
): string[] {
  const hits: string[] = []
  for (const node of scene.nodes) {
    if (node.draggable === false) continue
    if (rectsIntersect(placedRect(node, overrides[node.id]), rect)) hits.push(node.id)
  }
  return hits
}

// -- viewport culling (tic-fa56) ----------------------------------------------

/** World-space margin around the viewport, so items slide in already drawn
 *  instead of popping into existence at the screen edge. */
export const CULL_MARGIN = 200

/** The world rect the screen shows, padded by `margin` on every side. */
export function visibleWorldRect(viewport: Viewport, size: Size, margin = CULL_MARGIN): Rect {
  const a = screenToWorld(viewport, { x: 0, y: 0 })
  const b = screenToWorld(viewport, { x: size.width, y: size.height })
  return {
    x: Math.min(a.x, b.x) - margin,
    y: Math.min(a.y, b.y) - margin,
    width: Math.abs(b.x - a.x) + 2 * margin,
    height: Math.abs(b.y - a.y) + 2 * margin,
  }
}

function edgeBounds(points: readonly number[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i + 1 < points.length; i += 2) {
    if (points[i] < minX) minX = points[i]
    if (points[i] > maxX) maxX = points[i]
    if (points[i + 1] < minY) minY = points[i + 1]
    if (points[i + 1] > maxY) maxY = points[i + 1]
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * The part of the scene that intersects the visible world rect.  Culling is a
 * render-time filter over the already-computed scene, not a scene-level phase:
 * it runs per pan frame, where filtering a few thousand rects is free but a
 * re-layout would not be.  Selection, marquee and fit keep using the full
 * scene, so off-screen items are still hit-testable in the model.
 */
export function cullScene(scene: Scene, visible: Rect): Scene {
  const inView = (r: Rect) => rectsIntersect(r, visible)
  return {
    groups: scene.groups.filter(inView),
    edges: scene.edges.filter((edge) => inView(edgeBounds(edge.points))),
    nodes: scene.nodes.filter(inView),
  }
}

// -- selection highlighting (tic-5393) ---------------------------------------

/**
 * The import edges incident to any of the given element ids.
 *
 * Incidence follows the scene's anchors, which the mode has already shaped to
 * the expand state (fsTree's anchorId): a collapsed file's import edges anchor
 * to the file chip, an expanded file's to the contributing rows.  Selecting a
 * collapsed file therefore lights every import its symbols own, while
 * selecting one row inside an expanded container lights only that row's.  A
 * union is returned, so multi-selection (or a selection plus a hover) lights
 * every edge touching any of the ids.  Only edges the mode labelled 'import'
 * are considered -- nesting edges keep their current treatment.
 */
export function importEdgesIncidentTo(
  scene: Scene,
  elementIds: ReadonlySet<string>,
): Set<string> {
  const hit = new Set<string>()
  for (const edge of scene.edges) {
    if (edge.kind !== 'import') continue
    if (
      (edge.from !== undefined && elementIds.has(edge.from)) ||
      (edge.to !== undefined && elementIds.has(edge.to))
    ) {
      hit.add(edge.id)
    }
  }
  return hit
}

/**
 * Reorder edges so highlighted ones draw last -- and therefore on top of the
 * grey neighbours (tic-5393).  Stable one-pass partition; when nothing is
 * highlighted the input array is returned untouched, so the common no-selection
 * case (and every pan/zoom frame) pays nothing extra.
 */
export function highlightedEdgesLast(
  edges: SceneEdge[],
  highlightIds: ReadonlySet<string>,
): SceneEdge[] {
  if (highlightIds.size === 0) return edges
  const plain: SceneEdge[] = []
  const lit: SceneEdge[] = []
  for (const edge of edges) {
    if (highlightIds.has(edge.id)) lit.push(edge)
    else plain.push(edge)
  }
  return [...plain, ...lit]
}
