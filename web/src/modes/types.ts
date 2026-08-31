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
import type { Scene, SceneEdge, SceneGroup, SceneNode } from '../canvas/scene'
import type { Rect, Size } from '../canvas/viewport'
import type { Workspace } from '../data/derive'

/** The derived view of the graph export that modes select from. */
export type Derived = Workspace

/** Durable per-mode UI state the phases may read; `expandState` in a preset. */
export interface UiState {
  expanded: Readonly<Record<string, boolean>>
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
  /** Elements visually contained by this one, e.g. rows in a container. */
  children: readonly SpecNode[]
  /** Mode-private payload for the later phases; opaque to the framework. */
  data?: unknown
}

/** A translucent backing box, e.g. behind an expanded directory's subtree. */
export interface SpecGroup {
  id: string
  label: string
}

/** A connection between two elements; layout resolves the ids to points. */
export interface SpecEdge {
  id: string
  from: string
  to: string
  /** Mode-defined kind, e.g. 'nesting' | 'import'. */
  kind: string
}

/** Which nodes, groups and edges exist -- no geometry, no styling. */
export interface SceneSpec {
  root: SpecNode
  groups: readonly SpecGroup[]
  edges: readonly SpecEdge[]
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
  /** Ids whose activation toggles expand/collapse. */
  expandable: ReadonlySet<string>
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

  const visit = (node: SpecNode): void => {
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
      })
    }
    if (node.symbolId !== null) symbolOf.set(node.id, node.symbolId)
    if (node.expandable) expandable.add(node.id)
    for (const child of node.children) visit(child)
  }
  visit(spec.root)

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
    })
  }

  return { scene: { groups, edges, nodes }, rects: positioned.rects, symbolOf, expandable }
}
