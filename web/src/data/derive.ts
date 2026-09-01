/**
 * Derivations over the raw graph export.
 *
 * Everything here is a pure function of its arguments and memoised on the
 * identity of the array it was given, so a component may call `indexSymbols`
 * or `buildFsTree` on every render without paying for it twice. `loadGraph`
 * hands back a fresh object per fetch, which is exactly the invalidation
 * signal we want: new data means new arrays means a real recompute.
 */
import { applyExcludes, normalizePath } from './filters'
import { fileFacts, matchFile, parseQuery } from './query'
import type {
  CallType,
  CodebaseGraph,
  Confidence,
  GraphEdge,
  GraphNode,
  ImportRecord,
  SymbolKind,
  SymbolRegistry,
} from './types'

// -- symbol index ------------------------------------------------------------

export interface SymbolIndex {
  /** Every node handed in, keyed by `id` (which equals `symbol_id`). */
  byId: ReadonlyMap<string, GraphNode>
  /** Non-module nodes grouped by their owning module id. */
  byModule: ReadonlyMap<string, GraphNode[]>
  /** Children keyed by `parent`; nodes with a null parent are not in here. */
  byParent: ReadonlyMap<string, GraphNode[]>
  /**
   * The module-level symbols of each module. The exporter leaves `parent`
   * null for top-level classes and functions rather than pointing them at the
   * module node, so `byParent` alone cannot start a containment walk.
   */
  rootsByModule: ReadonlyMap<string, GraphNode[]>
  /** Module nodes keyed by normalised `file_path`. */
  moduleByFile: ReadonlyMap<string, GraphNode>
  /** Module nodes keyed by module id. */
  moduleById: ReadonlyMap<string, GraphNode>
}

function push<K>(map: Map<K, GraphNode[]>, key: K, node: GraphNode): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(node)
  else map.set(key, [node])
}

const symbolIndexCache = new WeakMap<readonly GraphNode[], SymbolIndex>()

/** Index nodes by id, module, parent and file. Memoised per array. */
export function indexSymbols(nodes: readonly GraphNode[]): SymbolIndex {
  const cached = symbolIndexCache.get(nodes)
  if (cached) return cached

  const byId = new Map<string, GraphNode>()
  const byModule = new Map<string, GraphNode[]>()
  const byParent = new Map<string, GraphNode[]>()
  const rootsByModule = new Map<string, GraphNode[]>()
  const moduleByFile = new Map<string, GraphNode>()
  const moduleById = new Map<string, GraphNode>()

  for (const node of nodes) {
    byId.set(node.id, node)
    if (node.kind === 'module') {
      moduleById.set(node.id, node)
      moduleByFile.set(normalizePath(node.file_path), node)
      continue
    }
    push(byModule, node.module, node)
    if (node.parent === null) push(rootsByModule, node.module, node)
    else push(byParent, node.parent, node)
  }

  const index: SymbolIndex = {
    byId,
    byModule,
    byParent,
    rootsByModule,
    moduleByFile,
    moduleById,
  }
  symbolIndexCache.set(nodes, index)
  return index
}

// -- filesystem tree ---------------------------------------------------------

export interface FsFile {
  type: 'file'
  /** Basename, e.g. `loop.py`. */
  name: string
  /** Root-relative path, e.g. `src/carnot/agent/loop.py`. */
  path: string
  module: GraphNode
}

export interface FsDir {
  type: 'dir'
  name: string
  /** Root-relative path; the empty string for the tree root. */
  path: string
  /** Directories first, then files; each group sorted by name. */
  children: FsNode[]
  /** Files anywhere beneath this directory. */
  fileCount: number
}

export type FsNode = FsDir | FsFile

const fsTreeCache = new WeakMap<readonly GraphNode[], FsDir>()

/**
 * Build the directory tree implied by the modules' `file_path`s. Pass only
 * module nodes: one file is one module, and the other kinds would just
 * duplicate their file. Memoised per array.
 */
