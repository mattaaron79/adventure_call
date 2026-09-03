/**
 * The workspace surface every mode renders into.
 *
 * Layers, bottom to top: grid, groups, edges, nodes, overlay.  Only the node
 * layer listens -- the grid and the group boxes must not swallow the
 * empty-space drag that pans the camera, and hit-testing a couple of thousand
 * edges on every pointer move would be the most expensive thing on the canvas.
 *
 * The camera transform is applied to the three world layers rather than to the
 * Stage, which leaves the grid and the rubber band in screen space where they
 * belong.
 *
 * Everything drawn is a memoised component keyed on its scene item, so a pan
 * re-renders this component and then bails out of its children instead of
 * rebuilding them.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { Arc, Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva'
import {
  DBLCLICK_MS,
  EDGE_HOVER_RADIUS_PX,
  EDGE_POPUP_MAX_LINES,
  GOTO_DURATION_MS,
  NODE_DRAG_THRESHOLD,
  TWEEN_DURATION,
} from '../settings'
import { emitGoto, onGoto } from '../data/goto'
import { modeById } from '../modes/registry'
import { resolveGoto, type ModeOutput } from '../modes/types'
import {
  relayout,
  selectExpanded,
  selectFocusPath,
  selectOverrides,
  selectViewport,
  useWorkspace,
} from '../state/store'
import { FILE_SYMLINK_ICON_PATHS } from '../ui/FileSymlinkIcon'
import { GOTO_ICON_PATHS } from '../ui/GotoIcon'
import { GO_IN_ICON_PATHS } from '../ui/GoInIcon'
import { LOCAL_VIEW_ICON_PATHS } from '../ui/VectorPolygonIcon'
import { launchVscodeLink } from '../ui/Inspector'
import { BreadcrumbToolbar } from './BreadcrumbToolbar'
import { Grid } from './Grid'
import { CanvasIconButton } from './IconButton'
import { actionAffordance, iconSlots } from './iconButtonLogic'
import { lodOf } from './lod'
import { wedgeLabelFit, wedgeLabelWidth } from './wedgeLabel'
import {
  ANTS_DASH,
  antsDashOffset,
  cullScene,
  describeConnections,
  edgesNearPoint,
  endpointNodesOf,
  highlightedEdgesLast,
  connectionEdgesIncidentTo,
  edgePopupHeight,
  isConnection,
  isAntsEdge,
  nodesInRect,
  placedRects,
  reproject,
  sceneBounds,
  visibleWorldRect,
  type Scene,
  type SceneEdge,
  type SceneGroup,
  type SceneNode,
} from './scene'
import { THEME } from './theme'
import { useViewport } from './useViewport'
import { centerOn, screenToWorld, type Point, type Rect as WorldRect } from './viewport'

const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif'

/** World-space radius of a junction dot (tic-531b).  Small enough to read as
 *  a joint on a 1px trunk rather than a node of its own, and it scales with
 *  the camera like every other world-space shape, so it vanishes politely at
 *  low zoom instead of pockmarking the graph. */
const JUNCTION_RADIUS = 3

/**
 * The glyphs a focus affordance can wear (tic-d7d7), by the small id a mode
 * puts on `SceneNode.focusIcon`.  The button itself stays generic: a mode
 * names a shape, the canvas looks it up here, and an unset (or unknown) id
 * falls back to the folder-and-arrow the fs-tree has always drawn -- so
 * adding an affordance is an entry here and a string in the mode.
 */
const FOCUS_ICON_PATHS: Readonly<Record<string, readonly string[]>> = {
  'go-in': GO_IN_ICON_PATHS,
  'local-view': LOCAL_VIEW_ICON_PATHS,
}

/** Nothing selected and nothing hovered: the lit-edge set and the connected-
 *  node set both stay this one stable reference so the idle scene (and every
 *  pan/zoom frame) re-renders for free (tic-5393, tic-ece1).  Two empty sets
 *  would render identically but break the memo identity that makes the idle
 *  case cost nothing, so both memos return this. */
const NO_HIGHLIGHT: ReadonlySet<string> = new Set()

/** The near-pointer connection summary (tic-f1d7), in host-relative px. */
interface EdgePopup {
  x: number
  y: number
  /** One `importer -> imported` line per connection, at most
   *  {@link EDGE_POPUP_MAX_LINES} of them. */
  lines: string[]
  /** Connections within the pick radius that the list does not name. */
  more: number
}

interface NodeHandlers {
  onPointerDown: (e: KonvaEventObject<PointerEvent>) => void
  onPointerUp: (e: KonvaEventObject<PointerEvent>) => void
  onDragStart: (e: KonvaEventObject<DragEvent>) => void
  onDragMove: (e: KonvaEventObject<DragEvent>) => void
  onDragEnd: (e: KonvaEventObject<DragEvent>) => void
  onMouseEnter: (e: KonvaEventObject<MouseEvent>) => void
  onMouseLeave: () => void
}

interface DragSession {
  /** The node under the pointer; Konva moves this one for us. */
  anchor: string
  /** Every node travelling with it, the anchor included. */
  ids: string[]
  /** World positions at drag start, so the delta is never accumulated. */
  start: Map<string, Point>
}

/** The Konva nodes of one group box, for imperative drag updates (tic-1d7c). */
interface GroupShapes {
  group: Konva.Group
  rect: Konva.Rect
  text: Konva.Text
}

/** Push a recomputed group rect onto its Konva nodes. */
function applyGroupGeometry(shapes: GroupShapes, group: SceneGroup): void {
  shapes.group.position({ x: group.x, y: group.y })
  shapes.rect.width(group.width)
  shapes.rect.height(group.height)
  shapes.text.width(Math.max(0, group.width - 28))
}

