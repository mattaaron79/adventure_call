/**
 * Headless variable-size tidy tree layout.
 *
 * Layout is a pure function, fully separated from rendering, so it stays
 * testable and swappable (elkjs later).  No canvas or React imports live in
 * this module, and it is deterministic: same input, same output, always.
 *
 * Why not d3-hierarchy: its `tree()` gives every node the same footprint, but
 * this workspace mixes collapsed chips (roughly 120x36) with expanded file
 * containers (several hundred pixels tall), so node sizes vary wildly.  Here
 * children are stacked along one axis, the parent is centred against its
 * child block, and each depth tier is offset along the other axis by the
 * largest node at that tier.  Because every subtree occupies a disjoint
 * extent along the stack axis and every tier a disjoint band along the tier
 * axis, no two nodes can ever overlap, at any mix of node sizes.
 *
 * Canonical space computes tiers along y and stacks siblings along x; the
 * chosen orientation decides which world dimension feeds which axis, so in
 * 'lr' tiers are sized by the widest node per depth and in 'tb' by the
 * tallest.
 */

/** World-space node footprint, as `sizeOf` reports it. */
export interface Size {
  width: number
  height: number
}

/** World-space rectangle, structurally identical to the canvas `Rect`. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The minimal tree shape the layout walks; any domain tree adapts to it. */
export interface TidyNode {
  readonly id: string
  readonly children?: readonly TidyNode[]
}

/** 'lr': tiers advance rightward, siblings stack vertically; 'tb': downward. */
export type Orientation = 'lr' | 'tb'

export interface TidyOptions {
  /** Gap between depth tiers along the tier axis. Default 64. */
  tierGap?: number
  /** Gap between sibling subtrees along the stack axis. Default 12. */
  siblingGap?: number
  /** Tier direction. Default 'lr'. */
  orientation?: Orientation
  /**
   * Children accessor, for trees that keep their children under another name
   * or mix childless leaves with branching nodes.  Defaults to a `children`
   * property, which may be absent on leaves.
   */
  childrenOf?: (node: never) => readonly unknown[]
}

/** A parent-to-child connector as a flat `[x0, y0, x1, y1, ...]` polyline. */
export interface ElbowEdge {
  /** `${parentId}->${childId}`. */
  id: string
  points: number[]
}

export interface ElbowOptions {
  orientation?: Orientation
  childrenOf?: TidyOptions['childrenOf']
}

/** A translucent rounded rect drawn behind a directory subtree. */
export interface GroupBox {
  /** `${nodeId}:group`, so it can never collide with a node id. */
  id: string
  rect: Rect
}

export interface GroupOptions {
  /** Padding added on every side of the subtree bounding box. Default 12. */
  padding?: number
  childrenOf?: TidyOptions['childrenOf']
}

const DEFAULT_TIER_GAP = 64
const DEFAULT_SIBLING_GAP = 12
/** Padding `subtreeGroups` adds around a subtree box; `reproject` reuses it so
 *  a recomputed group box lands exactly where the layout would have put it. */
export const DEFAULT_GROUP_PADDING = 12
const EPSILON = 1e-6

interface Measured {
  id: string
  width: number
  height: number
  depth: number
  children: Measured[]
  /** Extent of the whole subtree along the stack axis, canonical space. */
  extent: number
  /** Placement of this node along the stack axis, canonical space. */
  stack: number
}

/**
 * Lay out a tree of variable-size nodes.
 *
 * Returns one `Rect` per node id, including the root, with the root at the
 * origin.  Children appear in input order, stacked along the stack axis;
 * each parent is centred against its child block; tier `d` starts where tier
 * `d-1` ends plus `tierGap`, measured against the largest node in tier `d-1`.
 */
export function layoutTree<N>(
  root: N,
  sizeOf: (node: N) => Size,
  opts: TidyOptions = {},
): Map<string, Rect> {
  const tierGap = opts.tierGap ?? DEFAULT_TIER_GAP
  const siblingGap = opts.siblingGap ?? DEFAULT_SIBLING_GAP
  const orientation = opts.orientation ?? 'lr'
  const childrenOf = childrenAccessor<N>(opts.childrenOf)

  // Canonical space: tiers along y, siblings stacked along x.  Which world
  // dimension feeds which axis depends on the orientation.
  const stackDim = (s: Size): number => (orientation === 'lr' ? s.height : s.width)
  const tierDim = (s: Size): number => (orientation === 'lr' ? s.width : s.height)

  const seen = new Set<string>()
  const maxTier: number[] = []

  const measure = (node: N, depth: number): Measured => {
    const id = idOf(node)
    if (seen.has(id)) throw new Error(`tidyTree: duplicate node id "${id}"`)
    seen.add(id)

    const size = sizeOf(node)
    if (depth >= maxTier.length) maxTier.push(tierDim(size))
    else maxTier[depth] = Math.max(maxTier[depth], tierDim(size))

    const children = childrenOf(node).map((child) => measure(child as N, depth + 1))
    let extent = stackDim(size)
    if (children.length > 0) {
      let span = siblingGap * (children.length - 1)
      for (const child of children) span += child.extent
      extent = Math.max(extent, span)
    }
    return { id, width: size.width, height: size.height, depth, children, extent, stack: 0 }
  }

  const measured = measure(root, 0)

  // Tier bands are disjoint by construction, which is half of the no-overlap
  // guarantee; disjoint subtree extents along the stack axis are the other.
  const tierPos: number[] = [0]
  for (let d = 1; d < maxTier.length; d++) {
    tierPos[d] = tierPos[d - 1] + maxTier[d - 1] + tierGap
  }

  const place = (m: Measured, start: number): void => {
    m.stack = start
    if (m.children.length === 0) return
    let cursor = start
    for (const child of m.children) {
      place(child, cursor)
      cursor += child.extent + siblingGap
    }
    const span = cursor - siblingGap - start
    const own = stackDim(m)
    // Centre against the child block; a parent larger than its block is
    // clamped to the start of its own (wider) extent.
    m.stack = start + Math.max(0, (span - own) / 2)
  }
  place(measured, 0)

  const rects = new Map<string, Rect>()
  const emit = (m: Measured): void => {
    const tier = tierPos[m.depth]
    rects.set(
      m.id,
      orientation === 'lr'
        ? { x: tier, y: m.stack, width: m.width, height: m.height }
        : { x: m.stack, y: tier, width: m.width, height: m.height },
    )
    for (const child of m.children) emit(child)
  }
  emit(measured)
  return rects
}