export function buildFsTree(moduleNodes: readonly GraphNode[]): FsDir {
  const cached = fsTreeCache.get(moduleNodes)
  if (cached) return cached

  const root: FsDir = { type: 'dir', name: '', path: '', children: [], fileCount: 0 }
  const dirs = new Map<string, FsDir>([['', root]])

  for (const module of moduleNodes) {
    const path = normalizePath(module.file_path)
    const segments = path.split('/').filter(Boolean)
    if (segments.length === 0) continue
    const fileName = segments.pop()!

    let parent = root
    let prefix = ''
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      let dir = dirs.get(prefix)
      if (!dir) {
        dir = { type: 'dir', name: segment, path: prefix, children: [], fileCount: 0 }
        dirs.set(prefix, dir)
        parent.children.push(dir)
      }
      parent = dir
    }
    parent.children.push({ type: 'file', name: fileName, path, module })
  }

  finalise(root)
  fsTreeCache.set(moduleNodes, root)
  return root
}

/** Sort in place, depth first, and roll file counts up to each directory. */
function finalise(dir: FsDir): number {
  let count = 0
  for (const child of dir.children) {
    count += child.type === 'dir' ? finalise(child) : 1
  }
  dir.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  dir.fileCount = count
  return count
}

/** Depth-first walk of every file in the tree, in display order. */
export function* walkFiles(dir: FsDir): Generator<FsFile> {
  for (const child of dir.children) {
    if (child.type === 'dir') yield* walkFiles(child)
    else yield child
  }
}

// -- file-to-file import edges -----------------------------------------------

export interface FileImportEdge {
  /** Root-relative path of the importing file. */
  source: string
  /** Root-relative path of the file that owns the imported symbol. */
  target: string
  /** Import statements collapsed into this edge. */
  count: number
  /**
   * The imported symbols that produced this edge, so a mode that expands a
   * file into its members can re-anchor the same edge onto sub-items.
   */
  symbolIds: string[]
}

const fileImportCache = new WeakMap<readonly GraphEdge[], WeakMap<SymbolIndex, FileImportEdge[]>>()

/**
 * Collapse the `module -> symbol` IMPORTS edges into deduped `file -> file`
 * edges. The target symbol is resolved through the index to the module that
 * owns it, then to that module's file; an import of a symbol we never parsed
 * (third-party, stdlib, or excluded) resolves to nothing and is dropped, as is
 * a self-edge from a file importing its own symbols. Memoised per
 * (edges, index) pair.
 */
export function deriveFileImports(
  edges: readonly GraphEdge[],
  index: SymbolIndex,
): FileImportEdge[] {
  let perIndex = fileImportCache.get(edges)
  if (!perIndex) {
    perIndex = new WeakMap()
    fileImportCache.set(edges, perIndex)
  }
  const cached = perIndex.get(index)
  if (cached) return cached

  const byPair = new Map<string, FileImportEdge>()
  const seenSymbols = new Map<string, Set<string>>()

  for (const edge of edges) {
    if (!edge.types.includes('IMPORTS')) continue

    const source = fileOf(edge.source, index)
    const target = fileOf(edge.target, index)
    if (source === null || target === null || source === target) continue

    const key = `${source}\u0000${target}`
    let collapsed = byPair.get(key)
    if (!collapsed) {
      collapsed = { source, target, count: 0, symbolIds: [] }
      byPair.set(key, collapsed)
      seenSymbols.set(key, new Set())
    }
    collapsed.count += edge.count || 1
    const seen = seenSymbols.get(key)!
    if (!seen.has(edge.target)) {
      seen.add(edge.target)
      collapsed.symbolIds.push(edge.target)
    }
  }

  const result = [...byPair.values()]
  perIndex.set(index, result)
  return result
}

/** The file a node id lives in, via its module, or null if it is unknown. */
function fileOf(id: string, index: SymbolIndex): string | null {
  const node = index.byId.get(id)
  if (!node) return null
  const module = index.moduleById.get(node.module)
  if (!module) return null
  return normalizePath(module.file_path)
}

const fileImportersCache = new WeakMap<
  readonly FileImportEdge[],
  ReadonlyMap<string, FileImportEdge[]>
>()

/**
 * The reverse of {@link deriveFileImports} (tic-0680): imported file -> the
 * edges that import it, i.e. "who depends on me".  The forward array answers
 * "what does this file import" with one `filter` per file; the "imported by"
 * question is the one an inspector panel and an expanded import-graph node
 * both ask, and answering it by scanning every edge per file is quadratic in
 * a graph whose edge count already runs into the thousands.
 *
 * The buckets hold the very same {@link FileImportEdge} objects as the
 * forward array, not copies, so a caller still has `count` and `symbolIds`
 * and identity comparisons against the forward edges hold.  A file nobody
 * imports is simply absent -- callers should treat a miss as "no importers"
 * rather than expecting an empty array.  No filtering happens here:
 * `deriveFileImports` already dropped self-imports and unresolved targets,
 * so every edge that reaches this function names two real files.  Memoised
 * per `fileImports` array, like every other derivation in this module.
 */