export function Workspace({
  scene,
  output,
  sourceLinks,
  onActivate,
  expandable,
  fileOnlyDirs,
  resolveGotoScope,
}: {
  scene: Scene
  /**
   * The rendered mode, for resolving a goto target to a world rect.  Null
   * while there is no mode (loading, error) -- goto then silently no-ops.
   */
  output: ModeOutput | null
  /**
   * Element id -> vscode:// source link (tic-468e).  A node with one renders a
   * small file-symlink button that opens its source line in VS Code.
   */
  sourceLinks: ReadonlyMap<string, string>
  onActivate?: (id: string) => void
  /** Ids whose activation toggles expand/collapse; the `e` shortcut uses it. */
  expandable?: ReadonlySet<string>
  /**
   * The fs-tree `dir:<path>` ids whose folders contain only files (tic-2356):
   * the only directories Collapse All folds up, so the tree keeps its folder
   * skeleton instead of collapsing to the root.  Computed in App from the
   * derived tree; the empty set while there is no workspace.
   */
  fileOnlyDirs?: ReadonlySet<string>
  /**
   * The smallest focus path that puts a goto target in scope (tic-1d9a), or
   * null when the target is not in the workspace at all.  When a goto target
   * resolves to nothing in the current scene, the canvas uses this to pop the
   * focus out just far enough, then travels once the wider scene arrives.
   */
  resolveGotoScope?: (target: string) => string | null
}) {
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  // A real, positioned tooltip for the on-canvas icon buttons (tic-1d9a): the
  // old container-title approach did not reliably show a tooltip, so the
  // buttons report hover to this state and the host renders it near the cursor.
  const [iconTooltip, setIconTooltip] = useState<{
    text: string
    x: number
    y: number
  } | null>(null)

  // Whether Shift is held (tic-0961): while the near-pointer popup is up it
  // flips the nearest line's '>' prefix to '<', signalling that a
  // double-click would now fly to the line's source.  Tracked globally via
  // keydown/keyup because the modifier can change while the pointer is still,
  // with no pointermove to re-probe.
  const [shiftHeld, setShiftHeld] = useState(false)

  const overrides = useWorkspace(selectOverrides)
  const selection = useWorkspace((s) => s.selection)
  const hovered = useWorkspace((s) => s.hovered)
  // Exploratory marching-ants on every edge (tic-5196), persisted as a UI pref.
  const animateAllEdges = useWorkspace((s) => s.animateAllEdges)
  const focusPath = useWorkspace(selectFocusPath)

  const expanded = useWorkspace(selectExpanded)

  // The ids a Collapse All should fold (tic-2356): the fs-tree's `dir:<path>`
  // expand keys for folders whose children are all files, plus any expanded
  // file container (a bare-path id, i.e. an object expansion showing a file's
  // details).  `expandable` carries both kinds; only ids that are currently
  // open are targeted, so the button disables when nothing is left to fold.
  const collapseTargets = useMemo(() => {
    const targets: string[] = []
    for (const id of expandable ?? []) {
      if (id.startsWith('dir:')) {
        if ((fileOnlyDirs?.has(id) ?? false) && expanded[id] !== false) {
          targets.push(id)
        }
      } else if (expanded[id] === true) {
        targets.push(id)
      }
    }
    return targets
  }, [expandable, fileOnlyDirs, expanded])

  // The ids an Expand All should open (tic-2356): every fs-tree `dir:<path>`
  // folder key that is currently folded, so the folder hierarchy shows its
  // children -- but never a file container (bare path), so the subobject
  // detail rows stay hidden.
  const expandTargets = useMemo(
    () =>
      [...(expandable ?? [])].filter(
        (id) => id.startsWith('dir:') && expanded[id] === false,
      ),
    [expandable, expanded],
  )

  // Collapse All / Expand All reframe the camera once the new scene lands
  // (tic-2356): fit() reads the scene through a ref, so it must run after the
  // re-render, not inline in the click.  Each flag is set only when the
  // action will actually change something, so a no-op never leaves a stale
  // fit pending.
  const fitAfterCollapse = useRef(false)
  const fitAfterExpand = useRef(false)
  const onCollapseAll = useCallback(() => {
    if (collapseTargets.length > 0) fitAfterCollapse.current = true
    useWorkspace.getState().collapseAllFolders(collapseTargets)
  }, [collapseTargets])
  const onExpandAll = useCallback(() => {
    if (expandTargets.length > 0) fitAfterExpand.current = true
    useWorkspace.getState().expandAllFolders(expandTargets)
  }, [expandTargets])

  // Edges incident to the selection or hover light up (tic-5393): they keep
  // their own stroke colour but draw thicker, at full opacity, and (where
  // directional) marching (tic-b864).  Incidence runs off the scene's edge
  // anchors, which the mode has already shaped to the expand state: a
  // collapsed file's imports anchor to its chip, an expanded file's to the
  // contributing rows.  Hover and multi-selection union into one set, so every
  // touching edge is lit.
  const highlightIds = useMemo(() => {
    const ids = new Set<string>()
    if (hovered !== null) ids.add(hovered)
    for (const id of selection) ids.add(id)
    if (ids.size === 0) return NO_HIGHLIGHT
    return connectionEdgesIncidentTo(scene, ids)
  }, [scene, selection, hovered])

  // The nodes those lit lines land on borrow the hover border (tic-ece1), so a
  // connection reads as a whole -- line plus the things at both ends -- rather
  // than as a line that trails off into anonymous grey chips.  Derived from
  // `highlightIds` rather than from the hover/selection directly, so it follows
  // the same edge anchors and needs no second notion of "connected"; keyed on
  // the same two stable inputs, so a pan or zoom still pays nothing.
  const connectedIds = useMemo(() => {
    if (highlightIds.size === 0) return NO_HIGHLIGHT
    return endpointNodesOf(scene, highlightIds)
  }, [scene, highlightIds])

  // Pointer handlers run outside React's render, so they reach the live scene
  // and overrides through refs rather than through a stale closure.
  const sceneRef = useRef(scene)
  sceneRef.current = scene
  const overridesRef = useRef(overrides)
  overridesRef.current = overrides

  const konvaNodes = useRef(new Map<string, Konva.Group>())
  const drag = useRef<DragSession | null>(null)
  // Edge and group geometry is updated imperatively during a drag (tic-1d7c):
  // routing per-frame positions through the store would re-render the whole
  // scene on every pointer move, which the design deliberately avoids.
  const groupLayer = useRef<Konva.Layer>(null)
  const edgeLayer = useRef<Konva.Layer>(null)
  const edgeShapes = useRef(new Map<string, Konva.Line>())
  const groupShapes = useRef(new Map<string, GroupShapes>())
  /** Where the current press began, to tell a click from the start of a drag. */
  const press = useRef<{ id: string; x: number; y: number } | null>(null)
  /** The previous single click, to recognise the double-click that expands or
   *  contracts a workspace object (tic-3430). */
  const lastClick = useRef<{ id: string; time: number } | null>(null)
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate
  // Goto handlers run outside React's render, so they read the latest mode
  // output and stage size through refs rather than through a stale closure.
  const outputRef = useRef(output)
  outputRef.current = output
  const sizeRef = useRef(size)
  sizeRef.current = size

  useEffect(() => {
    const el = host.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ width: Math.floor(width), height: Math.floor(height) })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const getBounds = useCallback(() => sceneBounds(sceneRef.current, overridesRef.current), [])

  const onMarquee = useCallback((world: WorldRect) => {
    const hits = nodesInRect(sceneRef.current, world, overridesRef.current)
    useWorkspace.getState().select(hits, true)
  }, [])

  const onEmptyClick = useCallback(() => useWorkspace.getState().clearSelection(), [])

  // Double-clicking empty canvas flies the camera to the nearest line's target
  // (tic-1250); with Shift held it flies to the line's SOURCE instead
  // (tic-0961).  The same goto event the import-row button emits, so the
  // flight and its drag-override handling are reused.  An edge without a
  // resolvable endpoint for the chosen direction (or no line under the cursor
  // at all) no-ops.
  const onEmptyDoubleClick = useCallback((shift: boolean) => {
    const target = shift ? nearestSourceRef.current : nearestTargetRef.current
    if (target === null) return
    emitGoto(target)
  }, [])

  const { viewport, marquee, panning, fit, stageProps } = useViewport({
    container: host,
    size,
    getBounds,
    onMarquee,
    onEmptyClick,
    onEmptyDoubleClick,
  })

  // Camera goto (tic-bee0): any surface can emitGoto(target); the canvas owns
  // the resolution and the flight.  A short ease-out pan (GOTO_DURATION_MS, and
  // zoom to a comfortable minimum) keeps the user's bearings on a graph this
  // size, and the flight writes through the store so pan/zoom afterwards stay
  // coherent.
  // Drag overrides are honoured so a goto lands on where a node actually
  // sits, not a stale laid-out spot.  A target that is not in the current
  // scope (tic-1d9a) pops the focus out to the minimal scope containing it
  // and travels once the wider scene arrives.
  const flyRef = useRef<number | null>(null)
  /** A goto that had to widen the focus scope; flown when the new scene lands. */
  const pendingGotoRef = useRef<string | null>(null)
  const resolveGotoScopeRef = useRef(resolveGotoScope)
  resolveGotoScopeRef.current = resolveGotoScope

  const stopFlight = useCallback(() => {
    if (flyRef.current !== null) cancelAnimationFrame(flyRef.current)
    flyRef.current = null
  }, [])

  /** Resolve `target` against the current output and fly to it; false when the
   *  target is not reachable in the current scene. */
  const flyTo = useCallback((target: string): boolean => {
    const modeOutput = outputRef.current
    const { width, height } = sizeRef.current
    if (!modeOutput || width === 0 || height === 0) return false
    const resolved = resolveGoto(modeOutput, target)
    if (!resolved) return false // nothing reachable in this scene
    // Select the target so the inspector follows it.
    useWorkspace.getState().select([resolved.elementId])
    const overridden = selectOverrides(useWorkspace.getState())[resolved.elementId]
    const rect: WorldRect = overridden
      ? { x: overridden.x, y: overridden.y, width: resolved.rect.width, height: resolved.rect.height }
      : resolved.rect
    const from = selectViewport(useWorkspace.getState())
    const to = centerOn(from, rect, sizeRef.current, { zoom: true })
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / GOTO_DURATION_MS)
      const eased = 1 - Math.pow(1 - t, 3) // ease-out cubic
      useWorkspace.getState().setViewport({
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
        scale: from.scale + (to.scale - from.scale) * eased,
      })
      flyRef.current = t < 1 ? requestAnimationFrame(step) : null
    }
    flyRef.current = requestAnimationFrame(step)
    return true
  }, [])

  useEffect(() => {
    const unsubscribe = onGoto((target) => {
      stopFlight()
      if (flyTo(target)) return
      // Not in the current scene: pop the focus out to the minimal scope that
      // contains the target, then travel once the wider scene re-renders.  A
      // scope equal to the current one means the target exists but is filtered
      // out -- nothing to do.
      const scope = resolveGotoScopeRef.current?.(target)
      const current = selectFocusPath(useWorkspace.getState())
      if (!scope || scope === current) return
      pendingGotoRef.current = target
      useWorkspace.getState().setFocusPath(scope)
    })
    return () => {
      unsubscribe()
      stopFlight()
    }
  }, [flyTo, stopFlight])

  // Frame the scene the first time it arrives, unless a saved camera was
  // restored -- overriding that would defeat the point of persisting it.
  const framed = useRef(false)
  const restored = useWorkspace((s) => s.restored)
  useEffect(() => {
    if (framed.current || size.width === 0 || scene.nodes.length === 0) return
    framed.current = true
    if (!restored) fit()
  }, [scene, size, restored, fit])

  // Focus-scope navigation (tic-e7d2): entering a scope ('go into', '..' or
  // '/') re-frames the camera on the new subtree.  The store already cleared
  // drag overrides for the change, so the fit lands on the laid-out scene,
  // not stale drags from the wider view.  Skipped on mount (prev === current),
  // so a restored scoped view keeps its saved camera.
  const prevFocusPath = useRef(focusPath)
  const fitAfterFocus = useRef(false)
  useEffect(() => {
    if (prevFocusPath.current === focusPath) return
    prevFocusPath.current = focusPath
    // A goto that widened the scope flies straight to its target (tic-1d9a);
    // skip the fit so it does not fight the pending flight.
    if (pendingGotoRef.current !== null) return
    // Deferred rather than fitted here (tic-ea7b): a mode whose layout is
    // async has nothing laid out yet at this point -- the import graph's Local
    // View re-renders with an empty scene and only fills in when elk answers,
    // so fitting now would frame nothing and the arriving scene would never be
    // framed at all.  The effect below fits as soon as there is something to
    // fit, which for a synchronous mode is this same commit.
    fitAfterFocus.current = true
  }, [focusPath])

  // The deferred focus-scope fit: the first non-empty scene after entering or
  // leaving a scope gets framed.  Empty scenes are skipped rather than
  // consuming the flag, which is what lets it survive the placeholder render
  // an async layout goes through (tic-ea7b).
  useEffect(() => {
    if (!fitAfterFocus.current || scene.nodes.length === 0) return
    fitAfterFocus.current = false
    fit()
  }, [scene, fit])

  // Collapse All / Expand All (tic-2356) reshape the scene, then re-frame the
  // camera on the new layout.  fit() reads the scene through a ref, so it
  // cannot run inline in the click -- it runs here, once the new scene has
  // re-rendered.
  useEffect(() => {
    if (!fitAfterCollapse.current && !fitAfterExpand.current) return
    fitAfterCollapse.current = false
    fitAfterExpand.current = false
    fit()
  }, [scene, fit])

  // A goto that widened the focus scope flies once the new scene lands
  // (tic-1d9a): the scene is rebuilt with the broader focus, so the target is
  // now reachable.  Keyed on the mode output, which changes with the scope;
  // declared after the focus-scope fit so the fit's pending-goto guard above
  // has already run and skipped the reframe.
  useEffect(() => {
    const target = pendingGotoRef.current
    if (target === null) return
    pendingGotoRef.current = null
    stopFlight()
    flyTo(target)
  }, [output, flyTo, stopFlight])

  const register = useCallback((id: string, node: Konva.Group | null) => {
    if (node) konvaNodes.current.set(id, node)
    else konvaNodes.current.delete(id)
  }, [])

  const registerEdge = useCallback((id: string, line: Konva.Line | null) => {
    if (line) edgeShapes.current.set(id, line)
    else edgeShapes.current.delete(id)
  }, [])

  const registerGroup = useCallback((id: string, shapes: GroupShapes | null) => {
    if (shapes) groupShapes.current.set(id, shapes)
    else groupShapes.current.delete(id)
  }, [])

  // Marching ants (tic-2b2b): highlighted directional edges get a moving dash
  // to show which way the line flows.  EdgeLines register themselves while lit;
  // one Konva.Animation drives every registered line, started only while at
  // least one is active so the idle scene never pays for a running loop.  The
  // line is looked up by id each frame, so an edge re-created on a re-layout
  // (or drag re-route) is picked up automatically.  The map value says whether
  // that line marches in REVERSE (tic-b864): the nearest line under a held
  // Shift points back toward its source, because a shift+double-click flies
  // there.
  const antsIds = useRef(new Map<string, boolean>())
  const antsAnim = useRef<Konva.Animation | null>(null)

  const registerAnts = useCallback((id: string, active: boolean, reverse: boolean) => {
    if (active) {
      antsIds.current.set(id, reverse)
    } else {
      antsIds.current.delete(id)
      // Reset the offset when the line unlights, so a non-highlighted edge
      // never keeps a stale shift (a directional edge with its own base dash
      // would otherwise render offset from where the mode put it).
      edgeShapes.current.get(id)?.dashOffset(0)
    }
    if (antsIds.current.size === 0) {
      antsAnim.current?.stop()
      antsAnim.current = null
      return
    }
    if (antsAnim.current) return
    antsAnim.current = new Konva.Animation((frame) => {
      const offset = antsDashOffset(frame?.time ?? 0)
      for (const [antsId, reverse] of antsIds.current) {
        edgeShapes.current.get(antsId)?.dashOffset(reverse ? -offset : offset)
      }
      edgeLayer.current?.batchDraw()
    })
    antsAnim.current.start()
  }, [])

  /** Drill the scene into a directory path (tic-e7d2); see the store action. */
  const onGoIn = useCallback((target: string) => {
    useWorkspace.getState().setFocusPath(target)
  }, [])

  /** Switch mode and open it at a focus (tic-e738).  One store action rather
   *  than setMode + setFocusPath, so the intermediate "new mode, old focus"
   *  state never renders. */
  const onOpenIn = useCallback((modeId: string, target: string) => {
    useWorkspace.getState().openInMode(modeId, target)
  }, [])

  /** Fly the camera to a file/dir path (tic-bee0): the button just emits the
   *  goto event; the onGoto subscription above owns the resolution and the
   *  flight, so the import-row goto reuses the existing camera logic. */
  const onGotoButton = useCallback((target: string) => {
    emitGoto(target)
  }, [])

  // Icon-button tooltips (tic-1d9a): convert the pointer's client coordinates
  // to host-relative ones and surface the text as a real positioned tooltip,
  // replacing the host-title approach that did not reliably show.
  const handleIconTooltip = useCallback(
    (text: string | null, clientX: number, clientY: number) => {
      const el = host.current
      if (!el) return
      if (text === null) {
        setIconTooltip(null)
        return
      }
      const rect = el.getBoundingClientRect()
      setIconTooltip({ text, x: clientX - rect.left, y: clientY - rect.top })
    },
    [],
  )

  const handlers = useMemo<NodeHandlers>(() => {
    /** How far the anchor has travelled since the drag began. */
    const deltaOf = (e: KonvaEventObject<DragEvent>, session: DragSession): Point => {
      const from = session.start.get(session.anchor)
      const now = e.currentTarget.position()
      return from ? { x: now.x - from.x, y: now.y - from.y } : { x: 0, y: 0 }
    }

    return {
      onPointerDown(e) {
        if (e.evt.button !== 0) return
        const id = e.currentTarget.id()
        const store = useWorkspace.getState()
        // Press-to-select, so a drag starting on an unselected node picks it
        // up; pressing inside an existing multi-selection keeps it intact.
        if (e.evt.shiftKey) store.toggleSelected(id)
        else if (!store.selection.has(id)) store.select([id])
        press.current = { id, x: e.evt.clientX, y: e.evt.clientY }
      },

      onPointerUp(e) {
        const down = press.current
        press.current = null
        if (!down || down.id !== e.currentTarget.id()) return
        const dx = e.evt.clientX - down.x
        const dy = e.evt.clientY - down.y
        if (dx * dx + dy * dy > NODE_DRAG_THRESHOLD ** 2) return // dragged, not clicked
        // Expanding/contracting a workspace object is a double-click (tic-3430);
        // a single click only selects, which the pointer-down already did.
        const now = performance.now()
        const prev = lastClick.current
        lastClick.current = { id: down.id, time: now }
        if (prev && prev.id === down.id && now - prev.time <= DBLCLICK_MS) {
          lastClick.current = null
          onActivateRef.current?.(down.id)
        }
      },

      onDragStart(e) {
        const anchor = e.currentTarget.id()
        const { selection: selected } = useWorkspace.getState()
        const ids = selected.has(anchor) ? [...selected] : [anchor]
        const start = new Map<string, Point>()
        const byId = new Map(sceneRef.current.nodes.map((node) => [node.id, node]))
        // Ancestor-aware (tic-2697): a row inside a moved container is already
        // sitting on the container's delta, so that is where the drag starts.
        const placed = placedRects(sceneRef.current, overridesRef.current)
        for (const id of ids) {
          const node = byId.get(id)
          if (!node) continue
          const rect = placed.get(id) ?? node
          start.set(id, { x: rect.x, y: rect.y })
        }
        drag.current = { anchor, ids, start }
      },

      onDragMove(e) {
        const session = drag.current
        if (!session) return
        const delta = deltaOf(e, session)
        // The rest of the selection moves imperatively: routing it through the
        // store would re-render the whole scene on every pointer move.
        for (const id of session.ids) {
          if (id === session.anchor) continue
          const from = session.start.get(id)
          const node = konvaNodes.current.get(id)
          if (from && node) node.position({ x: from.x + delta.x, y: from.y + delta.y })
        }
        // Live reproject (tic-1d7c): re-route edges and regrow group boxes
        // from where the dragged nodes are right now -- multi-selection
        // included, since every travelling id is in `session.start` -- then
        // paint just the two affected layers.  The store stays untouched
        // until the drag commits.
        const live: Record<string, Point> = { ...overridesRef.current }
        for (const [id, from] of session.start) {
          live[id] = { x: from.x + delta.x, y: from.y + delta.y }
        }
        const projected = reproject(sceneRef.current, live)
        for (const edge of projected.edges) {
          const line = edgeShapes.current.get(edge.id)
          if (line) line.points(edge.points)
        }
        for (const group of projected.groups) {
          const shapes = groupShapes.current.get(group.id)
          if (shapes) applyGroupGeometry(shapes, group)
        }
        // A moved container's contents travel with it live (tic-2697): rows
        // and nested chips inherit their ancestor's delta, so an expanded
        // container drags as a unit instead of leaving its rows behind until
        // the drag commits.  The anchor moves under Konva and the rest of the
        // selection was moved above, so only unaffected chips are touched.
        const moving = new Set(session.ids)
        const livePlaced = placedRects(sceneRef.current, live)
        for (const node of sceneRef.current.nodes) {
          if (moving.has(node.id)) continue
          const chip = konvaNodes.current.get(node.id)
          if (!chip || chip.isDragging()) continue
          const at = livePlaced.get(node.id)
          if (!at || (chip.x() === at.x && chip.y() === at.y)) continue
          chip.position({ x: at.x, y: at.y })
        }
        groupLayer.current?.batchDraw()
        edgeLayer.current?.batchDraw()
      },

      onDragEnd(e) {
        const session = drag.current
        drag.current = null
        if (!session) return
        const delta = deltaOf(e, session)
        const moved: Record<string, Point> = {}
        for (const [id, from] of session.start) {
          moved[id] = { x: from.x + delta.x, y: from.y + delta.y }
        }
        useWorkspace.getState().moveNodes(moved)
      },

      onMouseEnter(e) {
        useWorkspace.getState().setHovered(e.currentTarget.id())
      },

      onMouseLeave() {
        useWorkspace.getState().setHovered(null)
      },
    }
  }, [])

  const world = { x: viewport.x, y: viewport.y, scaleX: viewport.scale, scaleY: viewport.scale }
  const cursor = panning ? 'grabbing' : hovered !== null ? 'pointer' : 'grab'

  // Re-route edges and regrow group boxes around committed drag overrides
  // (tic-1d7c) before culling, so a dropped drag updates lines and boxes.
  // Skipped while there are no overrides: the laid-out scene is already
  // correct, and pan/zoom then pays nothing beyond the cull itself.
  const projected = useMemo(
    () => (Object.keys(overrides).length > 0 ? reproject(scene, overrides) : scene),
    [scene, overrides],
  )
  // Where each node actually renders, ancestor offsets included (tic-2697): a
  // row inside a moved container sits on the container's delta even though the
  // row itself has no override.  Skipped while there are no overrides, so the
  // laid-out scene renders at its own coordinates.
  const placed = useMemo(
    () => (Object.keys(overrides).length > 0 ? placedRects(scene, overrides) : null),
    [scene, overrides],
  )
  // The single nearest connection line under the cursor on empty canvas
  // (tic-1250): the one line that reads as "the one under the pointer", drawn
  // in the nearest colour and the target of the empty-canvas double-click.
  // Null while the pointer is over a node or a gesture owns the canvas, so it
  // never competes with node hover/selection.  Declared before the edge
  // ordering below, which draws it on top of the bundle it is picked out of.
  const [nearestEdgeId, setNearestEdgeId] = useState<string | null>(null)
  // Highlighted edges draw above the grey neighbours (tic-5393): reorder so
  // the lit lines come last.  The nearest line under the cursor (tic-1250)
  // joins the set so it draws on top of the bundle it is being picked out of.
  // Memoised on `projected` + `highlightIds` + `nearestEdgeId`, all stable
  // across a pan, so pan/zoom pays only the cull below -- never a per-frame
  // re-sort, and never a scene rebuild.
  const orderedEdges = useMemo(() => {
    const ids =
      nearestEdgeId === null
        ? highlightIds
        : new Set<string>(highlightIds).add(nearestEdgeId)
    return highlightedEdgesLast(projected.edges, ids)
  }, [projected, highlightIds, nearestEdgeId])
  // Render-time culling (tic-fa56): filter the computed scene to what the
  // camera can see, plus a margin.  Selection, marquee and fit keep using the
  // full scene through the refs above.
  const visible = useMemo(
    () => cullScene({ ...projected, edges: orderedEdges }, visibleWorldRect(viewport, size)),
    [projected, orderedEdges, viewport, size],
  )
  // Text thinning on the same thresholds the modes read; both only change on
  // a threshold crossing, never per pan/zoom frame.
  const lod = lodOf(viewport.scale)

  // -- the near-pointer connection summary (tic-f1d7) -----------------------
  //
  // Hovering a bundle of lines over empty canvas says what those lines
  // connect.  It is a proximity query against the culled scene this render
  // already computed, NOT a hit test: the edge layer is listening={false} on
  // purpose (see the module docstring), and making a couple of thousand
  // polylines into hit targets to answer this would be the most expensive
  // thing on the canvas.
  //
  // The pointer moves far more often than the browser paints, so the query is
  // throttled to one requestAnimationFrame: the handler only records where the
  // pointer is, and at most one probe runs per frame with the latest position.
  const [edgePopup, setEdgePopup] = useState<EdgePopup | null>(null)
  // Connection lines only, which is what "a connection" means everywhere else
  // on this canvas -- selection highlighting and the marching ants key on the
  // same set (tic-5393, tic-ece1, tic-260c).  The fs-tree's nesting elbows are
  // structure rather than connection: a popup reading "app -> errors.py" over
  // one says nothing the picture is not already saying, and a folder's fan of
  // them would crowd out the lines the summary is for.  Filtered once per
  // scene rather than per probe, and it shrinks the scan too.
  const connections = useMemo(
    () => ({ ...visible, edges: visible.edges.filter(isConnection) }),
    [visible],
  )
  const connectionsRef = useRef(connections)
  connectionsRef.current = connections
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const probe = useRef<{ frame: number | null; at: Point | null }>({ frame: null, at: null })
  // The `to` element id of the nearest line under the cursor (tic-1250), kept
  // in a ref so the empty-canvas double-click handler can resolve it without
  // re-rendering.  Null while nothing is near, so a double-click over empty
  // canvas with no line under it no-ops.
  const nearestTargetRef = useRef<string | null>(null)
  // The `from` element id of the same line (tic-0961): what the shift+double-
  // click flies to.  Null while nothing is near, so a shift+double-click over
  // empty canvas with no line under it no-ops.
  const nearestSourceRef = useRef<string | null>(null)

  // The summary answers a question about EMPTY canvas, so it stays out of the
  // way of everything else the pointer can be doing: the user's explicit
  // condition is "not when a node is under the pointer", and a gesture in
  // flight (pan, marquee, node drag) owns the pointer outright.
  const suppressed = hovered !== null || panning || marquee !== null
  const suppressedRef = useRef(suppressed)
  suppressedRef.current = suppressed

  const probeEdges = useCallback((clientX: number, clientY: number) => {
    const el = host.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const at = { x: clientX - box.left, y: clientY - box.top }
    const vp = viewportRef.current
    // A screen-pixel radius converted by the camera scale, so the pick area is
    // the same size under the cursor at any zoom.
    const found = edgesNearPoint(
      connectionsRef.current,
      screenToWorld(vp, at),
      EDGE_HOVER_RADIUS_PX / vp.scale,
      EDGE_POPUP_MAX_LINES,
    )
    if (found.edges.length === 0) {
      setEdgePopup(null)
      setNearestEdgeId(null)
      nearestTargetRef.current = null
      nearestSourceRef.current = null
      return
    }
    // The nearest line is the first of the nearest-first result (tic-1250): the
    // one line that reads as "the one under the cursor" over a bundle, and the
    // target of the empty-canvas double-click.  Its `to` endpoint is where the
    // double-click flies, its `from` where the shift+double-click flies
    // (tic-0961); an edge without the chosen endpoint no-ops.
    const nearest = found.edges[0].edge
    setNearestEdgeId(nearest.id)
    nearestTargetRef.current = nearest.to ?? null
    nearestSourceRef.current = nearest.from ?? null
    // Named off the FULL scene, not the culled one: a line can cross the
    // viewport with both of its files scrolled off it, and the summary should
    // still be able to say what it connects.  Identical lines are collapsed --
    // in the fs-tree several symbol rows of one file can import the same file,
    // and repeating "a.py -> b.py" four times says nothing extra.
    const lines = [
      ...new Set(describeConnections(sceneRef.current, found.edges.map((near) => near.edge))),
    ]
    setEdgePopup({ x: at.x, y: at.y, lines, more: found.total - found.edges.length })
  }, [])

  const onStagePointerMove = useCallback(
    (e: KonvaEventObject<PointerEvent>) => {
      if (suppressedRef.current || drag.current !== null) {
        setEdgePopup(null)
        setNearestEdgeId(null)
        nearestTargetRef.current = null
        nearestSourceRef.current = null
        return
      }
      probe.current.at = { x: e.evt.clientX, y: e.evt.clientY }
      if (probe.current.frame !== null) return
      probe.current.frame = requestAnimationFrame(() => {
        probe.current.frame = null
        const at = probe.current.at
        // Re-checked inside the frame: a gesture can start between the move
        // and the paint, and a probe that lands after it would put a popup up
        // that nothing is going to take down.
        if (at && !suppressedRef.current && drag.current === null) probeEdges(at.x, at.y)
      })
    },
    [probeEdges],
  )

  useEffect(() => {
    const pending = probe.current
    return () => {
      if (pending.frame !== null) cancelAnimationFrame(pending.frame)
    }
  }, [])

  // The pointer leaving the workspace (or the canvas for the HUD floating over
  // it) takes down both the summary and the nearest-line highlight (tic-1250).
  const clearNearPointer = useCallback(() => {
    setEdgePopup(null)
    setNearestEdgeId(null)
    nearestTargetRef.current = null
    nearestSourceRef.current = null
  }, [])

  // Down the moment a node comes under the pointer or a gesture starts, rather
  // than waiting for the next pointer move -- a drag that begins on a line the
  // popup is describing would otherwise carry it along.  The nearest-line
  // highlight clears on the same gates, so it never competes with a node's own
  // hover border or rides along on a pan/marquee.
  useEffect(() => {
    if (suppressed) {
      setEdgePopup(null)
      setNearestEdgeId(null)
      nearestTargetRef.current = null
      nearestSourceRef.current = null
    }
  }, [suppressed])

  // A wheel zoom moves the world under a stationary pointer, so whatever the
  // summary is naming may no longer be under the cursor; it comes back on the
  // next pointer move, measured against the new camera.
  useEffect(() => {
    setEdgePopup(null)
    setNearestEdgeId(null)
    nearestTargetRef.current = null
    nearestSourceRef.current = null
  }, [viewport])

  // The Shift modifier, tracked so the popup's direction arrow can flip while
  // the pointer is still (tic-0961).  Reset when the window loses focus, so a
  // Shift released elsewhere never leaves the arrow pointing the wrong way.
  useEffect(() => {
    const apply = (held: boolean) => setShiftHeld(held)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') apply(true)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') apply(false)
    }
    const onBlur = () => apply(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Keyboard: f = fit to content, e = expand/collapse selection,
  // Esc = deselect, / = focus the file filter.  Ignored while typing.
  const expandableRef = useRef(expandable)
  expandableRef.current = expandable
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'f') {
        e.preventDefault()
        fit()
      } else if (e.key === 'Escape') {
        useWorkspace.getState().clearSelection()
      } else if (e.key === 'e') {
        const store = useWorkspace.getState()
        for (const id of store.selection) {
          if (expandableRef.current?.has(id)) store.toggleExpanded(id)
        }
      } else if (e.key === '/') {
        e.preventDefault()
        document.getElementById('file-search')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fit])

  // The world rect the breadcrumb toolbar floats above (tic-b1ab), and which
  // shape of toolbar it is (tic-d7d7).  The focused folder's group box when
  // it has one (it is auto-expanded on scope enter, and an empty folder
  // renders no box), falling back to its chip; those ids are the fs-tree
  // mode's `dir:<path>` scheme, matching the expand keys the store
  // auto-expands.  Failing both, the focus path may name an element directly
  // -- the import graph's Local View focuses a FILE, whose element id is its
  // own path -- and that scope gets the cut-down return-to-root toolbar,
  // because a file's ancestor directories are not scopes that mode can render.
  const focus = useMemo(() => {
    if (!output || focusPath === '') return null
    const dir =
      output.rects.get(`dir:${focusPath}:group`) ?? output.rects.get(`dir:${focusPath}`)
    if (dir) return { rect: dir, rootOnly: false, label: undefined }
    const own = output.rects.get(focusPath)
    if (!own) return null
    // The one crumb of a root-only scope is named by the focused element's own
    // chip label rather than by slicing the path (tic-7a5e).  Path-slicing
    // worked while such a path was a file -- its last '/' segment IS the
    // basename -- but call flow focuses a SYMBOL, and a dotted symbol id has
    // no slash to slice, so the crumb came out as the whole
    // `src.pkg.mod.Class.method`.  The chip already carries the short name the
    // mode chose to identify it by, and using it is both shorter and more
    // truthful: the toolbar names the thing the way the picture does.
    const label = scene.nodes.find((node) => node.id === focusPath)?.label
    return { rect: own, rootOnly: true, label }
  }, [output, focusPath, scene])

  // Where a cross-mode jump started (tic-53f7), named by the origin MODE
  // rather than by a scope -- "back to Files & symbols" is the gesture, and
  // it is a different one from '/'.  The registry is the only place a mode id
  // becomes a label, so the lookup happens here rather than in the store.
  const origin = useWorkspace((s) => s.origin)
  const returnTo = useMemo(
    () =>
      origin === null
        ? undefined
        : { label: modeById(origin.modeId).label, detail: origin.focusPath },
    [origin],
  )

  return (
    <div
      ref={host}
      className="workspace"
      style={{ cursor }}
      onPointerLeave={clearNearPointer}
    >
      {size.width > 0 && size.height > 0 && (
        <Stage
          width={size.width}
          height={size.height}
          {...stageProps}
          onPointerMove={onStagePointerMove}
          // The host's own pointerleave covers the pointer leaving the
          // workspace; this covers it leaving the CANVAS for the HUD floating
          // over it, which is still inside the host.
          onPointerLeave={clearNearPointer}
        >
          <Layer listening={false}>
            <Grid
              width={size.width}
              height={size.height}
              viewport={viewport}
              minor={THEME.gridMinor}
              major={THEME.gridMajor}
            />
          </Layer>

          <Layer ref={groupLayer} {...world} listening={false}>
            {visible.groups.map((group) => (
              <GroupBox key={group.id} group={group} register={registerGroup} />
            ))}
          </Layer>

          <Layer ref={edgeLayer} {...world} listening={false}>
            {visible.edges.map((edge) => (
              <EdgeLine
                key={edge.id}
                edge={edge}
                highlighted={highlightIds.has(edge.id)}
                nearest={nearestEdgeId === edge.id}
                // While Shift is held the nearest line marches backwards (tic-b864),
                // mirroring its popup '<' arrow: a shift+double-click flies to the
                // line's source.
                reverseAnts={nearestEdgeId === edge.id && shiftHeld}
                animateAll={animateAllEdges}
                register={registerEdge}
                registerAnts={registerAnts}
              />
            ))}
            {/* Junction dots (tic-531b): where elk's merged import trunks
                split.  They live in the edge layer because they belong to
                the lines, and that layer already has listening={false} --
                a junction is decoration and must never be a hit target or
                steal the empty-space drag that pans the camera.  Culled
                with everything else, and absent entirely unless the layout
                merged edges, so the unmerged scene renders none of them. */}
            {visible.junctions?.map((point) => (
              <Circle
                key={`junction:${point.x},${point.y}`}
                x={point.x}
                y={point.y}
                radius={JUNCTION_RADIUS}
                fill={THEME.edge}
                perfectDrawEnabled={false}
              />
            ))}
          </Layer>

          <Layer {...world}>
            {visible.nodes.map((node) => {
              const at = placed?.get(node.id)
              const x = at ? at.x : node.x
              const y = at ? at.y : node.y
              const selected = selection.has(node.id)
              const isHovered = hovered === node.id
              const connected = connectedIds.has(node.id)
              const showLabel = lod < 2
              const showGoIn = lod < 2
              // A node the mode cut as an annular sector (tic-70f9) is drawn
              // as a wedge by WedgeNode; everything else stays the rectangle
              // chip it has always been.
              return node.wedge ? (
                <WedgeNode
                  key={node.id}
                  node={node}
                  x={x}
                  y={y}
                  selected={selected}
                  hovered={isHovered}
                  connected={connected}
                  showLabel={showLabel}
                  showSublabel={lod === 0}
                  showGoIn={showGoIn}
                  focusPath={focusPath}
                  onTooltip={handleIconTooltip}
                  handlers={handlers}
                  register={register}
                  onGoIn={onGoIn}
                  onOpenIn={onOpenIn}
                />
              ) : (
                <NodeChip
                  key={node.id}
                  node={node}
                  x={x}
                  y={y}
                  selected={selected}
                  hovered={isHovered}
                  connected={connected}
                  showLabel={showLabel}
                  showSublabel={lod === 0}
                  showGoIn={showGoIn}
                  focusPath={focusPath}
                  sourceLinks={sourceLinks}
                  onTooltip={handleIconTooltip}
                  handlers={handlers}
                  register={register}
                  onGoIn={onGoIn}
                  onGoto={onGotoButton}
                  onOpenIn={onOpenIn}
                />
              )
            })}
          </Layer>

          <Layer listening={false}>
            {marquee && (
              <Rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.width}
                height={marquee.height}
                fill="rgba(137,180,250,0.10)"
                stroke={THEME.accent}
                strokeWidth={1}
                dash={[4, 4]}
                perfectDrawEnabled={false}
              />
            )}
          </Layer>
        </Stage>
      )}

      {/* On-workspace navigation (tic-b1ab): the '/' and '..' buttons moved out
          of the HUD into this toolbar, which floats above the focused folder
          and can jump straight to any ancestor level. */}
      {focus && (
        <BreadcrumbToolbar
          viewport={viewport}
          size={size}
          rect={focus.rect}
          focusPath={focusPath}
          rootOnly={focus.rootOnly}
          rootLabel={focus.label}
          origin={returnTo}
          onReturn={() => useWorkspace.getState().returnFromExcursion()}
          onNavigate={(path) => useWorkspace.getState().setFocusPath(path)}
        />
      )}

      {/* The near-pointer connection summary (tic-f1d7): what the lines under
          the cursor connect, while the cursor is over empty canvas.  It flips
          to the other side of the pointer near the right or bottom edge, which
          keeps it on screen without having to measure it first -- the vertical
          threshold is predicted from the line count (tic-260c), because at the
          raised cap the box is over twice the height the old fixed guess
          assumed and would have run off the bottom. */}
      {edgePopup && (
        // The `.shift` class flips the nearest line's leading '>' to '<'
        // (styles.css): the arrow reads which way the next double-click takes
        // the view -- destination by default, source while Shift is held
        // (tic-0961).
        <div
          className={`edge-popup${shiftHeld ? ' shift' : ''}`}
          style={{
            left: edgePopup.x,
            top: edgePopup.y,
            transform: `translate(${
              edgePopup.x > size.width - 300 ? 'calc(-100% - 14px)' : '14px'
            }, ${
              edgePopup.y > size.height - edgePopupHeight(edgePopup.lines.length, edgePopup.more)
                ? 'calc(-100% - 14px)'
                : '14px'
            })`,
          }}
        >
          {edgePopup.lines.map((line, index) => (
            // The first line is the nearest one under the cursor (tic-1250):
            // edgesNearPoint returns nearest-first and describeConnections
            // preserves that order, so bolding index 0 marks the line the
            // double-click will fly to.
            <div
              key={line}
              className={`edge-popup-line${index === 0 ? ' edge-popup-line-nearest' : ''}`}
            >
              {line}
            </div>
          ))}
          {edgePopup.more > 0 && (
            <div className="edge-popup-more">
              +{edgePopup.more} more
            </div>
          )}
        </div>
      )}

      {/* Icon-button tooltip (tic-1d9a): a real positioned tooltip near the
          pointer, above the canvas, replacing the unreliable host-title
          approach. */}
      {iconTooltip && (
        <div className="canvas-tooltip" style={{ left: iconTooltip.x, top: iconTooltip.y }}>
          {iconTooltip.text}
        </div>
      )}

      <div className="hud">
        <button type="button" onClick={fit} title="Frame everything">
          Fit
        </button>
        <button
          type="button"
          onClick={relayout}
          disabled={Object.keys(overrides).length === 0}
          title="Discard dragged positions"
        >
          Relayout
        </button>

        <span className="hud-sep" aria-hidden="true">
          |
        </span>
        <button
          type="button"
          onClick={onCollapseAll}
          disabled={collapseTargets.length === 0}
          title="Collapse file-only folders and expanded files"
        >
          Collapse All
        </button>
        <span className="hud-sep" aria-hidden="true">
          |
        </span>
        <button
          type="button"
          onClick={onExpandAll}
          disabled={expandTargets.length === 0}
          title="Expand all folders without opening files"
        >
          Expand All
        </button>

        <span className="hud-stat">{Math.round(viewport.scale * 100)}%</span>
        <span className="hud-stat">
          {scene.nodes.length.toLocaleString()} nodes · {scene.edges.length.toLocaleString()} edges
        </span>
        {selection.size > 0 && <span className="hud-stat">{selection.size} selected</span>}
        <label className="hud-toggle" title="Animate every edge (not only highlighted imports)">
          <input
            type="checkbox"
            checked={animateAllEdges}
            onChange={(event) => useWorkspace.getState().setAnimateAllEdges(event.target.checked)}
          />
          animate all
        </label>
      </div>
    </div>
  )
}

