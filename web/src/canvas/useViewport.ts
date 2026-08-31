/**
 * Camera and empty-space gestures.
 *
 *   wheel                 zoom about the cursor
 *   drag on empty space   pan
 *   shift + drag          marquee, adding what it touches to the selection
 *   middle-button drag    pan, whatever is underneath
 *   click on empty space  clear the selection
 *
 * Pan is the unmodified drag because the workspace is a map first and a
 * selection surface second; shift starts the marquee for the same reason it is
 * the additive click.
 *
 * The move/up listeners go on `window`, not the stage, so a drag that leaves
 * the canvas still tracks and still ends.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { KonvaEventObject } from 'konva/lib/Node'
import { DRAG_THRESHOLD } from '../settings'
import { selectViewport, useWorkspace } from '../state/store'
import {
  rectFromCorners,
  screenToWorld,
  wheelZoomFactor,
  type Point,
  type Rect,
  type Size,
} from './viewport'

type Gesture =
  | { kind: 'pan'; last: Point; moved: boolean }
  | { kind: 'marquee'; origin: Point; current: Point; moved: boolean }

interface Options {
  /** The element the Stage fills, for page -> stage coordinate maths. */
  container: RefObject<HTMLDivElement | null>
  size: Size
  /** World bounds of everything drawn, for fit-to-content. */
  getBounds: () => Rect | null
  /** The world rect a marquee covered. */
  onMarquee: (world: Rect) => void
  onEmptyClick: () => void
}

export function useViewport({ container, size, getBounds, onMarquee, onEmptyClick }: Options) {
  const viewport = useWorkspace(selectViewport)
  const gesture = useRef<Gesture | null>(null)
  /** Screen-space marquee, in state only because the overlay draws it. */
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [panning, setPanning] = useState(false)

  const onWheel = useCallback((e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const pointer = e.target.getStage()?.getPointerPosition()
    if (!pointer) return
    useWorkspace.getState().zoomAtPointer(pointer, wheelZoomFactor(e.evt.deltaY))
  }, [])

  const onPointerDown = useCallback((e: KonvaEventObject<PointerEvent>) => {
    const stage = e.target.getStage()
    if (!stage) return
    const middle = e.evt.button === 1
    // Anything but empty space belongs to the node layer, unless the user
    // asked for the middle-button pan.
    if (!middle && (e.target !== stage || e.evt.button !== 0)) return

    const pointer = stage.getPointerPosition()
    if (!pointer) return
    e.evt.preventDefault()

    if (e.evt.shiftKey && !middle) {
      gesture.current = { kind: 'marquee', origin: pointer, current: pointer, moved: false }
      setMarquee({ ...pointer, width: 0, height: 0 })
    } else {
      gesture.current = { kind: 'pan', last: pointer, moved: false }
      setPanning(true)
    }
  }, [])

  // One window-level subscription for the life of the component; the ref says
  // whether a gesture is in flight, which keeps these handlers stable.
  useEffect(() => {
    const toStage = (e: PointerEvent): Point | null => {
      const box = container.current?.getBoundingClientRect()
      return box ? { x: e.clientX - box.left, y: e.clientY - box.top } : null
    }

    const move = (e: PointerEvent) => {
      const active = gesture.current
      if (!active) return
      const pointer = toStage(e)
      if (!pointer) return

      if (active.kind === 'pan') {
        const dx = pointer.x - active.last.x
        const dy = pointer.y - active.last.y
        if (!active.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        active.moved = true
        active.last = pointer
        useWorkspace.getState().panBy(dx, dy)
      } else {
        active.moved = true
        active.current = pointer
        setMarquee(rectFromCorners(active.origin, pointer))
      }
    }

    const end = () => {
      const active = gesture.current
      gesture.current = null
      setPanning(false)
      if (!active) return

      if (active.kind === 'pan') {
        if (!active.moved) onEmptyClick()
        return
      }
      setMarquee(null)
      const band = rectFromCorners(active.origin, active.current)
      if (active.moved && band.width + band.height > DRAG_THRESHOLD) {
        const vp = selectViewport(useWorkspace.getState())
        onMarquee(
          rectFromCorners(
            screenToWorld(vp, { x: band.x, y: band.y }),
            screenToWorld(vp, { x: band.x + band.width, y: band.y + band.height }),
          ),
        )
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [container, onMarquee, onEmptyClick])

  const fit = useCallback(() => {
    const bounds = getBounds()
    if (!bounds || size.width === 0 || size.height === 0) return
    useWorkspace.getState().fitTo(bounds, size)
  }, [getBounds, size])

  return { viewport, marquee, panning, fit, stageProps: { onWheel, onPointerDown } }
}
