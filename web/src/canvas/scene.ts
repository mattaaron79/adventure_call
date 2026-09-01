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
   * Which glyph the focus affordance wears (tic-d7d7): 'go-in' (the default
   * folder-and-arrow) or 'local-view' (the import graph's neighbourhood
   * scope).  A mode names the shape, the canvas owns the button.
   */
  focusIcon?: string
  /**
   * The focus affordance's tooltip (tic-d7d7), e.g. 'Local View'; absent
   * falls back to the generic "Go into <path>".
   */
  focusLabel?: string
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
  /**
   * Junction dots (tic-531b): world-space points where merged edge trunks
   * split, drawn as small non-listening circles in the edge layer.  Pure
   * decoration -- never a hit target, never an id -- so it is a bare point
   * list rather than a scene item type.  Absent unless the mode's layout
   * merged edges, so every other scene is exactly as cheap as before.
   */
  junctions?: readonly Point[]
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

  const laidOut = new Map(scene.nodes.map((node) => [node.id, node]))
  /** How far an endpoint has travelled from where the layout put it. */
  const deltaOf = (id: string, at: Rect): Point => {
    const node = laidOut.get(id)
    if (node === undefined) return ZERO
    return { x: at.x - node.x, y: at.y - node.y }
  }
  const still = (delta: Point): boolean => delta.x === 0 && delta.y === 0

  let rerouted = false
  const edges = scene.edges.map((edge) => {
    if (edge.from === undefined || edge.to === undefined) return edge
    const from = placed.get(edge.from)
    const to = placed.get(edge.to)
    if (!from || !to) return edge
    const fromDelta = deltaOf(edge.from, from)
    const toDelta = deltaOf(edge.to, to)
    // An edge whose ends are both exactly where the layout left them is left
    // exactly as the layout drew it (tic-556d).  This is what keeps a drag
    // local: the import graph's polylines come out of elk with real routing --
    // bends around other files, trunks shared by merged lines -- and re-deriving
    // every edge on every drag threw all of it away, so moving one chip
    // flattened the whole picture into centre-to-centre lines.  Nothing about
    // dragging requires that; only the lines that actually moved need touching.
    if (still(fromDelta) && still(toDelta)) return edge
    rerouted = true
    // The fs-tree's nesting lines are re-elbowed, honouring the wrapped pipe so
    // a dragged edge keeps its inter-column gap instead of reverting to the
    // midpoint.  The pipe is a fixed offset from the child's leading edge, so
    // it is re-derived from the child's current position on every drag and
    // never lives in absolute space (tic-1d7c).
    if (edge.route === 'elbow') {
      const absPipe =
        edge.pipe === undefined
          ? undefined
          : 'dx' in edge.pipe
            ? { x: to.x + edge.pipe.dx }
            : { y: to.y + edge.pipe.dy }
      return { ...edge, points: elbow(from, to, edge.orientation ?? 'lr', absPipe) }
    }
    // Everything else follows its endpoints instead of being redrawn between
    // them (tic-556d): each end travels with the node it is attached to and
    // every bend in between is kept, so a routed line stays the line the layout
    // computed -- attached where it was attached, bending where it bent -- and
    // simply stretches to the node's new position.  A two-point line is the
    // degenerate case and comes out exactly as the old centre-to-centre
    // re-derivation did, since its ends were the centres to begin with.
    return { ...edge, points: translateEnds(edge.points, fromDelta, toDelta) }
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

  // Junction dots (tic-531b) are dropped as soon as anything has actually
  // moved, but no sooner (tic-556d).  They mark where elk's merged trunks
  // split, which is a property of the routing as a whole: an endpoint that
  // travels can leave a dot sitting on a trunk that no longer parts there.
  // With nothing moved there is nothing to invalidate, and a scene that is
  // only reprojected because some *other* node carries an override keeps its
  // dots.
  return { groups, edges, nodes: scene.nodes, ...(rerouted ? {} : { junctions: scene.junctions }) }
}

/** The delta of an endpoint whose node is not in the scene: it cannot have
 *  moved, because there is nothing to have moved it. */
const ZERO: Point = { x: 0, y: 0 }

/**
 * A polyline with its two ends moved by their nodes' deltas and every bend
 * between them untouched (tic-556d).
 *
 * The line keeps the shape the layout gave it and stays attached to the same
 * point on each node -- elk anchors an import on a file's border, not its
 * centre -- so dragging a chip stretches its lines rather than redrawing them.
 */
function translateEnds(points: readonly number[], from: Point, to: Point): number[] {
  const moved = [...points]
  if (moved.length < 2) return moved
  moved[0] += from.x
  moved[1] += from.y
  moved[moved.length - 2] += to.x
  moved[moved.length - 1] += to.y
  return moved
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
    // Junction dots are points, not rects, so they get a plain containment
    // test against the same padded world rect.  `?.` matters: a scene with
    // no junctions allocates no array here, keeping the ordinary pan frame
    // exactly as cheap as it was before merging existed (tic-531b).
    junctions: scene.junctions?.filter(
      (point) =>
        point.x >= visible.x &&
        point.x <= visible.x + visible.width &&
        point.y >= visible.y &&
        point.y <= visible.y + visible.height,
    ),
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

// -- near-pointer edge query (tic-f1d7) ---------------------------------------

/**
 * Distance from `p` to the segment `a`-`b`, all in the same space.
 *
 * The zero-length segment is a real case, not a defensive one: a layout can
 * emit a polyline whose consecutive points coincide (an edge between two
 * nodes at the same spot, an orthogonal route with a doubled corner), and the
 * projection below divides by the segment's squared length.  It degenerates to
 * the distance to the point, which is the right answer anyway.
 */
function distanceToSegment(ax: number, ay: number, bx: number, by: number, p: Point): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - ax, p.y - ay)
  // Projection of ap onto ab, clamped to the segment so a point past either
  // end measures to that end rather than to the infinite line.
  const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2))
  return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy))
}

