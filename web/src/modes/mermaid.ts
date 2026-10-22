/**
 * Mermaid export (tic-ca91): any mode's view as a flowchart.
 *
 * Works on the select phase's {@link SceneSpec}, so it carries what the view
 * shows -- elements, containment, connections -- and none of the geometry.
 * A child joined to its parent by an edge (the fs-tree's nesting lines) is
 * drawn as a node of its own; any other child (a file's rows, a sunburst
 * slice's contents) is drawn inside its parent, which becomes a subgraph.
 *
 * Strokes come from the mode's style phase; fills are left to the Mermaid
 * theme, because the canvas palette is dark-only and its fills would bury the
 * theme's text.  Groups (the fs-tree's backing boxes) are not drawn: the
 * nesting edges already say the same thing.
 */
import type { AnyMode } from './registry'
import type { Derived, SceneSpec, SpecNode, StyleMap, UiState } from './types'

export type MermaidDirection = 'LR' | 'TB'

export interface MermaidOptions {
  direction?: MermaidDirection
  /** The mode's style output; omitted, the diagram is unstyled. */
  styles?: StyleMap
  /** A leading comment naming the view. */
  title?: string
}

export interface MermaidExport {
  text: string
  nodes: number
  edges: number
}

/** Mermaid's default limits; most renderers refuse a diagram beyond them. */
export const MERMAID_MAX_TEXT = 50_000
export const MERMAID_MAX_EDGES = 500

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Label text with Mermaid's syntax characters as entity codes. */
export function escapeLabel(text: string): string {
  return text
    .replace(/#/g, '#35;')
    .replace(/"/g, '#34;')
    .replace(/</g, '#60;')
    .replace(/>/g, '#62;')
}

function shape(node: SpecNode, id: string, label: string): string {
  switch (node.role) {
    case 'dir':
      return `${id}("${label}")`
    case 'stub':
      return `${id}(("${label}"))`
    case 'external':
      return `${id}[["${label}"]]`
    default:
      return `${id}["${label}"]`
  }
}

export function sceneToMermaid(spec: SceneSpec, options: MermaidOptions = {}): MermaidExport {
  const ids = new Map<string, string>()
  const linked = new Set<string>()
  for (const edge of spec.edges) {
    linked.add(`${edge.from}\0${edge.to}`)
    linked.add(`${edge.to}\0${edge.from}`)
  }
  const nodeLines: string[] = []
  const strokeOf = new Map<string, string>()

  const emit = (node: SpecNode, indent: string): void => {
    const id = `n${ids.size}`
    ids.set(node.id, id)
    const stroke = options.styles?.nodes.get(node.id)
    const colour = stroke?.accent ?? stroke?.stroke
    if (colour && HEX.test(colour)) strokeOf.set(id, colour)

    // Mermaid rejects an empty label; the unnamed one is the root directory.
    const name = node.label || (node.role === 'dir' ? '/' : node.id)
    const label = escapeLabel(name) + (node.sublabel ? `<br/>${escapeLabel(node.sublabel)}` : '')
    const contained = node.children.filter((child) => !linked.has(`${node.id}\0${child.id}`))
    const detached = node.children.filter((child) => linked.has(`${node.id}\0${child.id}`))
    if (contained.length > 0) {
      nodeLines.push(`${indent}subgraph ${id}["${label}"]`)
      for (const child of contained) emit(child, `${indent}  `)
      nodeLines.push(`${indent}end`)
    } else {
      nodeLines.push(`${indent}${shape(node, id, label)}`)
    }
    for (const child of detached) emit(child, indent)
  }

  // A bare 'root' is a canvas container, not an element of the picture.
  if (spec.root.role === 'root') for (const child of spec.root.children) emit(child, '  ')
  else emit(spec.root, '  ')

  const edgeLines: string[] = []
  const linkStyles = new Map<string, number[]>()
  for (const edge of spec.edges) {
    const from = ids.get(edge.from)
    const to = ids.get(edge.to)
    if (from === undefined || to === undefined) continue
    const arrow = edge.directional ? '-->' : '---'
    const detail = edge.detail ? `|"${escapeLabel(edge.detail)}"|` : ''
    const index = edgeLines.length
    edgeLines.push(`  ${from} ${arrow}${detail} ${to}`)

    const style = options.styles?.edges.get(edge.id)
    const parts: string[] = []
    if (style && HEX.test(style.stroke)) parts.push(`stroke:${style.stroke}`)
    if (style?.dash?.length) parts.push(`stroke-dasharray:${style.dash.join(' ')}`)
    if (parts.length > 0) {
      const key = parts.join(',')
      linkStyles.set(key, [...(linkStyles.get(key) ?? []), index])
    }
  }

  const classLines: string[] = []
  const byColour = new Map<string, string[]>()
  for (const [id, colour] of strokeOf) byColour.set(colour, [...(byColour.get(colour) ?? []), id])
  ;[...byColour].forEach(([colour, members], i) => {
    classLines.push(`  classDef s${i} stroke:${colour},stroke-width:2px`)
    classLines.push(`  class ${members.join(',')} s${i}`)
  })
  for (const [style, indices] of linkStyles) classLines.push(`  linkStyle ${indices.join(',')} ${style}`)

  const header = options.title ? [`%% ${options.title.replace(/\n/g, ' ')}`] : []
  const lines = [
    ...header,
    `flowchart ${options.direction ?? 'LR'}`,
    ...nodeLines,
    ...edgeLines,
    ...classLines,
  ]
  return { text: `${lines.join('\n')}\n`, nodes: ids.size, edges: edgeLines.length }
}

/**
 * The view a mode would draw, as Mermaid.  Rendered at full detail (lod 0)
 * whatever the zoom, since a zoomed-out canvas drops labels and lines that an
 * export should keep.
 */
export function exportModeMermaid(
  mode: AnyMode,
  data: Derived,
  params: Record<string, unknown>,
  ui: UiState,
): MermaidExport {
  const spec = mode.select(data, params, { ...ui, lod: 0 })
  const focus = ui.focusPath ? ` @ ${ui.focusPath}` : ''
  return sceneToMermaid(spec, {
    direction: params.orientation === 'tb' ? 'TB' : 'LR',
    styles: mode.style(spec, params),
    title: `adventure-call: ${mode.label}${focus}`,
  })
}