export function deriveFileImporters(
  fileImports: readonly FileImportEdge[],
): ReadonlyMap<string, FileImportEdge[]> {
  const cached = fileImportersCache.get(fileImports)
  if (cached) return cached

  const importers = new Map<string, FileImportEdge[]>()
  for (const edge of fileImports) {
    const bucket = importers.get(edge.target)
    if (bucket) bucket.push(edge)
    else importers.set(edge.target, [edge])
  }

  fileImportersCache.set(fileImports, importers)
  return importers
}

// -- import cycles -------------------------------------------------------------

export interface StronglyConnectedComponents {
  /** Node id -> id of its strongly-connected component; every node gets one,
   *  including a node that isn't part of any cycle.  The node id is a file
   *  path for the import graph and a symbol id for the call graph
   *  (tic-a8a6). */
  componentOf: ReadonlyMap<string, number>
  /** Component ids with more than one member: an honest cycle, where every
   *  member reaches every other member by following edges. A component of
   *  exactly one member just means "not part of a cycle" -- which includes a
   *  directly self-recursive function, whose self-loop Tarjan's does not
   *  treat as a cycle. */
  cyclic: ReadonlySet<number>
}

const sccCache = new WeakMap<readonly FileImportEdge[], StronglyConnectedComponents>()

/**
 * Strongly-connected components of the file-level import graph (tic-56b2),
 * via Tarjan's algorithm -- run iteratively, an explicit work stack standing
 * in for the call stack a recursive version would use, since the file count
 * can run into the thousands, more than is safe to recurse over in JS.
 * `deriveFileImports` already drops self-imports, so a lone file can only
 * end up in a singleton component, never flagged cyclic on its own. Memoised
 * per `fileImports` array.
 */
export function deriveStronglyConnectedComponents(
  fileImports: readonly FileImportEdge[],
): StronglyConnectedComponents {
  const cached = sccCache.get(fileImports)
  if (cached) return cached

  const adjacency = new Map<string, string[]>()
  const addNode = (id: string): void => {
    if (!adjacency.has(id)) adjacency.set(id, [])
  }
  for (const edge of fileImports) {
    addNode(edge.source)
    addNode(edge.target)
    adjacency.get(edge.source)!.push(edge.target)
  }

  const result = stronglyConnectedComponents(adjacency)
  sccCache.set(fileImports, result)
  return result
}

/**
 * Tarjan's algorithm over a bare adjacency map (tic-a8a6), so the call graph
 * can reuse the implementation the import graph proved rather than growing a
 * second copy of it.  Callers own their own memoisation; this function does
 * none, because the identity it would key on differs per caller.
 *
 * Two properties of the result are relied on elsewhere and must survive any
 * future edit here:
 *
 * 1. Every key of `adjacency` lands in `componentOf`, including a node with no
 *    edges at all -- an isolated node is a component of one.  That is what
 *    lets a caller pass its whole node set and get orphans back rather than
 *    silently losing them.
 * 2. Component ids come out in REVERSE TOPOLOGICAL ORDER of the condensation:
 *    for any edge crossing from component A to component B, `id(B) < id(A)`.
 *    Tarjan's closes a component only once everything reachable from it is
 *    closed, so this falls out of the algorithm rather than being arranged.
 *    Worth stating because it hands the next derivation a topological order
 *    for free, and because it is itself the proof that the condensation is
 *    acyclic -- a graph whose every edge runs from a higher id to a lower one
 *    cannot contain a cycle.
 *
 * A self-loop does NOT make a component cyclic: Tarjan's puts a self-recursive
 * node in a component of one, and `cyclic` means "more than one member", i.e.
 * mutual recursion.  Direct recursion is a separate fact and callers that care
 * must look for the self-edge themselves (see {@link CallGraph.recursive}).
 */