/**
 * Distance from a point to a flat `[x0, y0, x1, y1, ...]` polyline (tic-f1d7),
 * i.e. the smallest distance to any of its segments.
 *
 * In whatever space the polyline is in -- the caller works in world units and
 * converts a screen-pixel radius by the camera scale, so the pick area stays
 * the same size on screen at any zoom.
 *
 * A polyline with a single point measures to that point; an empty one is
 * infinitely far, so it can never be picked.
 */
export function distanceToPolyline(points: readonly number[], p: Point): number {
  if (points.length < 2) return Infinity
  if (points.length === 2) return Math.hypot(p.x - points[0], p.y - points[1])
  let best = Infinity
  for (let i = 0; i + 3 < points.length; i += 2) {
    const d = distanceToSegment(points[i], points[i + 1], points[i + 2], points[i + 3], p)
    if (d < best) best = d
  }
  return best
}

/** An edge found near the pointer, with how far from it the line runs. */
export interface NearEdge {
  edge: SceneEdge
  distance: number
}

/** What {@link edgesNearPoint} found: the closest few, and how many there were. */
export interface NearEdges {
  /** Nearest first, at most `limit` of them. */
  edges: readonly NearEdge[]
  /**
   * How many edges were within the radius altogether, `edges` included.
   *
   * The count rides along because the caller renders a summary and has to say
   * how much of it it is not showing -- over a merged trunk (tic-531b) the
   * honest answer is "these eight, and forty more", and a capped list alone
   * cannot say that.
   */
  total: number
}

const NOTHING_NEAR: NearEdges = { edges: [], total: 0 }

