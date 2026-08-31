/**
 * Mode 1: the filesystem as a tiered spatial graph.
 *
 * Directories and files come from the derived fs tree (tic-3399) and are
 * placed by the tidy-tree engine (tic-cdeb): tiers advance rightward, a
 * directory's subtree hangs off its chip, and a translucent group box backs
 * each expanded directory.  A collapsed file is a chip; an expanded file is a
 * container laid out as header + sections (Imports, Classes with their
 * methods and attributes nested, Functions, Variables).
 *
 * Forward compatibility is the point of the row design: every row is an
 * individually hit-testable element carrying its own symbol id, and its rect
 * lands in the positioned output.  Import lines anchor to the file while it
 * is collapsed and to the specific contributing sub-item once it is expanded,
 * with no re-architecture.
 *
 * Since tic-83ec this mode is a `VizMode`: the four phases -- select, measure,
 * layout, style -- are pure functions, and the app renders it only through
 * `renderMode`.  Everything here is a pure function of its arguments; React
 * and Konva stay outside.
 */
import type { FsDir, FsFile, FsNode, Workspace } from '../data/derive'
import type { SymbolKind } from '../data/types'
import { KIND_COLOR, THEME } from '../canvas/theme'
import { elbowConnectors, layoutTree, subtreeGroups, type Size } from '../layout/tidyTree'
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
const CONTAINER = {
  pad: 12,
  header: 36,
  row: 24,
  rowGap: 2,
  sectionGap: 10,
  indent: 14,
  minW: 300,
  maxW: 560,
}
/** Rough world-space width of one character at the row font size. */
const CHAR_W = 6.4

const GROUP_FILL = 'rgba(30,30,46,0.55)'
const TRANSPARENT = 'rgba(0,0,0,0)'

/** Mode params; captured into presets and editable via the ModePicker. */
export interface FsTreeParams {
  /** Draw the file-to-file import lines. */
  showImports: boolean
}

// -- rows ---------------------------------------------------------------------

interface Row {
  /** Unique element id; also the key into the layout's rect map. */
  id: string
  /** The symbol this row represents, or null for a section header. */
  symbolId: string | null
  label: string
  kind: SymbolKind | 'section'
  indent: boolean
  /** A muted, linkless treatment, e.g. an external import (tic-314c). */
  external?: boolean
}

const rowId = (path: string, suffix: string): string => `row:${path}:${suffix}`

function sectionRow(path: string, title: string): Row {
  return {
    id: rowId(path, `section:${title}`),
    symbolId: null,
    label: title,
    kind: 'section',
    indent: false,
  }
}

function memberRow(path: string, node: { id: string; kind: SymbolKind; name: string; signature: string }, indent: boolean): Row {
  return {
    id: rowId(path, node.id),
    symbolId: node.id,
    label: node.signature !== '' ? node.signature : node.name,
    kind: node.kind,
    indent,
  }
}

/**
 * The rows of an expanded file, in display order: Imports, then Classes with
 * their methods and attributes nested, then Functions, then Variables.
 * Empty sections are omitted.
 */
export function fileRows(workspace: Workspace, file: FsFile): Row[] {
  const rows: Row[] = []
  const index = workspace.index

  const imports = workspace.fileImports.filter((edge) => edge.source === file.path)
  // External imports (tic-314c) only exist once the registry has been fetched;
  // they share the Imports section but render muted and link to nothing.
  const external = workspace.externalImports.filter((imp) => imp.source === file.path)
  if (imports.length > 0 || external.length > 0) {
    rows.push(sectionRow(file.path, 'Imports'))
    for (const edge of imports) {
      for (const symbolId of edge.symbolIds) {
        const target = index.byId.get(symbolId)
        rows.push({
          id: rowId(file.path, `imp:${symbolId}`),
          symbolId,
          label: target ? `${target.name} · ${target.module}` : symbolId,
          kind: target?.kind ?? 'variable',
          indent: false,
        })
      }
    }
    for (const imp of external) {
      rows.push({
        id: rowId(file.path, `ext:${imp.target}`),
        symbolId: null,
        label: imp.count > 1 ? `${imp.target} ×${imp.count}` : imp.target,
        kind: 'module',
        indent: false,
        external: true,
      })
    }
  }

  const roots = index.rootsByModule.get(file.module.id) ?? []
  const classes = roots.filter((n) => n.kind === 'class')
  const functions = roots.filter((n) => n.kind === 'function')
  const variables = roots.filter((n) => n.kind === 'variable')

  if (classes.length > 0) {
    rows.push(sectionRow(file.path, 'Classes'))
    for (const cls of classes) {
      rows.push(memberRow(file.path, cls, false))
      for (const child of index.byParent.get(cls.id) ?? []) {
        rows.push(memberRow(file.path, child, true))
      }
    }
  }
  if (functions.length > 0) {
    rows.push(sectionRow(file.path, 'Functions'))
    for (const fn of functions) rows.push(memberRow(file.path, fn, false))
  }
  if (variables.length > 0) {
    rows.push(sectionRow(file.path, 'Variables'))
    for (const v of variables) rows.push(memberRow(file.path, v, false))
  }

  return rows
}

