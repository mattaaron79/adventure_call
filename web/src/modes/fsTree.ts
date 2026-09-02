/**
 * Mode 1: the filesystem as a tiered spatial graph.
 *
 * Directories and files come from the derived fs tree (tic-3399) and are
 * placed by the tidy-tree engine (tic-cdeb): tiers advance rightward, a
 * directory's subtree hangs off its chip, and a translucent group box backs
 * each expanded directory.  A collapsed file is a chip; an expanded file is a
 * container of detail rows.
 *
 * That container vocabulary -- the rows, their sections and the box geometry
 * -- started here and now lives in ./fileDetail (tic-0680), because the
 * import-graph mode wants the same expanded-file treatment and one mode may
 * not import another.  This mode asks for the default sections only
 * (Imports, Classes, Functions, Variables), so the extraction is invisible
 * on screen.  The row design still buys what it always did: every row is an
 * individually hit-testable element carrying its own symbol id, so an import
 * line anchors to the file while it is collapsed and to the specific
 * contributing sub-item once it is expanded.
 *
 * Since tic-83ec this mode is a `VizMode`: the four phases -- select, measure,
 * layout, style -- are pure functions, and the app renders it only through
 * `renderMode`.  Everything here is a pure function of its arguments; React
 * and Konva stay outside.
 */
import type { FsDir, FsFile, FsNode, Workspace } from '../data/derive'
import type { SymbolKind } from '../data/types'
import { KIND_COLOR, THEME } from '../canvas/theme'
import { CONTAINER, fileRows, layoutContainer, rowId, type Row } from './fileDetail'
import { FS_TREE_MODE_ID, IMPORT_GRAPH_MODE_ID } from './ids'
import {
  elbow,
  elbowConnectors,
  layoutTree,
  subtreeGroups,
  type Orientation,
  type Size,
} from '../layout/tidyTree'
import type {
  GroupStyle,
  EdgeStyle,
  NodeStyle,
  Positioned,
  SceneSpec,
  SizeMap,
  SpecEdge,
  SpecGroup,
  SpecNode,
  StyleMap,
  UiState,
  VizMode,
} from './types'

const DIR_CHIP = { width: 150, height: 36 }
const FILE_CHIP = { width: 190, height: 40 }

const GROUP_FILL = 'rgba(30,30,46,0.55)'
const TRANSPARENT = 'rgba(0,0,0,0)'

/** Mode params; captured into presets and editable via the ModePicker. */
export interface FsTreeParams {
  /** Draw the file-to-file import lines. */
  showImports: boolean
  /** Which way the tree grows (tic-0419): 'lr' left-to-right, 'tb' top-to-bottom. */
  orientation: Orientation
  /** Sibling wrapping (tic-3d87): 0/1 = single line, N >= 2 = pack children
   *  into N columns ('lr') or N rows ('tb'). */
  wrap: number
}

// -- select -------------------------------------------------------------------

const dirId = (path: string): string => `dir:${path}`

/** The collapsed-folder stub (tic-3430): a small '...' chip that a short elbow
 *  line joins to a collapsed non-empty folder's output side, so the folder does
 *  not read as empty.  Positioned manually in `layout` (it is not a tree node),
 *  and drawn faint so the '...' is the point, not a box. */
const STUB_SIZE: Size = { width: 26, height: 18 }

/** The spec node for a collapsed folder's stub, keyed off its dir chip id. */
function stubNode(dir: string): SpecNode {
  return {
    id: `${dir}:stub`,
    role: 'stub',
    label: '...',
    symbolId: null,
    expandable: false,
    children: [],
  }
}

/**
 * The directory the scene is scoped to (tic-e7d2): the `focusPath`'s FsDir
 * when set, else the workspace root.  When focused, that directory becomes
 * the laid-out tree root and everything outside it is absent -- scoping in
 * the select phase, so it flows through the VizMode interface with no
 * special-casing.  A focusPath that no longer exists (a `/out` refetch or a
 * filter change removed it) falls back to the whole graph rather than drawing
 * nothing.
 */
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
 * The smallest focus path that puts `target` in scope (tic-1d9a): for a
 * directory, the directory itself (it becomes the scoped root and its chip is
 * in the scene); for a file, its parent directory (the file is then a direct
 * child, guaranteed visible once the scope auto-expands).  The root (empty
 * string) for a top-level file.  Returns null when the target is not in the
 * tree at all -- excluded or filtered out -- in which case there is nothing to
 * travel to.  A goto handler that resolves nothing in the current scene can
 * use this to pop the focus out just far enough, then travel.
 */
