/**
 * Pure conversion between the domain graph description and elk's ElkNode
 * tree (tic-e82b). Kept separate from elkGraph.ts so the shape of the
 * conversion is unit-testable without running the actual layout algorithm or
 * a real Worker.
 */
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api.js'
import type {
  ElkGraphEdgeInput,
  ElkGraphInput,
  ElkGraphNodeInput,
  ElkGraphResult,
  ElkLayoutOptions,
  ElkRect,
} from './elkTypes'

const DEFAULT_LAYER_GAP = 64
const DEFAULT_NODE_GAP = 12

/**
 * Build the ElkNode tree elk.layout() consumes, configured for the layered
 * algorithm with direction 'DOWN' -- so a source node (the importer) lands in
 * an earlier layer than its target (the imported file), i.e. importers rank
 * above what they import (tic-5f52).
 */
export function toElkNode(input: ElkGraphInput, options: ElkLayoutOptions = {}): ElkNode {
  const layerGap = options.layerGap ?? DEFAULT_LAYER_GAP
  const nodeGap = options.nodeGap ?? DEFAULT_NODE_GAP
  return {
    id: input.id,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(layerGap),
      'elk.spacing.nodeNode': String(nodeGap),
    },
    children: input.nodes.map(toElkChild),
    edges: input.edges.map(toElkEdge),
  }
}

function toElkChild(node: ElkGraphNodeInput): ElkNode {
  return {
    id: node.id,
    width: node.width,
    height: node.height,
    ...(node.ports && node.ports.length > 0 ? { ports: node.ports.map(toElkPort) } : {}),
    ...(node.children && node.children.length > 0
      ? { children: node.children.map(toElkChild) }
      : {}),
  }
}

function toElkPort(port: { id: string; width?: number; height?: number }): ElkPort {
  return { id: port.id, width: port.width ?? 1, height: port.height ?? 1 }
}

function toElkEdge(edge: ElkGraphEdgeInput): ElkExtendedEdge {
  return { id: edge.id, sources: [edge.source], targets: [edge.target] }
}

/**
 * Flatten a laid-out ElkNode tree into absolute rects and edge polylines.
 * elk positions a node's children, ports and edge sections relative to that
 * node's own origin, so this walks the tree accumulating each ancestor's
 * offset -- the only way to recover world-space coordinates for a nested
 * (compound) graph.
 */
export function fromElkResult(root: ElkNode): ElkGraphResult {
  const rects = new Map<string, ElkRect>()
  const edgePoints = new Map<string, number[]>()

  const walk = (node: ElkNode, originX: number, originY: number): void => {
    const x = originX + (node.x ?? 0)
    const y = originY + (node.y ?? 0)
    // The synthetic root wraps the real graph but isn't itself an element.
    if (node !== root) {
      rects.set(node.id, { x, y, width: node.width ?? 0, height: node.height ?? 0 })
    }
    for (const port of node.ports ?? []) {
      rects.set(port.id, {
        x: x + (port.x ?? 0),
        y: y + (port.y ?? 0),
        width: port.width ?? 0,
        height: port.height ?? 0,
      })
    }
    for (const edge of node.edges ?? []) {
      const points: number[] = []
      for (const section of edge.sections ?? []) {
        points.push(x + section.startPoint.x, y + section.startPoint.y)
        for (const bend of section.bendPoints ?? []) points.push(x + bend.x, y + bend.y)
        points.push(x + section.endPoint.x, y + section.endPoint.y)
      }
      edgePoints.set(edge.id, points)
    }
    for (const child of node.children ?? []) walk(child, x, y)
  }
  walk(root, 0, 0)

  return { rects, edgePoints }
}
