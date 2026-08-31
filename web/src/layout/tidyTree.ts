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
   * Sibling wrapping (tic-3d87): how many lines a node's children are packed
   * into along the tier axis.  0 or 1 means no wrapping (the historical
   * single-line layout, unchanged); N >= 2 packs children into that many
   * lines -- N columns in 'lr', N rows in 'tb'.  Each line stacks its
   * children from the same base, so the block is only as deep as its widest
   * line -- a directory with hundreds of leaves becomes a compact block
   * instead of one very long line.  Lines fill up to ceil(k / N) children,
   * and each line clears the tier extent of the subtrees before it, so
   * descendants never overlap the next line.  Default 0.
   */
  wrap?: number
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
  /**
   * The pipe override used to route this edge (see {@link elbow}), stored as
   * a fixed offset from the child's leading edge -- not an absolute world
   * coordinate -- so the canvas `reproject` (tic-1d7c) can re-derive it from
   * the child's current position on every drag instead of a stale value.
   */
  pipe?: { dx: number } | { dy: number }
}

export interface ElbowOptions {
  orientation?: Orientation
  childrenOf?: TidyOptions['childrenOf']
  /** Tier gap; used to space wrapped lines' elbow pipes in the inter-line gap.
   *  Defaults to {@link DEFAULT_TIER_GAP}. */
  tierGap?: number
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
  /** Extra tier-axis offset from being in a wrapped sibling line (tic-3d87). */
  wrapOffset: number
  /** Cached absolute tier reach of the subtree (see reachOf), once known. */
  reach?: number
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
  // Wrapping (tic-3d87): 0/1 keeps the single-line layout; N >= 2 packs each
  // node's children into that many lines along the tier axis.
  const wrap = Math.max(0, Math.floor(Number(opts.wrap ?? 0) || 0))
  const childrenOf = childrenAccessor<N>(opts.childrenOf)

  // Canonical space: tiers along y, siblings stacked along x.  Which world
  // dimension feeds which axis depends on the orientation.
  const stackDim = (s: Size): number => (orientation === 'lr' ? s.height : s.width)
  const tierDim = (s: Size): number => (orientation === 'lr' ? s.width : s.height)

  const seen = new Set<string>()
  const maxTier: number[] = []

  /**
   * Split a node's children into wrap lines: a single line when wrapping is
   * off (or they already fit in `wrap` lines), otherwise `wrap` lines of up
   * to `ceil(n / wrap)` children each, the last line possibly short.  Lines
   * follow child order; every line shares the same stack base (they sit side
   * by side), differing only in their tier offset.
   */
  const wrapLines = (children: Measured[]): Measured[][] => {
    if (wrap <= 1 || children.length <= wrap) return [children]
    const chunk = Math.ceil(children.length / wrap)
    const lines: Measured[][] = []
    for (let i = 0; i < children.length; i += chunk) {
      lines.push(children.slice(i, i + chunk))
    }
    return lines
  }

  const measure = (node: N, depth: number): Measured => {
    const id = idOf(node)
    if (seen.has(id)) throw new Error(`tidyTree: duplicate node id "${id}"`)
    seen.add(id)

    const size = sizeOf(node)
    if (depth >= maxTier.length) maxTier.push(tierDim(size))
    else maxTier[depth] = Math.max(maxTier[depth], tierDim(size))

    const children = childrenOf(node).map((child) => measure(child as N, depth + 1))
    // Stack extent of the subtree.  Wrapped children pack into lines that all
    // start at the same base, so the block is as deep as its widest line, not
    // the sum of every child (tic-3d87).
    let extent = stackDim(size)
    if (children.length > 0) {
      let block = 0
      for (const line of wrapLines(children)) {
        let span = siblingGap * (line.length - 1)
        for (const child of line) span += child.extent
        block = Math.max(block, span)
      }
      extent = Math.max(extent, block)
    }

    return {
      id,
      width: size.width,
      height: size.height,
      depth,
      children,
      extent,
      stack: 0,
      wrapOffset: 0,
    }
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
    // Each wrap line stacks its children from the same base, so wrapped
    // columns (or rows) sit side by side instead of one long stack; the
    // block's extent is the widest line (tic-3d87).  A single line behaves
    // exactly as before.
    let span = 0
    for (const line of wrapLines(m.children)) {
      let cursor = start
      for (const child of line) {
        place(child, cursor)
        cursor += child.extent + siblingGap
      }
      span = Math.max(span, cursor - siblingGap - start)
    }
    const own = stackDim(m)
    // Centre against the child block; a parent larger than its block is
    // clamped to the start of its own (wider) extent.
    m.stack = start + Math.max(0, (span - own) / 2)
  }
  place(measured, 0)

  /**
   * The absolute tier position of the deepest point of a subtree: the largest
   * `tierPos[depth] + wrapOffset + tier dimension` anywhere beneath it.  A
   * wrapped line must clear this, not just the line's own nodes, so its
   * descendants (which sit on later depth bands) are never overlapped by the
   * next wrapped line.  Cached, since a subtree's wrap offsets are fixed once
   * assigned.
   */
  const reachOf = (m: Measured): number => {
    if (m.reach === undefined) {
      let reach = tierPos[m.depth] + m.wrapOffset + tierDim({ width: m.width, height: m.height })
      for (const child of m.children) reach = Math.max(reach, reachOf(child))
      m.reach = reach
    }
    return m.reach
  }

