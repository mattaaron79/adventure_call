/**
 * Mode 4: the filesystem as a sunburst / multi-level pie (tic-70f9).
 *
 * Where the fs-tree (mode 1) draws the same hierarchy as boxes hanging off a
 * tree, this mode draws it as concentric rings of annular sectors: each
 * directory is an arc whose angular width is its share of the whole, its
 * children carve up that arc on the ring outside it, and a file is the
 * outermost slice.  The eye answers "where does this codebase actually live"
 * -- which directory holds the code -- instead of "what sits next to what".
 *
 * The value a slice's width measures is a param: the count of symbols per
 * file ('symbols', the default -- code mass) or one per file ('files', the
 * file distribution).  Directories aggregate their subtree, so a top-level
 * folder's slice is the sum of the code under it.
 *
 * ## Why a new node shape
 *
 * The canvas only ever drew rectangular chips (SceneNode extends Rect), so a
 * faithful sunburst needed a second shape: each slice is an annular sector
 * (`WedgeGeom`, ../canvas/scene) carried from this mode's `layout` phase to
 * the assembled scene node, and the canvas draws an `Arc` for a node that has
 * one.  The node's own rect stays the sector's axis-aligned bounding box, so
 * every piece of rect machinery -- culling, fit-to-content, marquee, goto --
 * works unchanged.  A slice is pinned, not draggable: a sunburst is one rigid
 * object, and letting a slice drag away would tear the chart apart.
 *
 * Everything here is a pure function of its arguments; React and Konva stay
 * outside, exactly as the other modes.
 */
import type { WedgeGeom } from '../canvas/scene'
import { THEME } from '../canvas/theme'
import type { Rect } from '../canvas/viewport'
import type { FsDir, FsFile, FsNode, Workspace } from '../data/derive'
import { SUNBURST_MODE_ID } from './ids'
import type {
  NodeStyle,
  Positioned,
  SceneSpec,
  SizeMap,
  SpecNode,
  StyleMap,
  UiState,
  VizMode,
} from './types'

/** Mode params; captured into presets and editable via the ModePicker. */
export interface SunburstParams {
  /** What a slice's width means: symbol count per file, or one per file. */
  metric: 'symbols' | 'files'
  /** How many rings deep to draw from the focused folder (itself ring 1). */
  maxDepth: number
}

/** The directory a sector draws, and how much of the pie it owns. */
interface Slice {
  /** Root-relative fs path; '' for the scoped root. */
  path: string
  /** Short display name, e.g. `api` or `api.py`. */
  name: string
  kind: 'dir' | 'file'
  /** The width this slice contributes (see {@link SunburstParams.metric}). */
  value: number
  /** Palette index inherited from this slice's top-level ancestor under the
   *  scoped root; the root itself carries -1. */
  branch: number
  /** The fs depth under the scoped root: 0 for the root itself. */
  depth: number
}

/** World-space thickness of every ring, in the same units the chips use. */
export const RING_THICKNESS = 120

/**
 * The arc a file owns: its symbol count (the fs-tree's "N symbols" sublabel)
 * floored at 1 so a module with no definitions still draws as a file, or 1
 * for the file-count metric.  A file that contributes 0 to either metric
 * would be an invisible sliver, which is not a file at all -- hence the floor.
 */
function fileValue(data: Workspace, file: FsFile, metric: SunburstParams['metric']): number {
  if (metric === 'files') return 1
  return Math.max(1, data.index.byModule.get(file.module.id)?.length ?? 0)
}

/** Every directory/file path's subtree value, over the whole workspace tree.
 *  A directory's value is the sum of its children, so a slice and the slices
 *  that carve it up always add back to the same number. */
function buildValues(data: Workspace, metric: SunburstParams['metric']): Map<string, number> {
  const values = new Map<string, number>()
  const visit = (node: FsNode): number => {
    if (node.type === 'file') {
      const value = fileValue(data, node, metric)
      values.set(node.path, value)
      return value
    }
    let sum = 0
    for (const child of node.children) sum += visit(child)
    values.set(node.path, sum)
    return sum
  }
  visit(data.tree)
  return values
}

/** The directory the sunburst is scoped to (tic-e7d2): the `focusPath`'s
 *  FsDir when set, else the workspace root.  A focusPath that no longer names
 *  a directory (a `/out` refetch or a filter change removed it, or it names a
 *  file) falls back to the whole tree rather than drawing nothing. */
function scopeRoot(data: Workspace, focusPath: string): FsDir {
  if (focusPath === '') return data.tree
  let dir = data.tree
  for (const segment of focusPath.split('/')) {
    const next = dir.children.find((c) => c.type === 'dir' && c.name === segment)
    if (!next || next.type !== 'dir') return data.tree
    dir = next
  }
  return dir
}