export function stronglyConnectedComponents(
  adjacency: ReadonlyMap<string, readonly string[]>,
): StronglyConnectedComponents {
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const componentOf = new Map<string, number>()
  const cyclic = new Set<number>()
  let nextIndex = 0
  let nextComponent = 0

  for (const start of adjacency.keys()) {
    if (index.has(start)) continue

    // One work frame per node on the simulated call stack, tracking how far
    // through its adjacency list that "call" has gotten.
    const work: { node: string; i: number }[] = [{ node: start, i: 0 }]
    index.set(start, nextIndex)
    lowlink.set(start, nextIndex)
    nextIndex++
    stack.push(start)
    onStack.add(start)

    while (work.length > 0) {
      const frame = work[work.length - 1]
      const children = adjacency.get(frame.node)!
      if (frame.i < children.length) {
        const child = children[frame.i]
        frame.i++
        if (!index.has(child)) {
          index.set(child, nextIndex)
          lowlink.set(child, nextIndex)
          nextIndex++
          stack.push(child)
          onStack.add(child)
          work.push({ node: child, i: 0 })
        } else if (onStack.has(child)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(child)!))
        }
        continue
      }

      // Every child explored: fold this node's lowlink into its caller's
      // (mirroring the recursive algorithm's post-call `lowlink[v] =
      // min(lowlink[v], lowlink[w])`), then close the component if this node
      // is its root.
      work.pop()
      const parent = work[work.length - 1]
      if (parent) {
        lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!))
      }
      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const id = nextComponent++
        let size = 0
        let member: string
        do {
          member = stack.pop()!
          onStack.delete(member)
          componentOf.set(member, id)
          size++
        } while (member !== frame.node)
        if (size > 1) cyclic.add(id)
      }
    }
  }

  return { componentOf, cyclic }
}

// -- call graph ---------------------------------------------------------------

/** One caller -> callee relationship, carrying what the exporter merged onto
 *  it.  A pair appears at most once: the exporter already folds repeated call
 *  sites into `count` and `lines`. */
export interface CallEdge {
  source: string
  target: string
  /** Call sites behind this edge; 0 for a derived edge (see `implicit`). */
  count: number
  lines: readonly number[]
  confidence: Confidence
  callTypes: readonly CallType[]
  /**
   * True for the derived `class -> class.__init__` edge, which stands for
   * "constructing this runs that" and has no call site of its own.  Anything
   * reporting on real call sites -- a coverage figure, a line list, a jump to
   * source -- must skip these; anything walking flow must follow them.
   */
  implicit?: boolean
}

export interface CallGraph {
  /**
   * Every node in the graph, in export order.  This is every callable in the
   * index PLUS the classes that take part in a call, and it deliberately
   * includes nodes with no edges at all -- an unreferenced function is an
   * orphan, which is a finding, not something to drop.
   */
  nodes: readonly string[]
  /** Caller -> its outgoing edges.  A node with no callees is absent. */
  callees: ReadonlyMap<string, readonly CallEdge[]>
  /** Callee -> its incoming edges.  A node with no callers is absent. */
  callers: ReadonlyMap<string, readonly CallEdge[]>
  /** Node id -> strongly-connected component id; every node has one. */
  componentOf: ReadonlyMap<string, number>
  /** Components with more than one member: mutual recursion. */
  cyclic: ReadonlySet<number>
  /** Component id -> its members, in export order. */
  members: ReadonlyMap<number, readonly string[]>
  /**
   * Functions that call themselves directly.  Kept separate from `cyclic`
   * because Tarjan's puts a self-recursive function in a component of one:
   * size alone cannot tell direct recursion from no recursion, and the two
   * read completely differently to a human.
   */
  recursive: ReadonlySet<string>
  /**
   * The condensation: component id -> the component ids it calls, with
   * self-references removed.  This is a DAG -- always, whatever the call
   * graph does -- which is the entire reason mode 3 can be laid out in two
   * dimensions at all.  Every component has an entry, empty when it calls
   * nothing outside itself.
   *
   * Ids are in reverse topological order (see
   * {@link stronglyConnectedComponents}), so iterating components from 0
   * upwards visits callees before callers -- what a memoised bottom-up walk
   * (reach, effect propagation) wants, with no topological sort needed.
   */
  condensed: ReadonlyMap<number, readonly number[]>
  /**
   * The condensation reversed: component id -> the component ids that call
   * it.  Every component has an entry, empty when nothing outside itself
   * calls it.
   *
   * Kept here rather than inverted by each consumer because it is a fact
   * about the graph, not a rendering decision, and because more than one
   * thing wants it: mode 3's rooted view walks it for the "who can reach
   * this" cone (tic-7a5e), and the dominator work (tic-d8f2) will need it
   * too.  Building it in the same pass costs one map over the edges already
   * being walked, against every caller paying for its own inversion.
   */
  condensedCallers: ReadonlyMap<number, readonly number[]>
}