const GroupBox = memo(function GroupBox({
  group,
  register,
}: {
  group: SceneGroup
  register: (id: string, shapes: GroupShapes | null) => void
}) {
  // The Konva nodes are kept for imperative drag updates (tic-1d7c): during a
  // drag the box follows its members without a React re-render.
  const shapes = useRef<GroupShapes>({ group: null!, rect: null!, text: null! })
  useEffect(() => {
    register(group.id, shapes.current)
    return () => register(group.id, null)
  }, [group.id, register])
  return (
    <Group
      x={group.x}
      y={group.y}
      listening={false}
      ref={(instance) => {
        if (instance) shapes.current.group = instance
      }}
    >
      <Rect
        ref={(instance) => {
          if (instance) shapes.current.rect = instance
        }}
        width={group.width}
        height={group.height}
        cornerRadius={10}
        fill={group.fill}
        stroke={group.stroke}
        strokeWidth={1}
        perfectDrawEnabled={false}
        shadowForStrokeEnabled={false}
      />
      <Text
        ref={(instance) => {
          if (instance) shapes.current.text = instance
        }}
        x={14}
        y={9}
        width={Math.max(0, group.width - 28)}
        text={group.label}
        fontFamily={FONT}
        fontSize={11.5}
        fill={THEME.dir}
        listening={false}
        perfectDrawEnabled={false}
        ellipsis
        wrap="none"
      />
    </Group>
  )
})

