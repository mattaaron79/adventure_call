/**
 * The VizMode interface (tic-83ec).
 *
 * Extracted from the working fs-tree implementation rather than invented up
 * front: a mode is a pure pipeline -- select which elements exist, measure
 * their intrinsic sizes, lay them out in world space, then style them -- and
 * the app consumes only the assembled {@link ModeOutput}.  Nothing outside a
 * mode's own module may reach past this interface into its internals; the
 * registry (./registry) is the only way a mode is discovered.
 *
 * Every phase is a pure function of its arguments, so React and Konva stay
 * outside and the whole pipeline is trivially testable.
 */
import type { EdgeRoute, Scene, SceneEdge, SceneGroup, SceneNode } from '../canvas/scene'
import type { Rect, Size } from '../canvas/viewport'
import type { Workspace } from '../data/derive'

/** The derived view of the graph export that modes select from. */
export type Derived = Workspace

/** Durable per-mode UI state the phases may read; `expandState` in a preset. */
export interface UiState {
  expanded: Readonly<Record<string, boolean>>
  /**
   * Zoom level of detail (tic-fa56), from {@link ../canvas/lod.lodOf | lodOf}.
   * At the extreme the mode may collapse expanded containers to summary
   * chips; it changes only when a threshold is crossed, never per frame.
   */
  lod?: number
  /**
   * The directory path the scene is drilled into (tic-e7d2); the empty
   * string is the whole graph.  The mode's select phase scopes its scene to
   * this subtree and leaves everything outside it absent.
   */
  focusPath?: string
}

/** An element the mode wants drawn; geometry and styling come later. */
export interface SpecNode {
  id: string
  /** Mode-defined role, e.g. 'dir' | 'file' | 'row' | 'section'. */
  role: string
  label: string
  /** Optional second line, e.g. a symbol count. */
  sublabel?: string
  /** The symbol this element represents, for the inspector; null for none. */
  symbolId: string | null
  /** Whether a plain click on the element toggles expand/collapse. */
  expandable: boolean
  /**
   * When set, the element carries a focus-scope target (tic-e7d2): the canvas
   * renders a 'go into' affordance that drills the scene into this path.  The
   * fs-tree sets it on directory chips; the framework renders it generically.
   */
  focusTo?: string
  /** Elements visually contained by this one, e.g. rows in a container. */
  children: readonly SpecNode[]
  /** Mode-private payload for the later phases; opaque to the framework. */
  data?: unknown
}

/** A translucent backing box, e.g. behind an expanded directory's subtree. */
export interface SpecGroup {
  id: string
  label: string
  /**
   * The spec node whose subtree the box wraps, so the assembled SceneGroup
   * can carry its member ids and follow dragged nodes (tic-1d7c).
   */
  of?: string
}

/** A connection between two elements; layout resolves the ids to points. */
export interface SpecEdge {
  id: string
  from: string
  to: string
  /** Mode-defined kind, e.g. 'nesting' | 'import'. */
  kind: string
  /**
   * How the polyline follows its endpoint rects when a drag moves them
   * (tic-1d7c).  Defaults to 'center'; the fs-tree's nesting lines elbow.
   */
  route?: EdgeRoute
}

/** Which nodes, groups and edges exist -- no geometry, no styling. */
export interface SceneSpec {
  root: SpecNode
  groups: readonly SpecGroup[]
  edges: readonly SpecEdge[]
  /**
   * Optional goto index (tic-bee0): user-facing target -> scene element id.
   * Lets the camera centre on a file/dir/symbol even when its element is
   * filtered out or hidden behind a collapsed container -- the mode resolves
   * such targets to the nearest element that is actually in the scene.  When
   * absent, goto resolves nothing.
   */
  goto?: ReadonlyMap<string, string>
}

/** Intrinsic size per element id, from `measure`. */
export type SizeMap = ReadonlyMap<string, Size>

/** Geometry from `layout`: a world rect per element, a polyline per edge. */
export interface Positioned {
  rects: ReadonlyMap<string, Rect>
  /** Flat `[x0, y0, x1, y1, ...]` polylines, as the canvas `Line` wants. */
  edgePoints: ReadonlyMap<string, readonly number[]>
}

export interface NodeStyle {
  fill: string
  stroke: string
  /** Accent bar down the left edge, e.g. the kind colour. */
  accent?: string
  /** False pins the element in place, e.g. a row inside a container. */
  draggable?: boolean
}

export interface GroupStyle {
  fill: string
  stroke: string
}

export interface EdgeStyle {
  stroke: string
  strokeWidth?: number
  dash?: number[]
  opacity?: number
}

export interface StyleMap {
  nodes: ReadonlyMap<string, NodeStyle>
  groups: ReadonlyMap<string, GroupStyle>
  edges: ReadonlyMap<string, EdgeStyle>
}

/** A boolean param the ModePicker can render as a checkbox. */
export interface ParamToggle {
  /** Key in the mode's params object. */
  key: string
  label: string
}