/**
 * The sector element id for an fs path: the fs-tree's `dir:<path>` for
 * directories (matching the expand keys the store already understands) and
 * the bare path for a file, so a file sector resolves to its module in the
 * inspector and a focused directory's sector is where the canvas looks for
 * the breadcrumb toolbar.
 */
const idOf = (node: FsNode): string => (node.type === 'dir' ? `dir:${node.path}` : node.path)

// -- select ------------------------------------------------------------------

/**
 * The spec tree for one scope: the focused folder is the hub at the centre,
 * its children carve up the ring around it, and so on for `maxDepth` levels
 * below the folder -- a directory at the last level aggregates its whole
 * subtree into one slice rather than vanishing.  Each node carries its
 * {@link Slice} as the opaque payload, so `layout` and `style` need no
 * fs-tree vocabulary.
 */
function select(data: Workspace, params: SunburstParams, ui: UiState): SceneSpec {
  const scope = scopeRoot(data, ui.focusPath ?? '')
  const values = buildValues(data, params.metric)
  const goto = new Map<string, string>()

  const slice = (path: string, name: string, kind: Slice['kind'], value: number, branch: number, depth: number): Slice =>
    ({ path, name, kind, value, branch, depth })

  /** A sector for one fs node (depth under the scope root); null when the
   *  node contributes no width (an empty directory). */
  const build = (fs: FsNode, depth: number, branch: number): SpecNode | null => {
    const value = values.get(fs.path) ?? 0
    if (value <= 0) return null
    if (fs.type === 'file') {
      goto.set(fs.path, fs.path)
      return {
        id: fs.path,
        role: 'file',
        label: fs.name,
        symbolId: null,
        expandable: false,
        children: [],
        data: slice(fs.path, fs.name, 'file', value, branch, depth),
      }
    }
    // A directory expands only while there is a ring left to draw it in;
    // deeper it aggregates its whole subtree into this one slice.
    const children = depth < params.maxDepth
      ? fs.children.map((child) => build(child, depth + 1, branch)).filter((n): n is SpecNode => n !== null)
      : []
    goto.set(fs.path, `dir:${fs.path}`)
    return {
      id: `dir:${fs.path}`,
      role: 'dir',
      label: fs.name,
      symbolId: null,
      expandable: false,
      // A directory with drawn children is drillable: the go-into affordance
      // rescopes the whole sunburst to it (its own slice then becomes the
      // hub).  Aggregated leaves offer nothing to go into.
      focusTo: children.length > 0 ? fs.path : undefined,
      children,
      data: slice(fs.path, fs.name, 'dir', value, branch, depth),
    }
  }

  // Top-level slices under the scope get a palette index each (the hue that
  // tints the whole subtree); deeper slices inherit their ancestor's.
  const children: SpecNode[] = []
  let branch = 0
  for (const child of scope.children) {
    const built = build(child, 1, branch)
    if (built) {
      children.push(built)
      branch += 1
    }
  }

  const rootData = slice(scope.path, scope.path === '' ? '/' : scope.name, 'dir', values.get(scope.path) ?? 0, -1, 0)
  const root: SpecNode = {
    id: idOf(scope),
    role: 'dir',
    label: rootData.name,
    symbolId: null,
    expandable: false,
    children,
    data: rootData,
  }

  return { root, groups: [], edges: [], goto }
}

// -- measure -----------------------------------------------------------------

function measure(_spec: SceneSpec, _ui: UiState): SizeMap {
  // Wedge geometry comes straight out of `layout`; intrinsic sizes mean
  // nothing to a sector, so there is nothing to measure.
  return new Map()
}

// -- layout ------------------------------------------------------------------

const TAU = Math.PI * 2
/** Slices start at twelve o'clock and sweep clockwise, the reading order of
 *  the fs tree (directories first, then files). */
const START_ANGLE = -Math.PI / 2

/**
 * The tight axis-aligned bounding box of an annular sector of outer radius
 * `r1` about `(cx, cy)` spanning `[a0, a1]` (the WedgeGeom angle convention).
 *
 * The inner arc never reaches further than the outer arc does, so only the
 * outer arc's extremes matter: its two endpoints, plus wherever it crosses a
 * cardinal axis, where cos/sin is at its extreme.  Pure and exported so the
 * rect handed to the scene can be asserted against the drawn shape.
 */