const EdgeLine = memo(function EdgeLine({
  edge,
  highlighted,
  nearest,
  reverseAnts,
  animateAll,
  register,
  registerAnts,
}: {
  edge: SceneEdge
  /** Whether the edge is incident to the selection/hover (tic-5393). */
  highlighted: boolean
  /**
   * Whether this is the single nearest connection line under the cursor on
   * empty canvas (tic-1250): drawn on top and a touch thicker, so it reads as
   * "the one under the pointer" over a bundle.  Like any other lit line it
   * keeps the edge's own stroke colour.  Never true while a node is under the
   * pointer or a gesture owns the canvas.
   */
  nearest: boolean
  /**
   * Whether to march the nearest line's ants in REVERSE (tic-b864): while
   * Shift is held the popup arrow flips to '<' and a shift+double-click flies
   * to the line's SOURCE, so the flow indicator points back toward that end.
   * Only ever true for the single nearest line, and only while its ants run.
   */
  reverseAnts: boolean
  /** Exploratory: march ants on every edge, highlighted or not (tic-5196). */
  animateAll: boolean
  register: (id: string, line: Konva.Line | null) => void
  /** Opt the edge's line into/out of the marching-ants animation. */
  registerAnts: (id: string, active: boolean, reverse: boolean) => void
}) {
  const width = edge.strokeWidth ?? 1
  // The nearest line under the cursor (tic-1250) counts as highlighted for the
  // marching ants too: it reads as a lit connection, so a directional one
  // marches exactly as it would over a hovered or selected node.
  const ants = isAntsEdge(edge, highlighted || nearest, animateAll)
  // Keep the animation registry in step with the highlight state: opt the line
  // in while it is lit AND directional, out (and back to its base offset)
  // otherwise.  Runs on mount too, so a line that starts lit starts marching.
  useEffect(() => {
    registerAnts(edge.id, ants, reverseAnts)
    return () => registerAnts(edge.id, false, false)
  }, [registerAnts, edge.id, ants, reverseAnts])
  // A lit line -- highlighted for any reason, whether incident to a node's
  // hover/selection (tic-5393) or the nearest line under the cursor (tic-1250)
  // -- keeps the edge's OWN stroke colour (tic-b864): the mode already colours
  // lines semantically, so lighting reads as the same line made prominent
  // (thicker, full opacity, drawn on top, marching where directional), not as
  // a recoloured one.  The nearest line draws a touch thicker than a plain lit
  // line so it stays legible over a bundle without being mistaken for a
  // selected node.
  const lit = highlighted || nearest
  return (
    <Line
      ref={(instance) => register(edge.id, instance)}
      points={edge.points}
      stroke={edge.stroke}
      strokeWidth={lit ? width * 2 : width}
      dash={ants ? ANTS_DASH : edge.dash}
      opacity={lit ? 1 : edge.opacity ?? 1}
      listening={false}
      perfectDrawEnabled={false}
      shadowForStrokeEnabled={false}
    />
  )
})

