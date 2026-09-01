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

/** World-space point, structurally identical to the canvas `Point`. */
export interface ElkGraphPoint {
  x: number
  y: number
}

export interface ElkGraphResult {
  /** Absolute rect per node id and per port id. */
  rects: ReadonlyMap<string, ElkRect>
  /** Flat `[x0, y0, x1, y1, ...]` polyline per edge id, absolute. */
  edgePoints: ReadonlyMap<string, readonly number[]>
  /**
   * Where a merged edge's trunk splits, absolute, keyed by edge id
   * (tic-531b).
   *
   * This is elk's `org.eclipse.elk.junctionPoints`, which is an OUTPUT
   * property rather than something the caller asks for: when edges share a
   * trunk (see {@link ElkLayoutOptions.mergeEdges}) elk reports the points
   * where lines join or part, which is exactly where a junction symbol
   * belongs.  An edge elk computed no junctions for is simply absent from
   * the map, so the ordinary unmerged layout carries no extra weight.
   */
  junctionPoints: ReadonlyMap<string, readonly ElkGraphPoint[]>
}

/** Per-run tuning, layered on top of the worker's defaults. */
export interface ElkLayoutOptions {
  /** Gap between successive layers. Default 64, matching tidyTree's tierGap. */
  layerGap?: number
  /** Gap between nodes in the same layer. Default 12, matching tidyTree's siblingGap. */
  nodeGap?: number
  /**
   * Merge edges sharing an endpoint into a common trunk (tic-531b).
   *
   * Sets elk's layered option `mergeEdges`: every edge entering a node is
   * routed through one shared input point and every edge leaving it through
   * one shared output point, so edges that declare no explicit port stop
   * fanning out across the node's border and overlap into trunks instead.
   * Default false, i.e. each connection keeps its own line, which is the
   * historical behaviour and stays the default for the import graph.
   */
  mergeEdges?: boolean
}
