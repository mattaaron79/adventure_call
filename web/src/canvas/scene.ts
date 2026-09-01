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
  /**
   * The mode's role for this element ('file' | 'dir' | 'row' | 'section' |
   * 'stub'), carried through from the spec so the canvas can tell file
   * workspace items apart from rows and directory chips (tic-2996).  Absent
   * on nodes assembled before roles existed; the canvas treats a missing role
   * as 'not a file item'.
   */
  role?: string
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
  /**
   * A camera-goto target (tic-4d7c): when set, the canvas renders a small
   * 'goto' button on the node that flies the camera to this file/dir path via
   * the existing goto event.  Set by the mode on import rows; absent on rows
   * with no resolvable target (e.g. external imports).  Rendered generically.
   */
  gotoTo?: string
  /**
   * The id of the node this one is visually contained by -- a row's container,
   * a container's directory chip (tic-2697).  Set during assembly from the
   * spec's children tree, so `reproject` can translate a node by the
   * accumulated offsets of its ancestors and a moved container carries its
   * rows, group box and edges with it.  Absent on roots.
   */
  parent?: string
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
  /**
   * Whether the edge carries a direction worth showing (tic-2b2b).  The mode
   * sets it on lines whose flow matters -- today only import edges, whose
   * `from` is the importer and `to` the imported -- and the canvas renders a
   * subtle marching-ants animation on it while the edge is highlighted.
   * Absent/undefined means not directional.
   */
  directional?: boolean
  /**
   * The pipe override used to route a wrapped elbow (see tidyTree.elbow),
   * carried from the layout as a fixed offset from the child's leading edge
   * so a drag re-routes the edge with the same inter-line gap pipe, derived
   * from the child's current position rather than a stale absolute value
   * (tic-1d7c).
   */
  pipe?: { dx: number } | { dy: number }
  /** The layout orientation, so reproject re-routes elbows in the right axis. */
  orientation?: 'lr' | 'tb'
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
 * positions are applied at render time via `placedRects`).  Edges without
 * endpoint ids and groups without members are returned as-is.
 */