interface ChipProps {
  node: SceneNode
  x: number
  y: number
  selected: boolean
  hovered: boolean
  /** At one end of a currently lit import line (tic-ece1).  A plain scalar,
   *  not a set or an object: NodeChip is memoised, so a boolean the parent
   *  already computed keeps the idle re-render free, while handing the chip a
   *  fresh object per frame would defeat the memo entirely. */
  connected: boolean
  /** Zoom LOD (tic-fa56): text thins out as the camera pulls back. */
  showLabel: boolean
  showSublabel: boolean
  /** Zoom LOD for the icon buttons (tic-e7d2 / tic-4d7c): dropped when labels
   *  go, since at that zoom a tiny icon is neither legible nor clickable. */
  showGoIn: boolean
  /** The active focus path: a folder never offers to go into itself
   *  (tic-4d7c). */
  focusPath: string
  /** Element id -> vscode:// source link (tic-468e); a node with one renders a
   *  file-symlink button that opens its source line in VS Code. */
  sourceLinks: ReadonlyMap<string, string>
  /** Reports icon-button hover tooltips in client coords (tic-1d9a). */
  onTooltip: (text: string | null, clientX: number, clientY: number) => void
  handlers: NodeHandlers
  register: (id: string, node: Konva.Group | null) => void
  onGoIn: (target: string) => void
  onGoto: (target: string) => void
  onOpenIn: (modeId: string, target: string) => void
}

