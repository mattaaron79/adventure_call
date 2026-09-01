/**
 * The expanded-file container: what a file's detail rows are, and how they
 * stack inside a box.
 *
 * This vocabulary grew inside the fs-tree mode (tic-1faf), which was the only
 * thing that expanded a file into header + sections (Imports, Classes with
 * their methods and attributes nested, Functions, Variables).  The
 * import-graph mode wants the identical treatment for its nodes (tic-ea9d),
 * and a mode importing another mode is the wrong seam -- the registry
 * (./registry) is the only sanctioned way modes meet.  So it was lifted here
 * (tic-0680): a mode-agnostic module both modes may depend on, with no
 * dependency of its own on either.
 *
 * The row design is what makes it worth sharing.  Every row is an
 * individually hit-testable element carrying its own symbol id, and its rect
 * lands in the positioned output, so import lines can anchor to the specific
 * contributing sub-item once a file is expanded rather than to the file as a
 * whole.  {@link layoutContainer} owns the geometry -- both the `measure`
 * phase (which needs the container's intrinsic size) and the `layout` phase
 * (which needs each row's offset) call it, so the two can never disagree
 * about where a row sits.
 *
 * Everything here is a pure function of its arguments; React and Konva stay
 * outside.
 */
import type { FsFile, Workspace } from '../data/derive'
import type { SymbolKind } from '../data/types'

/** Container geometry, in world units. Shared by `measure` and `layout`. */
export const CONTAINER = {
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
export const CHAR_W = 6.4

// -- rows ---------------------------------------------------------------------

export interface Row {
  /** Unique element id; also the key into the layout's rect map. */
  id: string
  /** The symbol this row represents, or null for a section header. */
  symbolId: string | null
  label: string
  kind: SymbolKind | 'section'
  indent: boolean
  /** A muted, linkless treatment, e.g. an external import (tic-314c). */
  external?: boolean
  /**
   * A camera-goto target for the row (tic-4d7c): import rows carry the path
   * of the file they import, so the canvas can draw a goto button that flies
   * the camera there.  Absent on rows with no resolvable target -- members of
   * the same file, external imports (tic-314c).
   */
  gotoTo?: string
}

export const rowId = (path: string, suffix: string): string => `row:${path}:${suffix}`

export function sectionRow(path: string, title: string): Row {
  return {
    id: rowId(path, `section:${title}`),
    symbolId: null,
    label: title,
    kind: 'section',
    indent: false,
  }
}

export function memberRow(path: string, node: { id: string; kind: SymbolKind; name: string; signature: string }, indent: boolean): Row {
  return {
    id: rowId(path, node.id),
    symbolId: node.id,
    label: node.signature !== '' ? node.signature : node.name,
    kind: node.kind,
    indent,
  }
}

/** Which optional sections {@link fileRows} emits. */
export interface FileRowsOptions {
  /**
   * Emit an "Imported By" section listing the files that import this one
   * (tic-0680).  Off by default: the fs-tree has always shown outgoing
   * imports only, and turning this on for it would change a mode nobody
   * asked to change.  The import-graph mode expanding a node is the caller
   * that wants it.
   */
  importedBy?: boolean
}

/**
 * The rows of an expanded file, in display order: Imported By (only when
 * asked for), then Imports, then Classes with their methods and attributes
 * nested, then Functions, then Variables.  Empty sections are omitted.
 *
 * Imported By deliberately sits ABOVE Imports: a reader looking at a file
 * asks "who depends on this?" before "what does this need?", and the
 * incoming list is the shorter, more surprising one of the two.
 */
export function fileRows(
  workspace: Workspace,
  file: FsFile,
  options: FileRowsOptions = {},
): Row[] {
  const rows: Row[] = []
  const index = workspace.index

  if (options.importedBy) {
    // One row per importing FILE, not per symbol: the forward Imports
    // section names symbols because that is what an import statement binds,
    // but "imported by" is a statement about files -- the same importer
    // pulling three symbols is one relationship, not three.  So `symbolId`
    // is null (the row names a file) and `gotoTo` is the importer's path,
    // which is all the canvas needs to render its goto button generically.
    const importers = workspace.fileImporters.get(file.path) ?? []
    if (importers.length > 0) {
      rows.push(sectionRow(file.path, 'Imported By'))
      for (const edge of importers) {
        const module = index.moduleByFile.get(edge.source)
        rows.push({
          id: rowId(file.path, `impby:${edge.source}`),
          symbolId: null,
          // Shaped like the Imports rows (`name · module`) so the two
          // sections read as siblings; the raw path is the fallback for an
          // importer whose module node is somehow not in this index.
          label: module ? `${module.name} · ${module.id}` : edge.source,
          kind: 'module',
          indent: false,
          gotoTo: edge.source,
        })
      }
    }
  }

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
          // The row can fly the camera to the file that owns the import
          // (tic-4d7c); the target is a file path the goto index resolves.
          gotoTo: edge.target,
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