/** Kinds that can appear at either end of a CALLS edge.  Classes are in here
 *  because `Foo()` resolves to the class, not to its `__init__`. */
const CALL_NODE_KINDS = new Set<SymbolKind>(['function', 'method', 'class'])

const callGraphCache = new WeakMap<readonly GraphEdge[], WeakMap<SymbolIndex, CallGraph>>()

/**
 * The call graph and its condensation (tic-a8a6) -- the foundation mode 3
 * stands on.  Pure derivation over the CALLS edges already in the export; no
 * new extraction, and nothing here asks the parser for anything.
 *
 * Endpoints are resolved through the index, so an edge touching a node the
 * excludes or the file query removed is dropped rather than left dangling.
 * That is not a nicety: tic-56b2 found elk crashing on exactly that shape of
 * dangling reference in the import graph, and this derivation feeds the same
 * layout engine.
 *
 * ## Classes are nodes here, unlike everywhere else
 *
 * The rest of the app treats a class as a container, not a graph node.  The
 * call graph cannot, because the exporter resolves `Foo()` to the class
 * symbol: on the ../carnot export this was measured against, 635 of 3449
 * CALLS edges (18%) point at a class, and another 38 come FROM one (a call in
 * a class body, which runs at import time).  Restricting nodes to
 * `function | method` would silently delete every constructor call from a
 * view whose whole premise is not lying about what it cannot see.
 *
 * So a class joins the node set by TAKING PART in a call, never merely by
 * existing -- a class nobody constructs is not call-flow material, and
 * admitting all 223 of them would drown the orphan analysis the next tickets
 * do.  Where the constructed class has an in-project `__init__`, a derived
 * `class -> __init__` edge carries the flow onward (see
 * {@link CallEdge.implicit}); without it `__init__` would look like an entry
 * point, which it very much is not.  Only 27 of the 96 constructed classes in
 * ../carnot have one -- the rest are dataclasses, exception subclasses and
 * framework subclasses whose `__init__` genuinely is not in this codebase,
 * and for those the class is honestly a leaf.
 *
 * ## What is missing, and is not this function's to fix
 *
 * Module-level calls are absent from the export entirely: `GraphBuilder`
 * takes `module_call_edges=False` by default, so import-time flow is
 * invisible here and no derivation can recover it.  And the export resolves
 * only about half of all non-builtin call sites, so this graph is a floor on
 * what the code does, never a ceiling -- tic-171f is where that gets said out
 * loud in the UI.  Memoised per (edges, index) pair, like every other
 * derivation in this module.
 */