const NodeChip = memo(function NodeChip({
  node,
  x,
  y,
  selected,
  hovered,
  connected,
  showLabel,
  showSublabel,
  showGoIn,
  focusPath,
  sourceLinks,
  onTooltip,
  handlers,
  register,
  onGoIn,
  onGoto,
  onOpenIn,
}: ChipProps) {
  // Border precedence (tic-ece1): selection is the loudest statement, then the
  // pointer, then "you are at the end of a lit line", and only then the mode's
  // own stroke -- which is where a cyclic file's pink (tic-56b2) lives, so it
  // shows whenever the node is neither hovered nor connected and comes back
  // the moment the hover clears.  `connected` paints the same grey as
  // `hovered` on purpose: a borrowed border should read as the hover reaching
  // across the line, not as a third state.  The branches stay separate anyway
  // so the precedence is legible if the two colours ever diverge.  The hovered
  // node is its own neighbour (it anchors the very edges it lit), but `hovered`
  // outranks `connected` here, so it never changes appearance because of that.
  const stroke = selected
    ? THEME.selected
    : hovered
      ? THEME.hovered
      : connected
        ? THEME.hovered
        : node.stroke
  const labelY = node.sublabel === undefined ? node.height / 2 - 7 : 8
  // Where this node's icon buttons sit and how much of its right edge they
  // cost the label (tic-4d7c / tic-468e / tic-ea7b); the rule itself is pure
  // and lives in ./iconButtonLogic.
  const hasSource = sourceLinks.has(node.id)
  // One action slot, three candidates; ./iconButtonLogic owns the precedence
  // so it is pure and tested rather than implied by JSX order (tic-e738).
  const action = actionAffordance(node, focusPath)
  const hasFocus = action === 'focus'
  const hasGoto = action === 'goto'
  const hasOpenIn = action === 'open-in'
  const slots = iconSlots(node.width, node.height, hasSource, action !== null)
  const sourceLink = sourceLinks.get(node.id)
  // File workspace items (tic-2996): hovering the file name shows the global
  // file location in a positioned tooltip.  A file item's element id is its
  // root-relative path, which is the tooltip's text.
  const isFile = node.role === 'file'

  // Position is owned imperatively, not through props: react-konva would
  // teleport the node on re-render, while a Konva tween glides it there
  // (~200ms) when a re-layout moves it -- expansion, collapse, relayout.
  // Drags are untouched: Konva moves the node, and by the time the drag end
  // writes the override the node is already at the new x/y, so no tween runs.
  const groupRef = useRef<Konva.Group | null>(null)
  const placed = useRef(false)
  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) return
    if (!placed.current) {
      placed.current = true
      group.position({ x, y })
      return
    }
    if (group.isDragging() || (group.x() === x && group.y() === y)) return
    const tween = new Konva.Tween({
      node: group,
      x,
      y,
      duration: TWEEN_DURATION,
      easing: Konva.Easings.EaseOut,
    })
    tween.play()
    return () => tween.destroy()
  }, [x, y])

  return (
    <Group
      id={node.id}
      draggable={node.draggable !== false}
      ref={(instance) => {
        groupRef.current = instance
        register(node.id, instance)
      }}
      onPointerDown={handlers.onPointerDown}
      onPointerUp={handlers.onPointerUp}
      onDragStart={handlers.onDragStart}
      onDragMove={handlers.onDragMove}
      onDragEnd={handlers.onDragEnd}
      onMouseEnter={handlers.onMouseEnter}
      onMouseLeave={handlers.onMouseLeave}
    >
      <Rect
        width={node.width}
        height={node.height}
        cornerRadius={6}
        fill={node.fill}
        stroke={stroke}
        strokeWidth={selected ? 2 : 1}
        perfectDrawEnabled={false}
        shadowForStrokeEnabled={false}
      />
      {node.accent !== undefined && (
        <Rect
          width={3}
          height={node.height}
          cornerRadius={[6, 0, 0, 6]}
          fill={node.accent}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
      {showLabel && (
        <Text
          x={12}
          y={labelY}
          width={Math.max(0, node.width - slots.labelInset)}
          text={node.label}
          fontFamily={FONT}
          fontSize={12}
          fill={THEME.text}
          // A file item's name is hoverable (tic-2996): hovering it surfaces
          // the global file location in the positioned canvas tooltip, the
          // same affordance the file tree's row title gives.  The label must
          // listen to receive the events; rows and other items stay inert so
          // they cost nothing to hit-test.
          listening={isFile}
          onMouseEnter={
            isFile
              ? (e) => onTooltip(node.id, e.evt.clientX, e.evt.clientY)
              : undefined
          }
          onMouseLeave={
            isFile
              ? (e) => onTooltip(null, e.evt.clientX, e.evt.clientY)
              : undefined
          }
          perfectDrawEnabled={false}
          ellipsis
          wrap="none"
        />
      )}
      {showSublabel && node.sublabel !== undefined && (
        <Text
          x={12}
          y={23}
          width={Math.max(0, node.width - 20)}
          text={node.sublabel}
          fontFamily={FONT}
          fontSize={10.5}
          fill={THEME.textFaint}
          listening={false}
          perfectDrawEnabled={false}
          ellipsis
          wrap="none"
        />
      )}
      {/* 'Go into' affordance (tic-e7d2): a folder never offers to go into
          itself -- the focused folder hides its button (tic-4d7c). */}
      {showGoIn && hasFocus && (
        <CanvasIconButton
          x={slots.action}
          y={slots.y}
          // The mode names the glyph and the wording (tic-d7d7); a mode that
          // names neither gets the fs-tree's folder-and-arrow and its
          // "Go into ..." tooltip, unchanged.
          paths={
            (node.focusIcon !== undefined ? FOCUS_ICON_PATHS[node.focusIcon] : undefined) ??
            GO_IN_ICON_PATHS
          }
          tooltip={node.focusLabel ?? `Go into ${node.focusTo === '' ? '/' : node.focusTo}`}
          onTooltip={onTooltip}
          onClick={() => onGoIn(node.focusTo!)}
        />
      )}
      {/* Cross-mode navigation (tic-e738): open this element in another mode,
          focused on it.  The mode names the destination, the glyph and the
          wording; the canvas owns the button and knows nothing about what any
          particular mode's focus means. */}
      {showGoIn && hasOpenIn && (
        <CanvasIconButton
          x={slots.action}
          y={slots.y}
          paths={
            (node.openIn!.icon !== undefined ? FOCUS_ICON_PATHS[node.openIn!.icon] : undefined) ??
            GO_IN_ICON_PATHS
          }
          tooltip={node.openIn!.label ?? `Open in ${node.openIn!.modeId}`}
          onTooltip={onTooltip}
          onClick={() => onOpenIn(node.openIn!.modeId, node.openIn!.target)}
        />
      )}
      {/* Goto-code affordance (tic-468e / tic-2996): opens the item's source
          line in VS Code, the same deep link the inspector shows.  It owns the
          outer slot on every item that has one (tic-ea7b), with the action
          button inboard of it. */}
      {showGoIn && sourceLink !== undefined && (
        <CanvasIconButton
          x={slots.source}
          y={slots.y}
          paths={FILE_SYMLINK_ICON_PATHS}
          tooltip="Open in VS Code"
          onTooltip={onTooltip}
          onClick={() => launchVscodeLink(sourceLink)}
        />
      )}
      {/* Camera-goto affordance on import rows (tic-4d7c): flies the camera to
          the imported file via the existing goto event. */}
      {showGoIn && hasGoto && (
        <CanvasIconButton
          x={slots.action}
          y={slots.y}
          paths={GOTO_ICON_PATHS}
          tooltip={`Go to ${node.gotoTo}`}
          onTooltip={onTooltip}
          onClick={() => onGoto(node.gotoTo!)}
        />
      )}
    </Group>
  )
})