export function minimalScopeForTarget(root: FsDir, target: string): string | null {
  if (target === '') return ''
  let dir = root
  const segments = target.split('/')
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const child = dir.children.find(
      (c): c is FsDir => c.type === 'dir' && c.name === segment,
    )
    if (child) {
      dir = child
      continue
    }
    // The final segment is a file (a non-final segment that is neither a dir
    // nor a file means the target does not exist in this tree).
    const file = dir.children.find((c) => c.type === 'file' && c.name === segment)
    if (file && i === segments.length - 1) return dir.path
    return null
  }
  return dir.path
}

/**
 * The `dir:<path>` expand ids whose folders hold only files (no
 * subdirectories): the only folders Collapse All folds up, so the tree keeps
 * its directory skeleton instead of collapsing to the root.  The root itself
 * is never a target -- folding it would hide the whole scene.
 */
export function fileOnlyDirIds(root: FsDir): ReadonlySet<string> {
  const ids = new Set<string>()
  const visit = (dir: FsDir): void => {
    if (
      dir.path !== '' &&
      dir.children.length > 0 &&
      dir.children.every((c) => c.type === 'file')
    ) {
      ids.add(dirId(dir.path))
    }
    for (const child of dir.children) {
      if (child.type === 'dir') visit(child)
    }
  }
  visit(root)
  return ids
}

/**
 * The goto index (tic-bee0): map every user-facing target -- a directory path
 * or a file path -- to the scene element that represents it, or its nearest
 * visible ancestor when the element itself is hidden (a directory closed on
 * the canvas, or a file inside one).  A directory's chip exists in the scene
 * once its ancestors are open; a file's chip exists once its parent chain is
 * open.  Targets the workspace excludes entirely are absent and resolve to
 * nothing, which is correct -- there is nothing to centre on.  `root` is the
 * scoped tree root (tic-e7d2), so a focused view resolves only what it shows.
 */
function buildGotoIndex(root: FsDir, expanded: Readonly<Record<string, boolean>>): Map<string, string> {
  const goto = new Map<string, string>()
  const dirOpen = (dir: FsDir): boolean => expanded[dirId(dir.path)] ?? true

  const visit = (dir: FsDir, inScene: boolean, nearest: string): void => {
    // `inScene` says whether this dir's own chip is in the scene (its
    // ancestors all open); `nearest` is the element id of the closest ancestor
    // chip that is.  The root is always in the scene; a child is when its
    // parent is in the scene and open.
    const dirElement = dirId(dir.path)
    goto.set(dir.path, inScene ? dirElement : nearest)
    // A child is in the scene iff this dir is in the scene and open.  The
    // closest in-scene element beneath us is this dir's own chip when the dir
    // is in the scene, else whatever the caller handed down.
    const childInScene = inScene && dirOpen(dir)
    const childNearest = inScene ? dirElement : nearest
    for (const child of dir.children) {
      if (child.type === 'dir') visit(child, childInScene, childNearest)
      // A file centres on its own chip when it is in the scene; a file inside
      // a closed-but-present dir centres on that dir's chip; a file under a
      // dir that is itself hidden falls back to the nearest ancestor chip.
      else goto.set(child.path, childInScene ? child.path : childNearest)
    }
  }
  visit(root, true, dirId(root.path))
  return goto
}

/** Symbol ids each file imports, so an expanded importer can anchor its
 *  import edges onto the matching rows instead of its chip. */
function importedSymbolsByFile(workspace: Workspace): Map<string, Set<string>> {
  const importedBy = new Map<string, Set<string>>()
  for (const edge of workspace.fileImports) {
    let set = importedBy.get(edge.source)
    if (!set) importedBy.set(edge.source, (set = new Set()))
    for (const symbolId of edge.symbolIds) set.add(symbolId)
  }
  return importedBy
}

function anchorId(
  path: string,
  symbolIds: readonly string[],
  expanded: Readonly<Record<string, boolean>>,
  importedBy: ReadonlyMap<string, Set<string>>,
): string {
  if (expanded[path] ?? false) {
    const imported = importedBy.get(path)
    if (imported) {
      for (const symbolId of symbolIds) {
        if (imported.has(symbolId)) return rowId(path, `imp:${symbolId}`)
      }
    }
  }
  return path
}

