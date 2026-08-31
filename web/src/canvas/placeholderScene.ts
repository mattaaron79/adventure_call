/**
 * A stand-in scene, so the canvas primitives have something real to move.
 *
 * Deliberately dumb: files are chips packed into a box per directory, boxes
 * are shelf-packed left to right.  The tidy-tree engine (tic-cdeb) and the
 * fs-tree mode (tic-1faf) replace this wholesale -- what has to survive is the
 * shape of the output, not the arithmetic that produces it.  It uses the real
 * export rather than lorem boxes so the exercise is honest about scale:
 * every file and every file-to-file import edge is emitted.
 */
import type { Workspace } from '../data/derive'
import type { FsDir, FsFile } from '../data/derive'
import type { Scene, SceneEdge, SceneGroup, SceneNode } from './scene'
import { KIND_COLOR, THEME } from './theme'
import type { Rect } from './viewport'

const CHIP = { width: 190, height: 40 }
const GAP = { x: 14, y: 10 }
const BOX = { pad: 16, header: 28, gap: 44 }
const MAX_COLS = 3
const SHELF_WIDTH = 2600

interface Bucket {
  path: string
  label: string
  files: { id: string; name: string; symbols: number }[]
}

/** Every directory that directly holds files, in tree order. */
function bucketize(root: FsDir, symbolsOf: (moduleId: string) => number): Bucket[] {
  const buckets: Bucket[] = []

  const visit = (dir: FsDir) => {
    const files = dir.children.filter((child): child is FsFile => child.type === 'file')
    if (files.length > 0) {
      buckets.push({
        path: dir.path,
        label: dir.path === '' ? '/' : dir.path,
        files: files.map((file) => ({
          id: file.path,
          name: file.name,
          symbols: symbolsOf(file.module.id),
        })),
      })
    }
    for (const child of dir.children) if (child.type === 'dir') visit(child)
  }

  visit(root)
  return buckets
}

export function placeholderScene(workspace: Workspace | null): Scene {
  if (!workspace) return { groups: [], edges: [], nodes: [] }

  const symbolsOf = (moduleId: string) => workspace.index.byModule.get(moduleId)?.length ?? 0
  const groups: SceneGroup[] = []
  const nodes: SceneNode[] = []
  const rects = new Map<string, Rect>()

  let shelfX = 0
  let shelfY = 0
  let shelfHeight = 0

  for (const bucket of bucketize(workspace.tree, symbolsOf)) {
    const cols = Math.min(MAX_COLS, bucket.files.length)
    const rows = Math.ceil(bucket.files.length / cols)
    const width = BOX.pad * 2 + cols * CHIP.width + (cols - 1) * GAP.x
    const height = BOX.pad * 2 + BOX.header + rows * CHIP.height + (rows - 1) * GAP.y

    if (shelfX > 0 && shelfX + width > SHELF_WIDTH) {
      shelfX = 0
      shelfY += shelfHeight + BOX.gap
      shelfHeight = 0
    }

    groups.push({
      id: `dir:${bucket.path}`,
      x: shelfX,
      y: shelfY,
      width,
      height,
      label: bucket.label,
      fill: 'rgba(30,30,46,0.55)',
      stroke: THEME.line,
    })

    bucket.files.forEach((file, i) => {
      const rect = {
        x: shelfX + BOX.pad + (i % cols) * (CHIP.width + GAP.x),
        y: shelfY + BOX.pad + BOX.header + Math.floor(i / cols) * (CHIP.height + GAP.y),
        width: CHIP.width,
        height: CHIP.height,
      }
      rects.set(file.id, rect)
      nodes.push({
        ...rect,
        id: file.id,
        label: file.name,
        sublabel: `${file.symbols} symbol${file.symbols === 1 ? '' : 's'}`,
        fill: THEME.surface,
        stroke: THEME.line,
        accent: KIND_COLOR.module,
      })
    })

    shelfX += width + BOX.gap
    shelfHeight = Math.max(shelfHeight, height)
  }

  const edges: SceneEdge[] = []
  for (const imported of workspace.fileImports) {
    const from = rects.get(imported.source)
    const to = rects.get(imported.target)
    if (!from || !to) continue
    edges.push({
      id: `${imported.source}->${imported.target}`,
      points: [
        from.x + from.width / 2,
        from.y + from.height / 2,
        to.x + to.width / 2,
        to.y + to.height / 2,
      ],
      stroke: THEME.edge,
      strokeWidth: 1,
      opacity: 0.5,
      kind: 'import',
      // Imports flow importer -> imported; the canvas animates highlighted
      // directional edges (tic-2b2b).
      directional: true,
    })
  }

  return { groups, edges, nodes }
}