/**
 * Orthogonal (elbow) connectors from each parent to each child: out of the
 * parent's leading edge, half way across the gap, along the stack axis to
 * the child's centre, then into the child's leading edge.  A child already
 * aligned with its parent collapses to a straight two-point line.
 */
export function elbowConnectors<N>(
  root: N,
  rects: ReadonlyMap<string, Rect>,
  opts: ElbowOptions = {},
): ElbowEdge[] {
  const orientation = opts.orientation ?? 'lr'
  const childrenOf = childrenAccessor<N>(opts.childrenOf)
  const edges: ElbowEdge[] = []

  const walk = (node: N): void => {
    const parent = rects.get(idOf(node))
    if (!parent) throw new Error(`elbowConnectors: no rect for node "${idOf(node)}"`)
    for (const child of childrenOf(node)) {
      const c = child as N
      const rect = rects.get(idOf(c))
      if (!rect) throw new Error(`elbowConnectors: no rect for node "${idOf(c)}"`)
      edges.push({ id: `${idOf(node)}->${idOf(c)}`, points: elbow(parent, rect, orientation) })
      walk(c)
    }
  }
  walk(root)
  return edges
}

/** Exported for the canvas `reproject` (tic-1d7c), which re-routes a single
 *  edge from moved endpoint rects without re-running the whole layout. */
export function elbow(p: Rect, c: Rect, orientation: Orientation): number[] {
  if (orientation === 'lr') {
    const x0 = p.x + p.width
    const y0 = p.y + p.height / 2
    const x1 = c.x
    const y1 = c.y + c.height / 2
    if (Math.abs(y0 - y1) < EPSILON) return [x0, y0, x1, y1]
    const midX = (x0 + x1) / 2
    return [x0, y0, midX, y0, midX, y1, x1, y1]
  }
  const x0 = p.x + p.width / 2
  const y0 = p.y + p.height
  const x1 = c.x + c.width / 2
  const y1 = c.y
  if (Math.abs(x0 - x1) < EPSILON) return [x0, y0, x1, y1]
  const midY = (y0 + y1) / 2
  return [x0, y0, x0, midY, x1, midY, x1, y1]
}

/**
 * One grouping rectangle per branching node: the bounding box of the node
 * and all of its descendants, padded on every side.  Returned in pre-order,
 * so a renderer can paint groups behind nodes in one pass.  Leaf nodes
 * produce no group.
 */
export function subtreeGroups<N>(
  root: N,
  rects: ReadonlyMap<string, Rect>,
  opts: GroupOptions = {},
): GroupBox[] {
  const padding = opts.padding ?? DEFAULT_GROUP_PADDING
  const childrenOf = childrenAccessor<N>(opts.childrenOf)

  // Pass one, bottom-up: bounding box of each branching subtree.
  const boxes = new Map<string, Rect>()
  const measure = (node: N): Rect => {
    const own = rects.get(idOf(node))
    if (!own) throw new Error(`subtreeGroups: no rect for node "${idOf(node)}"`)
    let box: Rect = { ...own }
    for (const child of childrenOf(node)) {
      box = union(box, measure(child as N))
    }
    boxes.set(idOf(node), box)
    return box
  }
  measure(root)

  // Pass two, pre-order: outer groups before inner ones, so a renderer can
  // paint translucent groups back-to-front in a single pass.
  const groups: GroupBox[] = []
  const emit = (node: N): void => {
    if (childrenOf(node).length > 0) {
      const box = boxes.get(idOf(node))!
      groups.push({
        id: `${idOf(node)}:group`,
        rect: {
          x: box.x - padding,
          y: box.y - padding,
          width: box.width + 2 * padding,
          height: box.height + 2 * padding,
        },
      })
    }
    for (const child of childrenOf(node)) emit(child as N)
  }
  emit(root)
  return groups
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

function idOf(node: unknown): string {
  const id = (node as { id?: unknown }).id
  if (typeof id !== 'string' || id === '') {
    throw new Error('tidyTree: every node needs a non-empty string `id`')
  }
  return id
}

function childrenAccessor<N>(
  override: ((node: never) => readonly unknown[]) | undefined,
): (node: N) => readonly unknown[] {
  if (override) return override as (node: N) => readonly unknown[]
  return (node) => {
    const children = (node as { children?: readonly unknown[] }).children
    return children ?? []
  }
}
