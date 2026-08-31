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
import { Group, Layer, Line, Rect, Stage, Text } from 'react-konva'
import { relayout, selectOverrides, useWorkspace } from '../state/store'
import { Grid } from './Grid'
import { lodOf } from './lod'
import {
  cullScene,
  nodesInRect,
  placedRect,
  sceneBounds,
  visibleWorldRect,
  type Scene,
  type SceneEdge,
  type SceneGroup,
  type SceneNode,
} from './scene'
import { THEME } from './theme'
import { useViewport } from './useViewport'
import type { Point, Rect as WorldRect } from './viewport'

const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif'

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

export function Workspace({
  scene,
  onActivate,
  expandable,
}: {
  scene: Scene
  onActivate?: (id: string) => void
  /** Ids whose activation toggles expand/collapse; the `e` shortcut uses it. */
  expandable?: ReadonlySet<string>
}) {
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  const overrides = useWorkspace(selectOverrides)
  const selection = useWorkspace((s) => s.selection)
  const hovered = useWorkspace((s) => s.hovered)

  // Pointer handlers run outside React's render, so they reach the live scene
  // and overrides through refs rather than through a stale closure.
  const sceneRef = useRef(scene)
  sceneRef.current = scene
  const overridesRef = useRef(overrides)
  overridesRef.current = overrides

  const konvaNodes = useRef(new Map<string, Konva.Group>())
  const drag = useRef<DragSession | null>(null)
  /** Where the current press began, to tell a click from the start of a drag. */
  const press = useRef<{ id: string; x: number; y: number } | null>(null)
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate

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

  const { viewport, marquee, panning, fit, stageProps } = useViewport({
    container: host,
    size,
    getBounds,
    onMarquee,
    onEmptyClick,
  })

  // Frame the scene the first time it arrives, unless a saved camera was
  // restored -- overriding that would defeat the point of persisting it.
  const framed = useRef(false)
  const restored = useWorkspace((s) => s.restored)
  useEffect(() => {
    if (framed.current || size.width === 0 || scene.nodes.length === 0) return
    framed.current = true
    if (!restored) fit()
  }, [scene, size, restored, fit])

  const register = useCallback((id: string, node: Konva.Group | null) => {
    if (node) konvaNodes.current.set(id, node)
    else konvaNodes.current.delete(id)
  }, [])

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
        if (dx * dx + dy * dy > 25) return // dragged, not clicked
        onActivateRef.current?.(down.id)
      },

      onDragStart(e) {
        const anchor = e.currentTarget.id()
        const { selection: selected } = useWorkspace.getState()
        const ids = selected.has(anchor) ? [...selected] : [anchor]
        const start = new Map<string, Point>()
        const byId = new Map(sceneRef.current.nodes.map((node) => [node.id, node]))
        for (const id of ids) {
          const node = byId.get(id)
          if (!node) continue
          const rect = placedRect(node, overridesRef.current[id])
          start.set(id, { x: rect.x, y: rect.y })
        }
        drag.current = { anchor, ids, start }
      },

      onDragMove(e) {
        const session = drag.current
        if (!session || session.ids.length < 2) return
        const delta = deltaOf(e, session)
        // The rest of the selection moves imperatively: routing it through the
        // store would re-render the whole scene on every pointer move.
        for (const id of session.ids) {
          if (id === session.anchor) continue
          const from = session.start.get(id)
          const node = konvaNodes.current.get(id)
          if (from && node) node.position({ x: from.x + delta.x, y: from.y + delta.y })
        }
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

  // Render-time culling (tic-fa56): filter the computed scene to what the
  // camera can see, plus a margin.  Selection, marquee and fit keep using the
  // full scene through the refs above.
  const visible = useMemo(
    () => cullScene(scene, visibleWorldRect(viewport, size)),
    [scene, viewport, size],
  )
  // Text thinning on the same thresholds the modes read; both only change on
  // a threshold crossing, never per pan/zoom frame.
  const lod = lodOf(viewport.scale)

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

  return (
    <div ref={host} className="workspace" style={{ cursor }}>
      {size.width > 0 && size.height > 0 && (
        <Stage width={size.width} height={size.height} {...stageProps}>
          <Layer listening={false}>
            <Grid
              width={size.width}
              height={size.height}
              viewport={viewport}
              minor={THEME.gridMinor}
              major={THEME.gridMajor}
            />
          </Layer>

          <Layer {...world} listening={false}>
            {visible.groups.map((group) => (
              <GroupBox key={group.id} group={group} />
            ))}
          </Layer>

          <Layer {...world} listening={false}>
            {visible.edges.map((edge) => (
              <EdgeLine key={edge.id} edge={edge} />
            ))}
          </Layer>

          <Layer {...world}>
            {visible.nodes.map((node) => {
              const at = overrides[node.id]
              return (
                <NodeChip
                  key={node.id}
                  node={node}
                  x={at ? at.x : node.x}
                  y={at ? at.y : node.y}
                  selected={selection.has(node.id)}
                  hovered={hovered === node.id}
                  showLabel={lod < 2}
                  showSublabel={lod === 0}
                  handlers={handlers}
                  register={register}
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
        <span className="hud-stat">{Math.round(viewport.scale * 100)}%</span>
        <span className="hud-stat">
          {scene.nodes.length.toLocaleString()} nodes · {scene.edges.length.toLocaleString()} edges
        </span>
        {selection.size > 0 && <span className="hud-stat">{selection.size} selected</span>}
      </div>
    </div>
  )
}

const GroupBox = memo(function GroupBox({ group }: { group: SceneGroup }) {
  return (
    <Group x={group.x} y={group.y} listening={false}>
      <Rect
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

const EdgeLine = memo(function EdgeLine({ edge }: { edge: SceneEdge }) {
  return (
    <Line
      points={edge.points}
      stroke={edge.stroke}
      strokeWidth={edge.strokeWidth ?? 1}
      dash={edge.dash}
      opacity={edge.opacity ?? 1}
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
  /** Zoom LOD (tic-fa56): text thins out as the camera pulls back. */
  showLabel: boolean
  showSublabel: boolean
  handlers: NodeHandlers
  register: (id: string, node: Konva.Group | null) => void
}

const NodeChip = memo(function NodeChip({
  node,
  x,
  y,
  selected,
  hovered,
  showLabel,
  showSublabel,
  handlers,
  register,
}: ChipProps) {
  const stroke = selected ? THEME.selected : hovered ? THEME.hovered : node.stroke
  const labelY = node.sublabel === undefined ? node.height / 2 - 7 : 8

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
    const tween = new Konva.Tween({ node: group, x, y, duration: 0.2, easing: Konva.Easings.EaseOut })
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
          width={Math.max(0, node.width - 20)}
          text={node.label}
          fontFamily={FONT}
          fontSize={12}
          fill={THEME.text}
          listening={false}
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
    </Group>
  )
})