interface WedgeProps {
  node: SceneNode
  x: number
  y: number
  selected: boolean
  hovered: boolean
  /** At one end of a currently lit import line (tic-ece1); see ChipProps. */
  connected: boolean
  /** Zoom LOD (tic-fa56): labels thin out as the camera pulls back. */
  showLabel: boolean
  /** Zoom LOD for the count sublabels (tic-bc09): a second line only at lod 0,
   *  and it doubles as the 'reveal' flag that relaxes the label-fit floors. */
  showSublabel: boolean
  /** Zoom LOD for the icon buttons; dropped when labels go. */
  showGoIn: boolean
  /** The active focus path: a folder never offers to go into itself
   *  (tic-4d7c). */
  focusPath: string
  /** Reports icon-button hover tooltips in client coords (tic-1d9a). */
  onTooltip: (text: string | null, clientX: number, clientY: number) => void
  handlers: NodeHandlers
  register: (id: string, node: Konva.Group | null) => void
  onGoIn: (target: string) => void
  onOpenIn: (modeId: string, target: string) => void
}

/**
 * The annular-sector node a mode draws in place of a rectangular chip
 * (tic-70f9) -- the sunburst's per-ring slices.
 *
 * The node's own rect is the sector's bounding box and the group sits at that
 * rect's corner exactly like a chip, so selection, hover, double-click and the
 * position tween behave identically; only the drawn shape differs, an `Arc`
 * cut from the wedge's annulus.  Konva's Arc draws from `rotation` (degrees,
 * clockwise on screen) sweeping `angle` further clockwise, which is precisely
 * the `start`/`end` convention the mode used to build the geometry (0 = +x,
 * increasing clockwise), so the shape is a direct mapping rather than a guess.
 *
 * Slices are pinned (not draggable): a sunburst is one rigid object, and
 * letting a slice drag away would tear the chart apart rather than rearrange
 * it.
 *
 * Since tic-bc09 a slice can name itself, as a chip does: it shows its label
 * (and, at lod 0, a count sublabel) when the wedge can host text, so the pie
 * chunks are readable instead of anonymous colour.  The hub -- the innermost
 * disk, which is the focused folder once the sunburst is scoped -- is always
 * roomy enough for a centred name, which is what tells you where a zoomed-in
 * view is sitting without reading the toolbar.  A directory slice keeps the
 * same 'go into' affordance a folder chip has, and a file wedge now offers the
 * Local View open-in (tic-e738); the icon rides the wedge's outer arc while
 * the name and count own the radial middle, so the two never collide.
 */