function select(data: Workspace, params: FsTreeParams, ui: UiState): SceneSpec {
  const expanded = ui.expanded
  const lod = ui.lod ?? 0
  const edges: SpecEdge[] = []
  const groups: SpecGroup[] = []
  const visibleFiles = new Set<string>()
  const importedBy = importedSymbolsByFile(data)

  const dirOpen = (dir: FsDir): boolean => expanded[dirId(dir.path)] ?? true
  // Extreme zoom-out: an expanded file collapses to its summary chip (name +
  // symbol count), which is all a few-pixel container could show anyway.
  const fileOpen = (file: FsFile): boolean =>
    lod < 3 && (expanded[file.path] ?? false)

  const visitFile = (file: FsFile): SpecNode => {
    visibleFiles.add(file.path)
    const symbols = data.index.byModule.get(file.module.id)?.length ?? 0
    const node: SpecNode = {
      id: file.path,
      role: 'file',
      label: file.name,
      sublabel: `${symbols} symbol${symbols === 1 ? '' : 's'}`,
      symbolId: null,
      expandable: true,
      // Cross-mode navigation (tic-e738): jump from a file on disk to its
      // import neighbourhood.  The target is a FILE PATH because that is the
      // import graph's focus vocabulary (tic-d7d7's Local View), not the
      // directory this mode's own focusTo speaks -- a mode declaring an
      // openIn speaks the destination's language, not its own.
      openIn: {
        modeId: IMPORT_GRAPH_MODE_ID,
        target: file.path,
        icon: 'local-view',
        label: `Local View of ${file.name} in the import graph`,
      },
      children: [],
    }
    if (fileOpen(file)) {
      node.children = fileRows(data, file).map((row) => ({
        id: row.id,
        role: row.kind === 'section' ? 'section' : 'row',
        label: row.label,
        symbolId: row.symbolId,
        expandable: false,
        children: [],
        data: row,
        // Import rows get a canvas goto button that flies the camera to the
        // file they import (tic-4d7c); rows without a target stay plain.
        gotoTo: row.gotoTo,
        // Function and method rows get the cross-mode 'trace call flow'
        // affordance (tic-d6af), declared once on the shared Row.  Absent on
        // every other kind; the canvas draws it generically.
        openIn: row.openIn,
      }))
    }
    return node
  }

  const visit = (node: FsNode): SpecNode => {
    if (node.type === 'file') return visitFile(node)
    const open = dirOpen(node)
    const children = open ? node.children.map(visit) : []
    // A collapsed folder that is not empty draws a short stub line with '...'
    // coming out of its output side (tic-3430), so it does not read as empty.
    // The stub is a child of the chip (so it rides along with it) but is not a
    // tree node -- `treeChildrenOf` filters dir/file, so it is excluded from
    // the tidy-tree layout and positioned manually in `layout`.
    const stub = !open && node.children.length > 0 ? stubNode(dirId(node.path)) : null
    const specChildren = stub ? [...children, stub] : children
    if (open && children.length > 0) {
      groups.push({
        id: `${dirId(node.path)}:group`,
        label: node.path === '' ? '/' : node.path,
        of: dirId(node.path),
      })
    }
    for (const child of children) {
      edges.push({
        id: `${dirId(node.path)}->${child.id}`,
        from: dirId(node.path),
        to: child.id,
        kind: 'nesting',
        route: 'elbow',
      })
    }
    if (stub) {
      edges.push({
        id: `${dirId(node.path)}->stub`,
        from: dirId(node.path),
        to: stub.id,
        kind: 'stub',
        route: 'elbow',
      })
    }
    return {
      id: dirId(node.path),
      role: 'dir',
      label: node.path === '' ? '/' : node.name,
      sublabel: `${node.fileCount} file${node.fileCount === 1 ? '' : 's'}`,
      symbolId: null,
      expandable: true,
      // The 'go into' affordance (tic-e7d2): a directory chip drills the
      // scene into this path, so the canvas needs no knowledge of the id
      // scheme -- the target rides on the element.
      focusTo: node.path,
      children: specChildren,
    }
  }

  const scope = scopeRoot(data, ui.focusPath ?? '')
  const root = visit(scope)

  // Import lines are visual noise once labels are gone (lod >= 2): hundreds
  // of hairlines between chips nobody can read.
  if (params.showImports && lod < 2) {
    for (const edge of data.fileImports) {
      if (!visibleFiles.has(edge.source) || !visibleFiles.has(edge.target)) continue
      edges.push({
        id: `imp:${edge.source}->${edge.target}`,
        from: anchorId(edge.source, edge.symbolIds, expanded, importedBy),
        to: anchorId(edge.target, edge.symbolIds, expanded, importedBy),
        kind: 'import',
        route: 'center',
        // Imports flow from importer to imported; the canvas marches ants on
        // highlighted directional edges to show which way the line points
        // (tic-2b2b).
        directional: true,
      })
    }
  }

  return { root, groups, edges, goto: buildGotoIndex(scope, expanded) }
}