export function deriveCallGraph(edges: readonly GraphEdge[], index: SymbolIndex): CallGraph {
  let perIndex = callGraphCache.get(edges)
  if (!perIndex) {
    perIndex = new WeakMap()
    callGraphCache.set(edges, perIndex)
  }
  const cached = perIndex.get(index)
  if (cached) return cached

  // Every callable is a node up front, so a function nothing calls and that
  // calls nothing still appears; classes are added below only if they take
  // part in a call.
  const nodes = new Set<string>()
  for (const node of index.byId.values()) {
    if (node.kind === 'function' || node.kind === 'method') nodes.add(node.id)
  }

  const callEdges: CallEdge[] = []
  const constructed = new Set<string>()
  const recursive = new Set<string>()

  for (const edge of edges) {
    if (!edge.types.includes('CALLS')) continue
    const source = index.byId.get(edge.source)
    const target = index.byId.get(edge.target)
    if (!source || !target) continue
    if (!CALL_NODE_KINDS.has(source.kind) || !CALL_NODE_KINDS.has(target.kind)) continue

    nodes.add(source.id)
    nodes.add(target.id)
    if (target.kind === 'class') constructed.add(target.id)
    if (source.id === target.id) recursive.add(source.id)

    callEdges.push({
      source: source.id,
      target: target.id,
      count: edge.count,
      lines: edge.lines,
      confidence: edge.confidence,
      callTypes: edge.call_types,
    })
  }

  // Constructing a class runs its __init__, so carry the flow through to it.
  for (const classId of constructed) {
    const initId = `${classId}.__init__`
    const init = index.byId.get(initId)
    if (!init || init.kind !== 'method') continue
    nodes.add(initId)
    callEdges.push({
      source: classId,
      target: initId,
      count: 0,
      lines: [],
      confidence: 'exact',
      callTypes: [],
      implicit: true,
    })
  }

  const callees = new Map<string, CallEdge[]>()
  const callers = new Map<string, CallEdge[]>()
  for (const edge of callEdges) {
    const out = callees.get(edge.source)
    if (out) out.push(edge)
    else callees.set(edge.source, [edge])
    const incoming = callers.get(edge.target)
    if (incoming) incoming.push(edge)
    else callers.set(edge.target, [edge])
  }

  // Pass the FULL node set to Tarjan's, not just the edge endpoints, so
  // isolated nodes come back as components of one instead of vanishing.
  const adjacency = new Map<string, string[]>()
  for (const id of nodes) adjacency.set(id, [])
  for (const edge of callEdges) adjacency.get(edge.source)!.push(edge.target)

  const { componentOf, cyclic } = stronglyConnectedComponents(adjacency)

  const nodeList = [...nodes]
  const members = new Map<number, string[]>()
  for (const id of nodeList) {
    const component = componentOf.get(id)!
    const bucket = members.get(component)
    if (bucket) bucket.push(id)
    else members.set(component, [id])
  }

  const condensed = new Map<number, number[]>()
  const condensedCallers = new Map<number, number[]>()
  const seen = new Map<number, Set<number>>()
  for (const component of members.keys()) {
    condensed.set(component, [])
    condensedCallers.set(component, [])
    seen.set(component, new Set())
  }
  for (const edge of callEdges) {
    const from = componentOf.get(edge.source)!
    const to = componentOf.get(edge.target)!
    if (from === to) continue
    const already = seen.get(from)!
    if (already.has(to)) continue
    already.add(to)
    condensed.get(from)!.push(to)
    condensedCallers.get(to)!.push(from)
  }

  const result: CallGraph = {
    nodes: nodeList,
    callees,
    callers,
    componentOf,
    cyclic,
    members,
    recursive,
    condensed,
    condensedCallers,
  }
  perIndex.set(index, result)
  return result
}

// -- external imports --------------------------------------------------------

export interface ExternalImport {
  /** Root-relative path of the importing file. */
  source: string
  /** Dotted target as written, e.g. `collections.abc` or `rich.console`. */
  target: string
  /** Number of import statements in this file naming this target. */
  count: number
}

const externalImportCache = new WeakMap<SymbolRegistry, WeakMap<SymbolIndex, ExternalImport[]>>()

/**
 * The registry's external imports (tic-314c), collapsed to per-file, per-target
 * rows.  `codebase_graph.json` keeps only resolved internal IMPORTS edges, so
 * third-party and stdlib imports never reach the canvas -- they do live in the
 * registry (`modules[*].imports`), and this is the lazy layer that surfaces
 * them once the registry has been fetched.
 *
 * Classification never uses a first-segment heuristic: an import is external
 * when the registry's own binding for it is `kind: 'external'`, falling back to
 * "its target does not resolve to a known symbol or module in the graph index"
 * for the few imports the resolver did not bind (e.g. wildcards).  Only files
 * that survived the workspace's excludes/query appear, so a filtered workspace
 * shows exactly what it shows elsewhere.  Memoised per (registry, index) pair.
 */
export function deriveExternalImports(
  registry: SymbolRegistry,
  index: SymbolIndex,
): ExternalImport[] {
  let perIndex = externalImportCache.get(registry)
  if (!perIndex) {
    perIndex = new WeakMap()
    externalImportCache.set(registry, perIndex)
  }
  const cached = perIndex.get(index)
  if (cached) return cached

  const byFileAndTarget = new Map<string, ExternalImport>()
  for (const [moduleId, module] of Object.entries(registry.modules)) {
    const moduleNode = index.moduleById.get(moduleId)
    if (!moduleNode) continue // filtered out of this workspace
    const source = normalizePath(moduleNode.file_path)
    const byTarget = new Map<string, number>()
    for (const imp of module.imports) {
      if (!isExternalImport(imp, moduleId, registry, index)) continue
      byTarget.set(imp.target, (byTarget.get(imp.target) ?? 0) + 1)
    }
    for (const [target, count] of byTarget) {
      byFileAndTarget.set(`${source}\u0000${target}`, { source, target, count })
    }
  }

  const result = [...byFileAndTarget.values()]
  perIndex.set(index, result)
  return result
}

