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
 * is written into the returned `rects` map.  Import lines anchor to the file
 * while it is collapsed and to the specific contributing sub-item once it is
 * expanded, with no re-architecture.
 *
 * Everything here is a pure function of (workspace, expanded); React and
 * Konva stay outside.
 */
import type { FsDir, FsFile, FsNode, Workspace } from '../data/derive'
import type { GraphNode, SymbolKind } from '../data/types'
import type { Scene, SceneEdge, SceneGroup, SceneNode } from '../canvas/scene'
import { KIND_COLOR, THEME } from '../canvas/theme'
import {
  elbowConnectors,
  layoutTree,
  subtreeGroups,
  type Rect,
  type Size,
} from '../layout/tidyTree'

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

// -- rows ---------------------------------------------------------------------

interface Row {
  /** Unique element id; also the key into the layout's `rects` map. */
  id: string
  /** The symbol this row represents, or null for a section header. */
  symbolId: string | null
  label: string
  kind: SymbolKind | 'section'
  indent: boolean
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

function memberRow(path: string, node: GraphNode, indent: boolean): Row {
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
  if (imports.length > 0) {
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

// -- layout tree --------------------------------------------------------------

interface Item {
  id: string
  children?: Item[]
  type: 'dir' | 'file'
  dir?: FsDir
  file?: FsFile
  size: Size
  /** Present only on an expanded file. */
  container?: ContainerLayout
}

const dirId = (path: string): string => `dir:${path}`

function buildTree(workspace: Workspace, expanded: Readonly<Record<string, boolean>>): Item {
  const dirOpen = (dir: FsDir): boolean => expanded[dirId(dir.path)] ?? true
  const fileOpen = (file: FsFile): boolean => expanded[file.path] ?? false

  const visitFile = (file: FsFile): Item => {
    if (!fileOpen(file)) return { id: file.path, type: 'file', file, size: { ...FILE_CHIP } }
    const container = layoutContainer(fileRows(workspace, file))
    return {
      id: file.path,
      type: 'file',
      file,
      size: { width: container.width, height: container.height },
      container,
    }
  }

  const visit = (node: FsNode): Item =>
    node.type === 'dir'
      ? {
          id: dirId(node.path),
          type: 'dir',
          dir: node,
          size: { ...DIR_CHIP },
          children: dirOpen(node) ? node.children.map(visit) : undefined,
        }
      : visitFile(node)

  return visit(workspace.tree)
}

// -- scene assembly -----------------------------------------------------------

export interface FsTreeLayout {
  scene: Scene
  /**
   * World rect of every element the mode emitted: directory chips, file
   * chips and containers, and -- when a file is expanded -- every row inside
   * it.  The next phase's import/call lines anchor through this map.
   */
  rects: ReadonlyMap<string, Rect>
  /** Row id -> the symbol id the row represents (rows only). */
  symbolOfRow: ReadonlyMap<string, string>
  /** Ids whose activation toggles expand/collapse: directories and files. */
  expandable: ReadonlySet<string>
}

export function fsTreeScene(
  workspace: Workspace,
  expanded: Readonly<Record<string, boolean>> = {},
): FsTreeLayout {
  const tree = buildTree(workspace, expanded)
  const rects = layoutTree(tree, (item) => item.size)

  const nodes: SceneNode[] = []
  const files = new Map<string, Item>()
  const symbolOfRow = new Map<string, string>()
  const expandable = new Set<string>()

  const visit = (item: Item): void => {
    const at = rects.get(item.id)!
    expandable.add(item.id)

    if (item.type === 'dir' && item.dir) {
      nodes.push({
        ...at,
        id: item.id,
        label: item.dir.path === '' ? '/' : item.dir.name,
        sublabel: `${item.dir.fileCount} file${item.dir.fileCount === 1 ? '' : 's'}`,
        fill: THEME.surface,
        stroke: THEME.line,
        accent: THEME.dir,
      })
    } else if (item.file) {
      files.set(item.file.path, item)
      if (item.container) {
        const symbols = workspace.index.byModule.get(item.file.module.id)?.length ?? 0
        nodes.push({
          ...at,
          id: item.id,
          label: item.file.name,
          sublabel: `${symbols} symbol${symbols === 1 ? '' : 's'}`,
          fill: THEME.surface2,
          stroke: THEME.line,
          accent: KIND_COLOR.module,
          // An expanded container drags its rows nowhere; collapse first.
          draggable: false,
        })
        for (const placed of item.container.rows) {
          const rect: Rect = {
            x: at.x + placed.x,
            y: at.y + placed.y,
            width: placed.width,
            height: placed.height,
          }
          rects.set(placed.row.id, rect)
          if (placed.row.symbolId !== null) symbolOfRow.set(placed.row.id, placed.row.symbolId)
          nodes.push(
            placed.row.kind === 'section'
              ? {
                  ...rect,
                  id: placed.row.id,
                  label: placed.row.label.toUpperCase(),
                  fill: TRANSPARENT,
                  stroke: TRANSPARENT,
                  draggable: false,
                }
              : {
                  ...rect,
                  id: placed.row.id,
                  label: placed.row.label,
                  fill: THEME.surface2,
                  stroke: THEME.line,
                  accent: KIND_COLOR[placed.row.kind],
                  draggable: false,
                },
          )
        }
      } else if (item.file) {
        const symbols = workspace.index.byModule.get(item.file.module.id)?.length ?? 0
        nodes.push({
          ...at,
          id: item.id,
          label: item.file.name,
          sublabel: `${symbols} symbol${symbols === 1 ? '' : 's'}`,
          fill: THEME.surface,
          stroke: THEME.line,
          accent: KIND_COLOR.module,
        })
      }
    }
    for (const child of item.children ?? []) visit(child)
  }
  visit(tree)

  // One translucent box behind each expanded directory's subtree.
  const groups: SceneGroup[] = subtreeGroups(tree, rects).map((group) => {
    const path = group.id.slice('dir:'.length, -':group'.length)
    return {
      id: group.id,
      ...group.rect,
      label: path === '' ? '/' : path,
      fill: GROUP_FILL,
      stroke: THEME.line,
    }
  })

  // Nesting lines: directory chip -> each child, elbow-routed.
  const edges: SceneEdge[] = elbowConnectors(tree, rects, { orientation: 'lr' }).map((edge) => ({
    id: edge.id,
    points: edge.points,
    stroke: THEME.edge,
    strokeWidth: 1,
    opacity: 0.6,
  }))

  // Import lines: file -> file while collapsed, row -> row once the
  // contributing sub-items are visible.
  const anchor = (path: string, symbolIds: readonly string[]): Rect | null => {
    const item = files.get(path)
    if (!item) return null
    if (item.container) {
      for (const symbolId of symbolIds) {
        const row = rects.get(rowId(path, `imp:${symbolId}`))
        if (row) return row
      }
    }
    return rects.get(item.id) ?? null
  }
  for (const edge of workspace.fileImports) {
    const from = anchor(edge.source, edge.symbolIds)
    const to = anchor(edge.target, edge.symbolIds)
    if (!from || !to) continue
    edges.push({
      id: `imp:${edge.source}->${edge.target}`,
      points: [
        from.x + from.width / 2,
        from.y + from.height / 2,
        to.x + to.width / 2,
        to.y + to.height / 2,
      ],
      stroke: THEME.edge,
      strokeWidth: 1,
      opacity: 0.45,
    })
  }

  return { scene: { groups, edges, nodes }, rects, symbolOfRow, expandable }
}