export function reproject(scene: Scene, overrides: Readonly<Record<string, Point>>): Scene {
  // Ancestor-aware (tic-2697): a row inside a moved container inherits the
  // container's delta, so its edges and group box travel with it.
  const placed = placedRects(scene, overrides)

  const edges = scene.edges.map((edge) => {
    if (edge.from === undefined || edge.to === undefined) return edge
    const from = placed.get(edge.from)
    const to = placed.get(edge.to)
    if (!from || !to) return edge
    // Re-route in the layout's orientation, honouring the wrapped pipe so a
    // dragged edge keeps its inter-column gap instead of reverting to the
    // midpoint.  The pipe is a fixed offset from the child's leading edge, so
    // it is re-derived from the child's current position on every drag and
    // never lives in absolute space (tic-1d7c).
    const absPipe =
      edge.pipe === undefined
        ? undefined
        : 'dx' in edge.pipe
          ? { x: to.x + edge.pipe.dx }
          : { y: to.y + edge.pipe.dy }
    const points =
      edge.route === 'elbow'
        ? elbow(from, to, edge.orientation ?? 'lr', absPipe)
        : centerLine(from, to)
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

/**
 * The ancestor-aware placed rect of every node (tic-2697).
 *
 * A node's own override -- where the user dropped it -- is absolute and wins:
 * the node is drawn exactly there.  A node without one inherits the net
 * movement of its nearest overridden ancestor, so dragging an expanded
 * container carries its rows, group box and incident edges with it, and
 * dragging a collapsed chip then expanding it lands the fresh rows on top of
 * the moved container.  Because a node's own override replaces its laid-out
 * rect rather than adding to it, a parent and child that both carry overrides
 * compose without double-counting: the child sits where it was dropped and
 * the grandchildren follow the child's own delta.
 */
export function placedRects(
  scene: Scene,
  overrides: Readonly<Record<string, Point>>,
): Map<string, Rect> {
  const byId = new Map(scene.nodes.map((node) => [node.id, node]))
  const placed = new Map<string, Rect>()
  for (const node of scene.nodes) {
    const own = overrides[node.id]
    if (own) {
      placed.set(node.id, { x: own.x, y: own.y, width: node.width, height: node.height })
      continue
    }
    const offset = inheritedOffset(node, byId, overrides)
    placed.set(node.id, {
      x: node.x + offset.x,
      y: node.y + offset.y,
      width: node.width,
      height: node.height,
    })
  }
  return placed
}

/** The net movement of a node's nearest overridden ancestor, or zero. */
function inheritedOffset(
  node: SceneNode,
  byId: Map<string, SceneNode>,
  overrides: Readonly<Record<string, Point>>,
): Point {
  let parent = node.parent === undefined ? undefined : byId.get(node.parent)
  while (parent) {
    const own = overrides[parent.id]
    if (own) return { x: own.x - parent.x, y: own.y - parent.y }
    parent = parent.parent === undefined ? undefined : byId.get(parent.parent)
  }
  return { x: 0, y: 0 }
}

/** The bounding box of everything drawn, for fit-to-content. */
export function sceneBounds(
  scene: Scene,
  overrides: Readonly<Record<string, Point>> = {},
): Rect | null {
  const placed = placedRects(scene, overrides)
  const rects: Rect[] = scene.groups.slice()
  for (const node of scene.nodes) {
    const rect = placed.get(node.id)
    if (rect) rects.push(rect)
  }
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
  const placed = placedRects(scene, overrides)
  for (const node of scene.nodes) {
    if (node.draggable === false) continue
    const at = placed.get(node.id)
    if (at && rectsIntersect(at, rect)) hits.push(node.id)
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
 * The nodes at both ends of the given edges -- and the containers those ends
 * live inside (tic-ece1).
 *
 * The companion to {@link importEdgesIncidentTo}: that one answers "which
 * lines light up", this one answers "which chips do those lines land on", so
 * the canvas can lend the far end of a lit connection the hover border.  Both
 * ends are returned, not just the far one -- the caller already paints the
 * hovered/selected element in a louder colour, so including it costs nothing
 * and keeps the function a plain property of the edge set.
 *
 * Ancestors are walked through {@link SceneNode.parent} (populated during
 * assemble, see modes/types.ts) because a mode may anchor an import line to a
 * row inside an expanded container: the row is the endpoint, but the thing a
 * viewer sees at that end of the line is the container it sits in, so the
 * container must light up too.  The `hit.has` check both de-duplicates the
 * walk and terminates it, so a malformed parent cycle cannot hang the render.
 *
 * Edges missing a `from`/`to` (assembled before endpoints were carried) and
 * ids naming no edge in the scene contribute nothing; an empty edge set is
 * empty out, which is the idle case and must stay cheap.
 */
export function endpointNodesOf(scene: Scene, edgeIds: ReadonlySet<string>): Set<string> {
  const hit = new Set<string>()
  if (edgeIds.size === 0) return hit
  const parentOf = new Map<string, string | undefined>()
  for (const node of scene.nodes) parentOf.set(node.id, node.parent)
  const addWithAncestors = (start: string): void => {
    let current: string | undefined = start
    while (current !== undefined && !hit.has(current)) {
      hit.add(current)
      current = parentOf.get(current)
    }
  }
  for (const edge of scene.edges) {
    if (!edgeIds.has(edge.id)) continue
    if (edge.from !== undefined) addWithAncestors(edge.from)
    if (edge.to !== undefined) addWithAncestors(edge.to)
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

// -- marching ants (tic-2b2b) -------------------------------------------------

/**
 * The dash pattern a directional line wears while its ants are marching.
 * Short dashes with a matching gap read as a steady flow of ticks -- subtle at
 * rest, unmistakable once the offset is in motion.
 */
export const ANTS_DASH: number[] = [6, 6]

/**
 * How fast the ants travel along the line, in world pixels per second.  Slow
 * enough to feel directional without demanding attention.
 */
export const ANTS_SPEED_PX_PER_SEC = 60

/**
 * The dash offset at a given animation time (ms).  The offset decreases with
 * time, so the dashes travel from the first point of the polyline (the edge's
 * `from` end) to the last (its `to` end) -- the direction the edge means.
 */
export function antsDashOffset(timeMs: number): number {
  return -(timeMs / 1000) * ANTS_SPEED_PX_PER_SEC
}

/**
 * Whether an edge shows the marching-ants animation.
 *
 * By default (tic-2b2b) it must carry a direction AND be highlighted (coloured,
 * drawn on top) -- a grey, unselected line never animates, because the flow is
 * a property of the lit connection, not of the idle scene.  The 'animate all'
 * toggle (tic-5196) broadens that to every import line, regardless of
 * highlight, so a viewer can watch the whole import flow at once.  Either way
 * only import lines animate: the folder/nesting elbows carry no direction to
 * show, and animating them would just add noise (tic-1ea2).
 */
export function isAntsEdge(edge: SceneEdge, highlighted: boolean, animateAll: boolean): boolean {
  if (animateAll) return edge.kind === 'import'
  return highlighted && edge.directional === true
}