// -- measure ------------------------------------------------------------------

const rowsOf = (node: SpecNode): Row[] => node.children.map((child) => child.data as Row)

function measure(spec: SceneSpec, _ui: UiState): SizeMap {
  const sizes = new Map<string, Size>()
  const visit = (node: SpecNode): void => {
    if (node.role === 'dir') {
      sizes.set(node.id, { ...DIR_CHIP })
    } else if (node.role === 'file') {
      if (node.children.length > 0) {
        const container = layoutContainer(rowsOf(node))
        sizes.set(node.id, { width: container.width, height: container.height })
      } else {
        sizes.set(node.id, { ...FILE_CHIP })
      }
    } else if (node.role === 'stub') {
      sizes.set(node.id, { ...STUB_SIZE })
    } else {
      // Rows are placed inside their container by `layout`, not by the tree.
      sizes.set(node.id, { width: 0, height: CONTAINER.row })
    }
    for (const child of node.children) visit(child)
  }
  visit(spec.root)
  return sizes
}

// -- layout -------------------------------------------------------------------

/** Only directories and files participate in the tidy tree; rows hang off
 *  their container's rect instead. */
const isTreeNode = (node: SpecNode): boolean => node.role === 'dir' || node.role === 'file'

const treeChildrenOf = (node: SpecNode): readonly SpecNode[] => node.children.filter(isTreeNode)