  /**
   * Push wrapped children below their depth band (tic-3d87).  A wrapped node's
   * children pack into lines along the tier axis; line `j` is offset so it
   * clears the deepest point of every earlier line's subtree (reachOf), not
   * just the earlier lines themselves -- so a wrapped row never lands on top
   * of a previous row's expanded descendants.  The offset is additive, so
   * every descendant of a wrapped child inherits the same shift.  With
   * wrapping off every node keeps offset 0 and the layout is exactly the
   * historical one.
   */
  const assignWrapOffsets = (m: Measured, inherited: number): void => {
    m.wrapOffset = inherited
    if (m.children.length === 0) return
    if (wrap <= 1 || m.children.length <= wrap) {
      for (const child of m.children) assignWrapOffsets(child, inherited)
      return
    }
    let acc = inherited
    let deepest = 0
    for (const line of wrapLines(m.children)) {
      for (const child of line) assignWrapOffsets(child, acc)
      let lineReach = 0
      for (const child of line) lineReach = Math.max(lineReach, reachOf(child))
      deepest = Math.max(deepest, lineReach)
      // The next line starts below everything the lines so far contain.
      acc = deepest - tierPos[m.depth + 1] + tierGap
    }
  }
  assignWrapOffsets(measured, 0)

  const rects = new Map<string, Rect>()
  const emit = (m: Measured): void => {
    const tier = tierPos[m.depth] + m.wrapOffset
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
 * parent's leading edge, across the gap, along the stack axis to the child's
 * centre, then into the child's leading edge.  A child already aligned with
 * its parent collapses to a straight two-point line.
 *
 * Wrapped children (tic-3d87) are grouped into lines along the tier axis; the
 * vertical pipe of a later line is placed in the gap before it so it never
 * slices through an earlier line, and every line gets the same entry distance
 * so the pipes read as evenly spaced.  A single line keeps the historical
 * midpoint pipe, so non-wrapped output is unchanged.
 */
export function elbowConnectors<N>(
  root: N,
  rects: ReadonlyMap<string, Rect>,
  opts: ElbowOptions = {},
): ElbowEdge[] {
  const orientation = opts.orientation ?? 'lr'
  const tierGap = opts.tierGap ?? DEFAULT_TIER_GAP
  const childrenOf = childrenAccessor<N>(opts.childrenOf)
  const edges: ElbowEdge[] = []

  const walk = (node: N): void => {
    const parent = rects.get(idOf(node))
    if (!parent) throw new Error(`elbowConnectors: no rect for node "${idOf(node)}"`)

    // A node's direct children group into lines along the tier axis (one
    // column per line in 'lr', one row per line in 'tb'); without wrapping
    // there is exactly one line.
    const lines = new Map<number, Rect[]>()
    for (const child of childrenOf(node)) {
      const c = child as N
      const rect = rects.get(idOf(c))
      if (!rect) throw new Error(`elbowConnectors: no rect for node "${idOf(c)}"`)
      const key = orientation === 'lr' ? rect.x : rect.y
      const bucket = lines.get(key)
      if (bucket) bucket.push(rect)
      else lines.set(key, [rect])
    }

    // For a wrapped block, route each line's pipe a fixed entry distance in
    // front of its line (the inter-line gap is exactly `tierGap`, so half of
    // it clears the preceding line).  The offset is stored relative to the
    // child's leading edge and re-derived at route time, so it never lives in
    // absolute space and stays correct after the child moves.  A single line
    // keeps the midpoint pipe.
    const pipeOf = new Map<number, { dx: number } | { dy: number }>()
    if (lines.size > 1) {
      const entry = tierGap / 2
      for (const [key] of lines) {
        pipeOf.set(key, orientation === 'lr' ? { dx: -entry } : { dy: -entry })
      }
    }

    for (const child of childrenOf(node)) {
      const c = child as N
      const rect = rects.get(idOf(c))
      if (!rect) throw new Error(`elbowConnectors: no rect for node "${idOf(c)}"`)
      const key = orientation === 'lr' ? rect.x : rect.y
      const pipe = pipeOf.get(key)
      // The pipe's shape encodes the axis ('dx' = lr, 'dy' = tb), so narrow on
      // it and derive the absolute coordinate from the child's current rect.
      const pipeHint =
        pipe === undefined
          ? undefined
          : 'dx' in pipe
            ? { x: rect.x + pipe.dx }
            : { y: rect.y + pipe.dy }
      edges.push({
        id: `${idOf(node)}->${idOf(c)}`,
        points: elbow(parent, rect, orientation, pipeHint),
        // Only wrapped edges carry a pipe, so non-wrapped output (and its
        // golden snapshot) is unchanged.
        ...(pipe === undefined ? {} : { pipe }),
      })
      walk(c)
    }
  }
  walk(root)
  return edges
}

/** Exported for the canvas `reproject` (tic-1d7c), which re-routes a single
 *  edge from moved endpoint rects without re-running the whole layout.  The
 *  optional `pipe` overrides the midpoint of the orthogonal run, e.g. to keep
 *  a wrapped line's connector in the inter-column gap. */
export function elbow(
  p: Rect,
  c: Rect,
  orientation: Orientation,
  pipe?: { x: number } | { y: number },
): number[] {
  if (orientation === 'lr') {
    const x0 = p.x + p.width
    const y0 = p.y + p.height / 2
    const x1 = c.x
    const y1 = c.y + c.height / 2
    if (Math.abs(y0 - y1) < EPSILON) return [x0, y0, x1, y1]
    const midX = pipe !== undefined && 'x' in pipe ? pipe.x : (x0 + x1) / 2
    return [x0, y0, midX, y0, midX, y1, x1, y1]
  }
  const x0 = p.x + p.width / 2
  const y0 = p.y + p.height
  const x1 = c.x + c.width / 2
  const y1 = c.y
  if (Math.abs(x0 - x1) < EPSILON) return [x0, y0, x1, y1]
  const midY = pipe !== undefined && 'y' in pipe ? pipe.y : (y0 + y1) / 2
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