/**
 * An import is external when the registry binding it produced is
 * `kind: 'external'`; where no binding exists (e.g. a wildcard import) it falls
 * back to whether the dotted target resolves to a known symbol or module in the
 * graph index.
 */
function isExternalImport(
  imp: ImportRecord,
  moduleId: string,
  registry: SymbolRegistry,
  index: SymbolIndex,
): boolean {
  const binding = registry.bindings[moduleId]?.[imp.alias]
  if (binding) return binding.kind === 'external'
  return !resolvesInIndex(imp, index)
}

/** True when the import's target names a symbol or module the index knows. */
function resolvesInIndex(imp: ImportRecord, index: SymbolIndex): boolean {
  if (index.byId.has(imp.target)) return true
  if (index.moduleById.has(imp.target)) return true
  if (imp.target_module && index.moduleById.has(imp.target_module)) return true
  if (imp.target_module && imp.target_symbol) {
    if (index.byId.has(`${imp.target_module}.${imp.target_symbol}`)) return true
  }
  return false
}

// -- external calls ----------------------------------------------------------

/** One caller's calls out to a third-party or stdlib module (tic-d8a8). */
export interface ExternalCall {
  /** Symbol id of the calling function or method. */
  source: string
  /** Root module called into, e.g. `django`, `json`, `httpx`. */
  target: string
  /** Call sites from this caller into that module. */
  count: number
}

const EXTERNAL_REASON = 'external: '

const externalCallCache = new WeakMap<SymbolRegistry, WeakMap<SymbolIndex, ExternalCall[]>>()

/**
 * Where the code calls OUT of itself (tic-d8a8), per caller and per root
 * module.
 *
 * `codebase_graph.json` keeps only calls that resolved to an in-project
 * symbol, so every call into django, json or httpx is dropped from the graph
 * and survives only as an entry in the registry's `unresolved_calls` with a
 * reason of `external: <dotted target>`.  For a view about FLOW that is a real
 * loss: "this function reaches out to the filesystem" is exactly the kind of
 * thing the mode exists to show, and leaving it out would draw such a
 * function as a dead end.
 *
 * Aggregated to the ROOT module rather than the full dotted target -- one
 * `django` node, not `django.db.models.Manager.create`.  Measured on the
 * hypermenu export, that is the difference between 38 sink nodes and several
 * hundred: at root granularity the sinks read as "what this codebase depends
 * on", which is a picture, and at full granularity they read as a wall.
 *
 * Callers not in the index (excluded, or filtered out by the file query) are
 * dropped, so this never introduces a dangling endpoint -- the same guard
 * every other derivation here applies, and the one whose absence crashed elk
 * in tic-56b2.  Memoised per (registry, index) pair.
 */
export function deriveExternalCalls(
  registry: SymbolRegistry,
  index: SymbolIndex,
): ExternalCall[] {
  let perIndex = externalCallCache.get(registry)
  if (!perIndex) {
    perIndex = new WeakMap()
    externalCallCache.set(registry, perIndex)
  }
  const cached = perIndex.get(index)
  if (cached) return cached

  const byPair = new Map<string, ExternalCall>()
  for (const call of registry.unresolved_calls) {
    if (!call.reason?.startsWith(EXTERNAL_REASON)) continue
    if (!index.byId.has(call.caller_id)) continue
    const target = call.reason.slice(EXTERNAL_REASON.length).split('.')[0]
    if (target === '') continue
    const key = `${call.caller_id}\u0000${target}`
    const existing = byPair.get(key)
    if (existing) existing.count++
    else byPair.set(key, { source: call.caller_id, target, count: 1 })
  }

  const result = [...byPair.values()]
  perIndex.set(index, result)
  return result
}

// -- assembled workspace -----------------------------------------------------