// -- expanded-file container --------------------------------------------------

export interface PlacedRow {
  row: Row
  /** Offset of the row inside the container, world units. */
  x: number
  y: number
  width: number
  height: number
}

export interface ContainerLayout {
  width: number
  height: number
  rows: PlacedRow[]
}

/** Lay the rows out inside a container: header, then stacked sections. */
export function layoutContainer(rows: Row[]): ContainerLayout {
  const longest = rows.reduce(
    (max, row) => Math.max(max, row.label.length + (row.indent ? 2 : 0)),
    0,
  )
  const width = Math.min(CONTAINER.maxW, Math.max(CONTAINER.minW, Math.ceil(28 + longest * CHAR_W)))

  let y = CONTAINER.header + CONTAINER.pad
  const placed: PlacedRow[] = []
  for (const row of rows) {
    const indent = row.indent ? CONTAINER.indent : 0
    placed.push({
      row,
      x: CONTAINER.pad + indent,
      y,
      width: width - CONTAINER.pad * 2 - indent,
      height: CONTAINER.row,
    })
    y += CONTAINER.row + (row.kind === 'section' ? CONTAINER.sectionGap : CONTAINER.rowGap)
  }
  return { width, height: y - CONTAINER.rowGap + CONTAINER.pad, rows: placed }
}

// -- select -------------------------------------------------------------------

const dirId = (path: string): string => `dir:${path}`

/**
 * The goto index (tic-bee0): map every user-facing target -- a directory path
 * or a file path -- to the scene element that represents it, or its nearest
 * visible ancestor when the element itself is hidden (a directory closed on
 * the canvas, or a file inside one).  A directory's chip exists in the scene
 * once its ancestors are open; a file's chip exists once its parent chain is
 * open.  Targets the workspace excludes entirely are absent and resolve to
 * nothing, which is correct -- there is nothing to centre on.
 */
function buildGotoIndex(data: Workspace, expanded: Readonly<Record<string, boolean>>): Map<string, string> {
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
  visit(data.tree, true, dirId(''))
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
      }))
    }
    return node
  }

  const visit = (node: FsNode): SpecNode => {
    if (node.type === 'file') return visitFile(node)
    const open = dirOpen(node)
    const children = open ? node.children.map(visit) : []
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
    return {
      id: dirId(node.path),
      role: 'dir',
      label: node.path === '' ? '/' : node.name,
      sublabel: `${node.fileCount} file${node.fileCount === 1 ? '' : 's'}`,
      symbolId: null,
      expandable: true,
      children,
    }
  }

  const root = visit(data.tree)

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
      })
    }
  }

  return { root, groups, edges, goto: buildGotoIndex(data, expanded) }
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

function layout(spec: SceneSpec, sizes: SizeMap, _params: FsTreeParams): Positioned {
  const rects = layoutTree(spec.root, (node) => sizes.get(node.id) ?? { width: 0, height: 0 }, {
    childrenOf: treeChildrenOf,
  })

  // Rows inside their containers, offset from the container's world rect.
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
    for (const child of node.children) visit(child)
  }
  visit(spec.root)

  // One translucent box behind each expanded directory's subtree; the ids
  // match the groups `select` emitted (`${dirId}:group`).
  for (const group of subtreeGroups(spec.root, rects, { childrenOf: treeChildrenOf })) {
    rects.set(group.id, group.rect)
  }

  const edgePoints = new Map<string, readonly number[]>()

  // Nesting lines: directory chip -> each child, elbow-routed.  The connector
  // ids are `${parent}->${child}`, exactly the nesting edge ids from select.
  for (const edge of elbowConnectors(spec.root, rects, { childrenOf: treeChildrenOf })) {
    edgePoints.set(edge.id, edge.points)
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

  return { rects, edgePoints }
}

// -- style --------------------------------------------------------------------

function style(spec: SceneSpec, _params: FsTreeParams): StyleMap {
  const nodes = new Map<string, NodeStyle>()
  const visit = (node: SpecNode): void => {
    if (node.role === 'dir') {
      nodes.set(node.id, { fill: THEME.surface, stroke: THEME.line, accent: THEME.dir })
    } else if (node.role === 'file') {
      // An expanded container drags its rows nowhere; collapse first.
      nodes.set(
        node.id,
        node.children.length > 0
          ? { fill: THEME.surface2, stroke: THEME.line, accent: KIND_COLOR.module, draggable: false }
          : { fill: THEME.surface, stroke: THEME.line, accent: KIND_COLOR.module },
      )
    } else if (node.role === 'section') {
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
        : { stroke: THEME.edge, strokeWidth: 1, opacity: 0.6 },
    )
  }

  return { nodes, groups, edges }
}

// -- the mode -----------------------------------------------------------------

/**
 * The registered fs-tree mode.  Everything the app can do with it goes
 * through this object; the row and container helpers above are exported only
 * for the mode's own tests.
 */
export const fsTreeMode: VizMode<FsTreeParams> = {
  id: 'fs-tree',
  label: 'Files & symbols',
  defaultParams: { showImports: true },
  paramToggles: [{ key: 'showImports', label: 'Import lines' }],
  select,
  measure,
  layout,
  style,
}
