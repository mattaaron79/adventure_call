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
}

/** A translucent rounded rect behind a subtree -- the grouping primitive. */
export interface SceneGroup extends Rect {
  id: string
  label: string
  fill: string
  stroke: string
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
}

export interface Scene {
  groups: SceneGroup[]
  edges: SceneEdge[]
  nodes: SceneNode[]
}

export const EMPTY_SCENE: Scene = { groups: [], edges: [], nodes: [] }

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