function layout(spec: SceneSpec, sizes: SizeMap, params: FsTreeParams): Positioned {
  const rects = layoutTree(spec.root, (node) => sizes.get(node.id) ?? { width: 0, height: 0 }, {
    childrenOf: treeChildrenOf,
    orientation: params.orientation,
    wrap: params.wrap,
  })

  // Rows inside their containers, offset from the container's world rect; a
  // collapsed folder's stub sits just to the right of its chip (tic-3430),
  // vertically centred, with a short elbow joining the two.
  const visit = (node: SpecNode): void => {
    const at = rects.get(node.id)
    if (node.role === 'file' && node.children.length > 0 && at) {
      for (const placed of layoutContainer(rowsOf(node)).rows) {
        rects.set(placed.row.id, {
          x: at.x + placed.x,
          y: at.y + placed.y,
          width: placed.width,
          height: placed.height,
        })
      }
    }
    if (node.role === 'dir' && at) {
      const stub = node.children.find((c) => c.role === 'stub')
      if (stub) {
        const size = sizes.get(stub.id)
        if (size) {
          // The stub hangs off the chip's output side, which flips with the
          // tree orientation (tic-0419): right of the chip in 'lr', below it
          // in 'tb'.
          rects.set(
            stub.id,
            params.orientation === 'tb'
              ? {
                  x: at.x + (at.width - size.width) / 2,
                  y: at.y + at.height + 6,
                  width: size.width,
                  height: size.height,
                }
              : {
                  x: at.x + at.width + 6,
                  y: at.y + (at.height - size.height) / 2,
                  width: size.width,
                  height: size.height,
                },
          )
        }
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(spec.root)

  // One translucent box behind each expanded directory's subtree; the ids
  // match the groups `select` emitted (`${dirId}:group`).
  for (const group of subtreeGroups(spec.root, rects, { childrenOf: treeChildrenOf })) {
    rects.set(group.id, group.rect)
  }

  const edgePoints = new Map<string, readonly number[]>()
  // The per-edge pipe override (wrapped lines' inter-column gap) rides along
  // so the canvas `reproject` (tic-1d7c) keeps it when a drag re-routes the
  // edge, instead of reverting to the midpoint pipe.
  const edgePipes = new Map<string, { dx: number } | { dy: number }>()

  // Nesting lines: directory chip -> each child, elbow-routed.  The connector
  // ids are `${parent}->${child}`, exactly the nesting edge ids from select.
  for (const edge of elbowConnectors(spec.root, rects, {
    childrenOf: treeChildrenOf,
    orientation: params.orientation,
  })) {
    edgePoints.set(edge.id, edge.points)
    if (edge.pipe) edgePipes.set(edge.id, edge.pipe)
  }

  // Stub lines (tic-3430): the stub is not a tree child, so elbowConnectors
  // never routes it -- route it here from the collapsed chip to its '...'.
  for (const edge of spec.edges) {
    if (edge.kind !== 'stub') continue
    const from = rects.get(edge.from)
    const to = rects.get(edge.to)
    if (!from || !to) continue
    edgePoints.set(edge.id, elbow(from, to, params.orientation))
  }

  // Import lines: centre of the anchor element on each side -- the file chip
  // while collapsed, the contributing import row once expanded.
  for (const edge of spec.edges) {
    if (edge.kind !== 'import') continue
    const from = rects.get(edge.from)
    const to = rects.get(edge.to)
    if (!from || !to) continue
    const points: number[] = [
      from.x + from.width / 2,
      from.y + from.height / 2,
      to.x + to.width / 2,
      to.y + to.height / 2,
    ]
    edgePoints.set(edge.id, points)
  }

  return { rects, edgePoints, edgePipes, orientation: params.orientation }
}

// -- style --------------------------------------------------------------------

function style(spec: SceneSpec, _params: FsTreeParams): StyleMap {
  const nodes = new Map<string, NodeStyle>()
  const visit = (node: SpecNode): void => {
    if (node.role === 'dir') {
      nodes.set(node.id, { fill: THEME.surface, stroke: THEME.line, accent: THEME.dir })
    } else if (node.role === 'file') {
      // An expanded container is draggable as a unit: reproject (tic-2697)
      // carries its rows, the group box and its edges along with it.
      nodes.set(
        node.id,
        node.children.length > 0
          ? { fill: THEME.surface2, stroke: THEME.line, accent: KIND_COLOR.module }
          : { fill: THEME.surface, stroke: THEME.line, accent: KIND_COLOR.module },
      )
    } else if (node.role === 'section') {
      nodes.set(node.id, { fill: TRANSPARENT, stroke: TRANSPARENT, draggable: false })
    } else if (node.role === 'stub') {
      // The '...' reads as an extension of the collapsed folder (tic-3430):
      // borderless and pinned, so it never drags as its own object.
      nodes.set(node.id, { fill: TRANSPARENT, stroke: TRANSPARENT, draggable: false })
    } else {
      const row = node.data as Row
      // External imports read as muted against the resolved rows: a grey
      // border and accent bar instead of a kind colour, since they link to
      // nothing (tic-314c).
      nodes.set(
        node.id,
        row.external
          ? { fill: THEME.surface2, stroke: THEME.textFaint, accent: THEME.textFaint, draggable: false }
          : {
              fill: THEME.surface2,
              stroke: THEME.line,
              // Sections are handled by their role above, so the kind is a symbol.
              accent: KIND_COLOR[row.kind as SymbolKind],
              draggable: false,
            },
      )
    }
    for (const child of node.children) visit(child)
  }
  visit(spec.root)

  const groups = new Map<string, GroupStyle>()
  for (const group of spec.groups) {
    groups.set(group.id, { fill: GROUP_FILL, stroke: THEME.line })
  }

  const edges = new Map<string, EdgeStyle>()
  for (const edge of spec.edges) {
    edges.set(
      edge.id,
      edge.kind === 'import'
        ? { stroke: THEME.edge, strokeWidth: 1, opacity: 0.45 }
        : edge.kind === 'stub'
          ? { stroke: THEME.textFaint, strokeWidth: 1, opacity: 0.6 }
          : { stroke: THEME.edge, strokeWidth: 1, opacity: 0.6 },
    )
  }

  return { nodes, groups, edges }
}

// -- the mode -----------------------------------------------------------------

/**
 * The registered fs-tree mode.  Everything the app can do with it goes
 * through this object; the scope and Collapse-All helpers above are exported
 * only for the app's goto/HUD wiring and the mode's own tests.
 */
export const fsTreeMode: VizMode<FsTreeParams> = {
  id: FS_TREE_MODE_ID,
  label: 'Files & symbols',
  defaultParams: { showImports: true, orientation: 'lr', wrap: 0 },
  paramToggles: [{ key: 'showImports', label: 'Import lines' }],
  paramOptions: [
    {
      key: 'orientation',
      label: 'Tree direction',
      options: [
        { value: 'lr', label: 'Horizontal →' },
        { value: 'tb', label: 'Vertical ↓' },
      ],
    },
  ],
  paramNumbers: [
    {
      key: 'wrap',
      label: 'Sibling wrap',
      min: 0,
      max: 8,
      step: 1,
    },
  ],
  select,
  measure,
  layout,
  style,
}