export interface VizMode<P> {
  id: string
  label: string
  defaultParams: P
  /** Boolean params the ModePicker offers as checkboxes, if any. */
  readonly paramToggles?: readonly ParamToggle[]
  /** Which nodes, groups and edges exist for this data, params and ui state. */
  select(data: Derived, params: P, ui: UiState): SceneSpec
  /** Intrinsic sizes for everything the spec contains. */
  measure(spec: SceneSpec, ui: UiState): SizeMap
  /** World geometry: a rect per element, a polyline per edge. */
  layout(spec: SceneSpec, sizes: SizeMap, params: P): Positioned
  /** Visual treatment per element. */
  style(spec: SceneSpec, params: P): StyleMap
}

/** What the app consumes: everything it needs, nothing of how it was made. */
export interface ModeOutput {
  scene: Scene
  /** World rect of every element, for anchoring and debugging. */
  rects: ReadonlyMap<string, Rect>
  /** Element id -> symbol id, for the inspector. */
  symbolOf: ReadonlyMap<string, string>
  /** User-facing goto target -> scene element id (see {@link SceneSpec.goto}). */
  goto: ReadonlyMap<string, string>
  /** Ids whose activation toggles expand/collapse. */
  expandable: ReadonlySet<string>
}

/** A resolved camera-goto target (tic-bee0). */
export interface GotoTarget {
  /** The scene element to centre on (and select, so the inspector follows). */
  elementId: string
  /** The element's world rect, for the camera to centre on. */
  rect: Rect
}

const EMPTY_GOTO: ReadonlyMap<string, string> = new Map()

/**
 * Resolve a user-facing target -- a file/dir path or a symbol id -- to the
 * scene element the camera should centre on, through the mode's goto index.
 * The mode has already collapsed hidden targets onto their nearest visible
 * ancestor, so a target inside a collapsed container still lands somewhere
 * real.  Returns null when nothing in the current scene can be reached (the
 * target was filtered out entirely), which the caller treats as a silent no-op.
 */
export function resolveGoto(output: ModeOutput, target: string): GotoTarget | null {
  const elementId = output.goto.get(target)
  if (elementId === undefined) return null
  const rect = output.rects.get(elementId)
  if (!rect) return null
  return { elementId, rect }
}

const TRANSPARENT = 'rgba(0,0,0,0)'

/**
 * Run a mode's phases in order and assemble the flat scene the canvas draws.
 * This is the only renderer the app needs: any mode that honours the
 * interface comes out as a `Scene` here.
 */
export function renderMode<P>(
  mode: VizMode<P>,
  data: Derived,
  params: P,
  ui: UiState,
): ModeOutput {
  const spec = mode.select(data, params, ui)
  const sizes = mode.measure(spec, ui)
  const positioned = mode.layout(spec, sizes, params)
  const styles = mode.style(spec, params)
  return assemble(spec, positioned, styles)
}

function assemble(spec: SceneSpec, positioned: Positioned, styles: StyleMap): ModeOutput {
  const nodes: SceneNode[] = []
  const groups: SceneGroup[] = []
  const edges: SceneEdge[] = []
  const symbolOf = new Map<string, string>()
  const expandable = new Set<string>()
  const specById = new Map<string, SpecNode>()

  const visit = (node: SpecNode, parentId?: string): void => {
    specById.set(node.id, node)
    const rect = positioned.rects.get(node.id)
    if (rect) {
      const s = styles.nodes.get(node.id)
      nodes.push({
        ...rect,
        id: node.id,
        label: node.label,
        sublabel: node.sublabel,
        fill: s?.fill ?? TRANSPARENT,
        stroke: s?.stroke ?? TRANSPARENT,
        accent: s?.accent,
        draggable: s?.draggable,
        focusTo: node.focusTo,
        // Containment (tic-2697): the spec node this one lives inside, so
        // reproject can translate it by its ancestors' drag offsets.
        parent: parentId,
      })
    }
    if (node.symbolId !== null) symbolOf.set(node.id, node.symbolId)
    if (node.expandable) expandable.add(node.id)
    for (const child of node.children) visit(child, node.id)
  }
  visit(spec.root, undefined)

  /** The wrapped node and every descendant, so a group box can be recomputed
   *  from member rects after a drag (tic-1d7c). */
  const subtreeIds = (id: string): string[] => {
    const ids: string[] = []
    const walk = (node: SpecNode): void => {
      ids.push(node.id)
      for (const child of node.children) walk(child)
    }
    const start = specById.get(id)
    if (start) walk(start)
    return ids
  }

  for (const group of spec.groups) {
    const rect = positioned.rects.get(group.id)
    if (!rect) continue
    const s = styles.groups.get(group.id)
    groups.push({
      id: group.id,
      label: group.label,
      ...rect,
      fill: s?.fill ?? TRANSPARENT,
      stroke: s?.stroke ?? TRANSPARENT,
      members: group.of !== undefined ? subtreeIds(group.of) : undefined,
    })
  }

  for (const edge of spec.edges) {
    const points = positioned.edgePoints.get(edge.id)
    if (!points) continue
    const s = styles.edges.get(edge.id)
    edges.push({
      id: edge.id,
      points: [...points],
      stroke: s?.stroke ?? TRANSPARENT,
      strokeWidth: s?.strokeWidth,
      dash: s?.dash,
      opacity: s?.opacity,
      from: edge.from,
      to: edge.to,
      route: edge.route,
      kind: edge.kind,
    })
  }

  return {
    scene: { groups, edges, nodes },
    rects: positioned.rects,
    symbolOf,
    goto: spec.goto ?? EMPTY_GOTO,
    expandable,
  }
}