export interface Workspace {
  /** Nodes of every kind that survived the exclude list and file query. */
  nodes: GraphNode[]
  /** The module (i.e. file) nodes among {@link Workspace.nodes}. */
  modules: GraphNode[]
  index: SymbolIndex
  tree: FsDir
  fileImports: FileImportEdge[]
  /** Reverse of {@link Workspace.fileImports} (tic-0680): imported file ->
   *  the edges importing it, so "who imports this?" is a map lookup rather
   *  than a scan of every edge. A file nobody imports is absent. */
  fileImporters: ReadonlyMap<string, FileImportEdge[]>
  /** Strongly-connected components of {@link Workspace.fileImports} (tic-56b2),
   *  so a mode can highlight an honest import cycle instead of leaving it to
   *  read as an arbitrary tangle of edges. */
  importCycles: StronglyConnectedComponents
  /** The CALLS graph and its condensation into a DAG (tic-a8a6), which mode 3
   *  reads rather than rebuilding.  Derived from the same `graph.edges` the
   *  import layers walk, so it costs one more pass over them and is memoised
   *  alongside everything else here. */
  callGraph: CallGraph
  /**
   * External imports from the registry (tic-314c), grouped per file and
   * target.  Empty until the registry has been fetched -- startup stays on
   * `codebase_graph.json` alone, and the canvas gains this detail when the
   * registry lands.
   */
  externalImports: ExternalImport[]
  /** Calls out of the codebase (tic-d8a8), per caller and root module.
   *  Empty until the registry has been fetched, exactly like
   *  {@link Workspace.externalImports}. */
  externalCalls: ExternalCall[]
  /**
   * The registry this workspace was derived with (tic-171f), or null while
   * the app is still on codebase_graph.json alone.  Carried so a mode can
   * feed it to registry-hungry derivations -- call-flow's per-callable
   * coverage -- rather than each mode growing its own channel for it.  The
   * workspace cache already keys on registry identity (a new registry means
   * a fresh Workspace), so consumers can memoise on this field like any
   * other input.
   */
  registry: SymbolRegistry | null
  /** Module nodes the exclude list removed, for reporting in the UI. */
  excludedFiles: number
}

const EMPTY_EXTERNAL_IMPORTS: ExternalImport[] = []
const EMPTY_EXTERNAL_CALLS: ExternalCall[] = []

interface CachedWorkspace {
  workspace: Workspace
  /** The registry the external-import layer was derived from, if any. */
  registry: SymbolRegistry | null
}

const workspaceCache = new WeakMap<CodebaseGraph, Map<string, CachedWorkspace>>()

/**
 * Everything mode 1 needs, in one pass: excludes applied, then the index, the
 * tree and the file-level import edges built from what is left. Memoised on
 * the graph object and the exclude list, so re-rendering is free and a `/out`
 * refetch (a new graph object) recomputes.
 *
 * `fileQuery` is the Filter Files query (tic-9098), applied after the excludes
 * when the visibility toggle is on: modules that do not match are dropped
 * here, so the mode's select phase never sees them and the canvas never
 * learns about search. An invalid regex matches nothing; the UI reports the
 * parse error inline.
 */
export function deriveWorkspace(
  graph: CodebaseGraph,
  excludes: readonly string[],
  fileQuery = '',
  registry: SymbolRegistry | null = null,
): Workspace {
  let perExcludes = workspaceCache.get(graph)
  if (!perExcludes) {
    perExcludes = new Map()
    workspaceCache.set(graph, perExcludes)
  }
  const key = `${JSON.stringify(excludes)}\u0000${fileQuery}`
  const cached = perExcludes.get(key)
  if (cached && cached.registry === registry) return cached.workspace

  const query = parseQuery(fileQuery)
  const survivors = applyExcludes(graph.nodes, excludes)
  const totalFiles = graph.nodes.reduce((n, node) => n + (node.kind === 'module' ? 1 : 0), 0)

  let nodes = survivors
  let modules = survivors.filter((node) => node.kind === 'module')
  if (query.kind !== 'empty') {
    const preIndex = indexSymbols(survivors)
    modules = modules.filter((module) =>
      matchFile(query, fileFacts(module, preIndex.byModule.get(module.id) ?? [])),
    )
    const kept = new Set(modules.map((module) => module.id))
    nodes = survivors.filter((node) => node.kind === 'module' || kept.has(node.module))
  }
  const index = indexSymbols(nodes)
  const fileImports = deriveFileImports(graph.edges, index)

  const workspace: Workspace = {
    nodes,
    modules,
    index,
    tree: buildFsTree(modules),
    fileImports,
    fileImporters: deriveFileImporters(fileImports),
    importCycles: deriveStronglyConnectedComponents(fileImports),
    callGraph: deriveCallGraph(graph.edges, index),
    externalImports: registry ? deriveExternalImports(registry, index) : EMPTY_EXTERNAL_IMPORTS,
    externalCalls: registry ? deriveExternalCalls(registry, index) : EMPTY_EXTERNAL_CALLS,
    registry,
    excludedFiles: totalFiles - modules.length,
  }
  perExcludes.set(key, { workspace, registry })
  return workspace
}
