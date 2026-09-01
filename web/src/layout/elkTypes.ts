/**
 * The domain-facing graph description and result for tic-e82b's elk-backed
 * layout. No elkjs types leak past ./elkConvert and ./elkGraph, so a
 * consuming mode never needs to know elk is involved.
 */

export interface ElkGraphPortInput {
  id: string
  width?: number
  height?: number
}

export interface ElkGraphNodeInput {
  id: string
  width: number
  height: number
  /** Nested nodes, e.g. rows inside an expanded file container. */
  children?: readonly ElkGraphNodeInput[]
  /** Anchor points on this node an edge can target, e.g. one per row. */
  ports?: readonly ElkGraphPortInput[]
}

export interface ElkGraphEdgeInput {
  id: string
  /** A node id, or a port id declared on some node in the graph. */
  source: string
  /** A node id, or a port id declared on some node in the graph. */
  target: string
}

export interface ElkGraphInput {
  id: string
  nodes: readonly ElkGraphNodeInput[]
  edges: readonly ElkGraphEdgeInput[]
}

/** World-space rectangle, structurally identical to the canvas `Rect`. */
export interface ElkRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ElkGraphResult {
  /** Absolute rect per node id and per port id. */
  rects: ReadonlyMap<string, ElkRect>
  /** Flat `[x0, y0, x1, y1, ...]` polyline per edge id, absolute. */
  edgePoints: ReadonlyMap<string, readonly number[]>
}

/** Per-run tuning, layered on top of the worker's defaults. */
export interface ElkLayoutOptions {
  /** Gap between successive layers. Default 64, matching tidyTree's tierGap. */
  layerGap?: number
  /** Gap between nodes in the same layer. Default 12, matching tidyTree's siblingGap. */
  nodeGap?: number
}
