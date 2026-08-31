/**
 * The shared on-canvas icon button (tic-4d7c), the replacement for the ad-hoc
 * GoInChip.
 *
 * A small hit target with an SVG glyph, used for the 'go into' affordance on
 * directory chips and the 'goto' affordance on import rows.  It owns its hover
 * state -- a button lights only while the pointer is over its own target,
 * never because the chip it sits on is hovered (the old GoInChip was handed
 * the chip's hover flag, so hovering anywhere on a folder lit the icon) -- its
 * own click/drag discrimination, an optional tooltip set on the stage
 * container's title, and a glyph drawn from shared SVG path data as a Konva
 * Path.
 *
 * The pointer handlers stop the events from reaching the chip that hosts it:
 * `cancelBubble` keeps selection/activation off the parent group, and
 * `preventDefault` on pointerdown suppresses the browser's compat mouse
 * events, which are what a draggable parent listens on to start a drag.  So a
 * click on the button never selects its chip, and a press that becomes a drag
 * never moves the chip -- the chip's own drag stays intact.
 */
import { memo, useEffect, useRef, useState, type RefObject } from 'react'
import type { KonvaEventObject } from 'konva/lib/Node'
import { Group, Path, Rect } from 'react-konva'
import { iconGlyphGeometry, isIconClick } from './iconButtonLogic'
import { THEME } from './theme'

interface CanvasIconButtonProps {
  x: number
  y: number
  /** SVG path `d` strings of the glyph, in a 16x16 viewBox (e.g.
   *  GO_IN_ICON_PATHS / GOTO_ICON_PATHS). */
  paths: readonly string[]
  /** The element whose `title` doubles as the tooltip, if a tooltip is set. */
  container?: RefObject<HTMLDivElement | null>
  /** Tooltip text, shown while the pointer is over the button. */
  tooltip?: string
  /** Glyph colour when idle; default THEME.textDim. */
  color?: string
  /** Glyph colour while hovered; default THEME.accent. */
  hoverColor?: string
  /** Hit-target size in world units; default 18. */
  size?: number
  /** Called when the button is clicked (press + release without a drag). */
  onClick: () => void
}

export const CanvasIconButton = memo(function CanvasIconButton({
  x,
  y,
  paths,
  container,
  tooltip,
  color = THEME.textDim,
  hoverColor = THEME.accent,
  size = 18,
  onClick,
}: CanvasIconButtonProps) {
  // Own hover state: the button lights only while the pointer is over its own
  // hit target, never because the chip it sits on is hovered (tic-4d7c).
  const [hovered, setHovered] = useState(false)
  const press = useRef<{ x: number; y: number } | null>(null)

  const showTooltip = (text: string | undefined) => {
    if (container?.current) container.current.title = text ?? ''
  }

  // If the button unmounts while hovered, don't leave a stale tooltip behind.
  useEffect(() => {
    return () => showTooltip(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const glyph = iconGlyphGeometry(size)
  const tint = hovered ? hoverColor : color

  return (
    <Group
      x={x}
      y={y}
      onMouseEnter={() => {
        setHovered(true)
        showTooltip(tooltip)
      }}
      onMouseLeave={() => {
        setHovered(false)
        showTooltip(undefined)
      }}
      onPointerDown={(e: KonvaEventObject<PointerEvent>) => {
        e.cancelBubble = true
        e.evt.preventDefault()
        press.current = { x: e.evt.clientX, y: e.evt.clientY }
      }}
      onPointerUp={(e: KonvaEventObject<PointerEvent>) => {
        e.cancelBubble = true
        const down = press.current
        press.current = null
        if (!down) return
        if (isIconClick(down, { x: e.evt.clientX, y: e.evt.clientY })) onClick()
      }}
    >
      <Rect
        width={size}
        height={size}
        cornerRadius={4}
        fill={hovered ? THEME.surface2 : 'rgba(0,0,0,0)'}
        stroke={hovered ? THEME.accent : 'rgba(0,0,0,0)'}
        strokeWidth={1}
        perfectDrawEnabled={false}
        shadowForStrokeEnabled={false}
      />
      {paths.map((d, i) => (
        <Path
          key={i}
          data={d}
          x={glyph.x}
          y={glyph.y}
          scaleX={glyph.scale}
          scaleY={glyph.scale}
          fill="rgba(0,0,0,0)"
          stroke={tint}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          // The rect is the single hit target; the glyph never swallows a hit.
          listening={false}
          perfectDrawEnabled={false}
          shadowForStrokeEnabled={false}
        />
      ))}
    </Group>
  )
})