export function sectorBounds(cx: number, cy: number, r1: number, a0: number, a1: number): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const consider = (a: number): void => {
    const x = cx + r1 * Math.cos(a)
    const y = cy + r1 * Math.sin(a)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  consider(a0)
  consider(a1)
  // Cardinal angles inside the arc pull the box out to a full radius along
  // that axis; the endpoints alone would miss a ring that crosses, say, east.
  for (const cardinal of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    if (cardinal > a0 && cardinal < a1) consider(cardinal)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function layout(spec: SceneSpec, _sizes: SizeMap, _params: SunburstParams): Positioned {
  const rects = new Map<string, Rect>()
  const wedges = new Map<string, WedgeGeom>()
  // The deepest ring drawn; each ring adds RING_THICKNESS of radius.  A
  // maxDepth of 1 is just the hub (a single disc), which is a degenerate but
  // harmless view -- the mode degrades to it if a preset says so.
  const outerRadiusOf = (depth: number): number => (depth + 1) * RING_THICKNESS

  const lay = (node: SpecNode, a0: number, a1: number, depth: number): void => {
    const outer = outerRadiusOf(depth)
    const inner = depth * RING_THICKNESS
    rects.set(node.id, sectorBounds(0, 0, outer, a0, a1))
    wedges.set(node.id, {
      cx: 0,
      cy: 0,
      innerRadius: inner,
      outerRadius: outer,
      start: a0,
      end: a1,
    })

    const children = node.children
    if (children.length === 0) return
    // Each child's slice is its share of its parent's arc.  The last child
    // takes exactly what is left (a1 - cursor), so rounding never leaves a
    // hairline gap at the end of a busy ring.
    const total = (node.data as Slice).value
    if (total <= 0) return
    let cursor = a0
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const end = i === children.length - 1 ? a1 : cursor + ((a1 - a0) * (child.data as Slice).value) / total
      lay(child, cursor, end, depth + 1)
      cursor = end
    }
  }

  lay(spec.root, START_ANGLE, START_ANGLE + TAU, 0)
  return { rects, edgePoints: new Map(), wedges }
}

// -- style -------------------------------------------------------------------

/** One palette row per top-level slice, drawn from the app's cool hues so a
 *  sunburst never reads as warmer or more alarming than the code it shows. */
const BRANCH_COLORS: readonly string[] = [
  '#89b4fa', // blue
  '#a6e3a1', // green
  '#f9e2af', // yellow
  '#fab387', // peach
  '#cba6f7', // mauve
  '#94e2d5', // teal
  '#f38ba8', // pink
  '#b4befe', // lavender
]

/** Mix `hex` toward white by `t` in [0, 1], so deeper rings read lighter
 *  than their ancestors' slice without leaving the branch's hue family. */
function lighten(hex: string, t: number): string {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16)
    return Math.round(value + (255 - value) * t)
  }
  const r = channel(1)
  const g = channel(3)
  const b = channel(5)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

const HUB_FILL = THEME.surface2

function style(spec: SceneSpec, _params: SunburstParams): StyleMap {
  const nodes = new Map<string, NodeStyle>()
  const fillOf = (slice: Slice): string => {
    if (slice.branch < 0) return HUB_FILL
    const base = BRANCH_COLORS[slice.branch % BRANCH_COLORS.length]
    // The hub is ring 0; each further ring lightens a step.
    return lighten(base, Math.min(0.5, slice.depth * 0.16))
  }
  const visit = (node: SpecNode): void => {
    const slice = node.data as Slice
    // A sector is pinned: dragging one slice of a rigid chart would tear the
    // picture apart, and the marquee skips pinned nodes just as it does rows.
    nodes.set(node.id, {
      fill: fillOf(slice),
      stroke: THEME.surface,
      draggable: false,
    })
    for (const child of node.children) visit(child)
  }
  visit(spec.root)
  return { nodes, groups: new Map(), edges: new Map() }
}

// -- the mode ----------------------------------------------------------------

/**
 * The registered sunburst mode.  Everything the app can do with it goes
 * through this object; `sectorBounds` and the params type are exported for
 * the mode's own tests.
 */
export const sunburstMode: VizMode<SunburstParams> = {
  id: SUNBURST_MODE_ID,
  label: 'Sunburst',
  defaultParams: { metric: 'symbols', maxDepth: 5 },
  paramOptions: [
    {
      key: 'metric',
      label: 'Slice size',
      help:
        "What a slice's width means. 'Symbols' sizes a file by how many definitions it has, so the " +
        'chart shows where the code actually is; \u2018Files\u2019 gives every file the same width, so it shows ' +
        'where the files are instead. Folders always sum their subtree either way.',
      options: [
        { value: 'symbols', label: 'Symbols' },
        { value: 'files', label: 'Files' },
      ],
    },
  ],
  paramNumbers: [
    {
      key: 'maxDepth',
      label: 'Rings',
      help:
        'How many levels below the focused folder to slice. The focused folder is the centre, and each ' +
        'further level is another ring of folders and files; a folder at the last level merges whatever ' +
        'sits below it into one slice. Raise it to push deeper folders out of that aggregate, or lower it ' +
        'to coarsen the outer rings. The number of top-level slices never changes, only how far in each ' +
        'one is subdivided.',
      min: 2,
      max: 12,
      step: 1,
    },
  ],
  select,
  measure,
  layout,
  style,
}