const WedgeNode = memo(function WedgeNode({
  node,
  x,
  y,
  selected,
  hovered,
  connected,
  showLabel,
  showSublabel,
  showGoIn,
  focusPath,
  onTooltip,
  handlers,
  register,
  onGoIn,
  onOpenIn,
}: WedgeProps) {
  // Border precedence is the same as a chip's (tic-ece1): selection, then the
  // pointer, then "at the end of a lit line", then the mode's own stroke.
  const stroke = selected
    ? THEME.selected
    : hovered
      ? THEME.hovered
      : connected
        ? THEME.hovered
        : node.stroke

  const groupRef = useRef<Konva.Group | null>(null)
  const placed = useRef(false)
  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) return
    if (!placed.current) {
      placed.current = true
      group.position({ x, y })
      return
    }
    if (group.isDragging() || (group.x() === x && group.y() === y)) return
    const tween = new Konva.Tween({
      node: group,
      x,
      y,
      duration: TWEEN_DURATION,
      easing: Konva.Easings.EaseOut,
    })
    tween.play()
    return () => tween.destroy()
  }, [x, y])

  const wedge = node.wedge!
  // The wedge geometry is world-space and the group sits at the sector's
  // bounding-box corner, so every child shape is drawn in the group's local
  // space, offset by that corner.
  const lcx = wedge.cx - x
  const lcy = wedge.cy - y
  const span = wedge.end - wedge.start
  const midAngle = (wedge.start + wedge.end) / 2
  const midRadius = (wedge.innerRadius + wedge.outerRadius) / 2

  // What the wedge can host is decided purely (wedgeLabel.ts, tic-bc09): a
  // name when the span/chord/thickness clear the floors, a count line beneath
  // it when there is room for a second line, and an affordance icon once the
  // slice is a decent angular chunk.  At lod 0 (showSublabel) the label floors
  // relax, so the small outer file slices of a real codebase reveal their
  // names when the camera is in close enough to read them.  The hub -- the
  // innermost disk, the focused folder once scoped -- always fits its centred
  // name.
  const fit = wedgeLabelFit(wedge, showSublabel)
  const labelWidth = wedgeLabelWidth(wedge)
  // The name and its count line are centred on the slice's midpoint; for the
  // full-disk hub the midpoint of the annulus is a point on a ring, not the
  // centre, so its label anchors on the disk's centre instead -- that is where
  // a zoomed-in view's folder name reads.
  const labelX = fit.hub ? lcx : lcx + Math.cos(midAngle) * midRadius
  const labelY = fit.hub ? lcy : lcy + Math.sin(midAngle) * midRadius

  // The one action affordance a wedge can wear: a directory's 'go into'
  // (tic-e7d2, hidden on the focused folder per tic-4d7c) or a file's Local
  // View open-in (tic-e738).  A wedge can host text AND an affordance without
  // colliding by giving each its own radial band -- the name (+ count) reads at
  // the ring's middle, the icon sits just inside the outer arc, exactly as a
  // chip puts its buttons at the edge.  When the wedge is too small to be named
  // the icon falls back to the middle.
  const goIn = node.focusTo !== undefined && node.focusTo !== focusPath
  const openIn = node.openIn !== undefined
  const hasAffordance = goIn || openIn
  const showAffordance = showGoIn && hasAffordance && fit.button && !fit.hub
  // The label (and, at lod 0, its count sublabel) owns the radial middle.
  const labelOn = showLabel && fit.label && node.label !== ''
  const subOn = showSublabel && fit.sublabel && labelOn && node.sublabel !== undefined

  // Where the content sits.  The hub is a full disk, so its midpoint is the
  // disk's centre and the text block reads there; the label width for a ring
  // slice is its chord (ellipsised past 220), for the hub a hair under the
  // disk's diameter.  The affordance rides the outer arc when a label shares
  // the slice, so the two live in different radial bands.
  const nameX = labelX - labelWidth / 2
  const nameTop = labelY - (subOn ? 12 : 6)
  const subTop = labelY + (subOn ? 2 : 6)
  const affordanceRadius = labelOn ? wedge.outerRadius - 20 : midRadius
  const affordanceX = lcx + Math.cos(midAngle) * affordanceRadius - 9
  const affordanceY = lcy + Math.sin(midAngle) * affordanceRadius - 9
  const isGoIn = goIn && showAffordance
  const affordancePaths = isGoIn
    ? GO_IN_ICON_PATHS
    : (node.openIn?.icon !== undefined ? FOCUS_ICON_PATHS[node.openIn!.icon] : undefined) ??
      LOCAL_VIEW_ICON_PATHS
  const affordanceTooltip = isGoIn
    ? node.focusLabel ?? `Go into ${node.focusTo === '' ? '/' : node.focusTo}`
    : node.openIn?.label ?? `Open in ${node.openIn?.modeId ?? ''}`

  return (
    <Group
      id={node.id}
      draggable={false}
      ref={(instance) => {
        groupRef.current = instance
        register(node.id, instance)
      }}
      onPointerDown={handlers.onPointerDown}
      onPointerUp={handlers.onPointerUp}
      onDragStart={handlers.onDragStart}
      onDragMove={handlers.onDragMove}
      onDragEnd={handlers.onDragEnd}
      onMouseEnter={handlers.onMouseEnter}
      onMouseLeave={handlers.onMouseLeave}
    >
      <Arc
        x={lcx}
        y={lcy}
        innerRadius={wedge.innerRadius}
        outerRadius={wedge.outerRadius}
        rotation={(wedge.start * 180) / Math.PI}
        angle={(span * 180) / Math.PI}
        fill={node.fill}
        stroke={stroke}
        strokeWidth={selected ? 2 : 1}
        perfectDrawEnabled={false}
        shadowForStrokeEnabled={false}
      />
      {labelOn && (
        <Text
          x={nameX}
          y={nameTop}
          width={labelWidth}
          text={node.label}
          align="center"
          fontFamily={FONT}
          fontSize={11}
          fill={THEME.text}
          listening={false}
          perfectDrawEnabled={false}
          ellipsis
          wrap="none"
        />
      )}
      {subOn && (
        <Text
          x={nameX}
          y={subTop}
          width={labelWidth}
          text={node.sublabel}
          align="center"
          fontFamily={FONT}
          fontSize={10.5}
          fill={THEME.textFaint}
          listening={false}
          perfectDrawEnabled={false}
          ellipsis
          wrap="none"
        />
      )}
      {showAffordance && (
        <CanvasIconButton
          x={affordanceX}
          y={affordanceY}
          paths={affordancePaths}
          tooltip={affordanceTooltip}
          onTooltip={onTooltip}
          onClick={
            isGoIn
              ? () => onGoIn(node.focusTo!)
              : () => onOpenIn(node.openIn!.modeId, node.openIn!.target)
          }
        />
      )}
    </Group>
  )
})