/**
 * Bounding boxes of edge polylines, memoised on the edge object itself.
 *
 * The reject below has to be cheaper than the maths it is protecting, and
 * computing a box means walking every point of the polyline -- for every edge
 * in the scene, on every probe.  Keyed on the object because scene edges are
 * immutable and stable across frames: culling filters the array, highlight
 * ordering re-sorts it, and reproject hands back the very same object for any
 * edge a drag did not move (tic-556d), so a pointer sweep pays for the boxes
 * once and then reads them.  Weak, so an edge dropped by a re-layout takes its
 * entry with it.
 */
const edgeBoundsCache = new WeakMap<SceneEdge, Rect>()

function cachedEdgeBounds(edge: SceneEdge): Rect {
  let box = edgeBoundsCache.get(edge)
  if (box === undefined) {
    box = edgeBounds(edge.points)
    edgeBoundsCache.set(edge, box)
  }
  return box
}

/**
 * The edges running within `radius` of a world point, nearest first (tic-f1d7).
 *
 * A proximity query rather than hit-testing: the edge layer is deliberately
 * `listening={false}` (hit-testing thousands of polylines on every pointer
 * move is the most expensive thing on this canvas), so the near-pointer
 * connection summary asks geometry instead of asking Konva.  Feed it the
 * CULLED scene -- the one the renderer already computed for this frame -- so
 * the scan is over what is on screen rather than over the whole graph.
 *
 * The cheap bounding-box reject in front of the per-segment maths is what
 * makes it affordable at pointer rates: on a big graph most edges are nowhere
 * near the cursor and cost one rect comparison each.
 */
export function edgesNearPoint(
  scene: Scene,
  at: Point,
  radius: number,
  limit: number,
): NearEdges {
  if (radius <= 0 || limit <= 0) return NOTHING_NEAR
  const near: NearEdge[] = []
  for (const edge of scene.edges) {
    if (edge.points.length < 2) continue
    const box = cachedEdgeBounds(edge)
    if (
      at.x < box.x - radius ||
      at.x > box.x + box.width + radius ||
      at.y < box.y - radius ||
      at.y > box.y + box.height + radius
    ) {
      continue
    }
    const distance = distanceToPolyline(edge.points, at)
    if (distance <= radius) near.push({ edge, distance })
  }
  if (near.length === 0) return NOTHING_NEAR
  near.sort((a, b) => a.distance - b.distance)
  return { edges: near.length > limit ? near.slice(0, limit) : near, total: near.length }
}

/**
 * One `importer -> imported` line per edge, named by the FILES at its ends
 * (tic-f1d7).
 *
 * An edge may be anchored to a row inside an expanded container -- that is
 * what makes hovering one import light exactly its own line (tic-ea9d) -- but
 * a row's label is a symbol name, and a connection summary that read
 * "Thing -> parse" would not tell anyone which files are involved.  So a row
 * or section endpoint is lifted to the element that contains it, and only
 * that far: in the fs-tree a file chip's own parent is its DIRECTORY chip, so
 * walking to the outermost ancestor would name every connection after the
 * root folder.
 *
 * An endpoint naming nothing in the scene falls back to its own id, which for
 * every mode here is a file path -- more use than a placeholder.
 */
export function describeConnections(scene: Scene, edges: readonly SceneEdge[]): string[] {
  if (edges.length === 0) return []
  const byId = new Map(scene.nodes.map((node) => [node.id, node]))
  const nameOf = (id: string | undefined): string => {
    if (id === undefined) return '?'
    let node = byId.get(id)
    const seen = new Set<string>()
    // `seen` terminates the walk as well as de-duplicating it, so a malformed
    // parent cycle cannot hang a pointer move.
    while (
      node !== undefined &&
      (node.role === 'row' || node.role === 'section') &&
      node.parent !== undefined &&
      !seen.has(node.id)
    ) {
      seen.add(node.id)
      node = byId.get(node.parent)
    }
    return node?.label ?? id
  }
  return edges.map((edge) => `${nameOf(edge.from)} → ${nameOf(edge.to)}`)
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
