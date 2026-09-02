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
import { DBLCLICK_MS, DRAG_THRESHOLD } from '../settings'
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

/**
 * Whether an empty-canvas click is the second of a double-click (tic-1250).
 *
 * Pure so the gesture logic is unit-testable without a canvas: given the
 * previous empty-canvas click time and the current one, it says whether the
 * pair counts as a double-click (which flies the camera to the nearest line's
 * target) or as two ordinary deselects.
 */
export function isEmptyDoubleClick(prev: number | null, now: number): boolean {
  return prev !== null && now - prev <= DBLCLICK_MS
}

interface Options {
  /** The element the Stage fills, for page -> stage coordinate maths. */
  container: RefObject<HTMLDivElement | null>
  size: Size
  /** World bounds of everything drawn, for fit-to-content. */
  getBounds: () => Rect | null
  /** The world rect a marquee covered. */
  onMarquee: (world: Rect) => void
  onEmptyClick: () => void
  /**
   * Two empty-canvas clicks inside {@link DBLCLICK_MS} (tic-1250): the
   * workspace flies the camera to the nearest line's target.  The empty-canvas
   * click that clears the selection fires first; this is the second click of a
   * pair, so the caller can tell a double-click apart from two ordinary
   * deselects.
   */
  onEmptyDoubleClick: () => void
}

export function useViewport({
  container,
  size,
  getBounds,
  onMarquee,
  onEmptyClick,
  onEmptyDoubleClick,
}: Options) {
  const viewport = useWorkspace(selectViewport)
  const gesture = useRef<Gesture | null>(null)
  /** Screen-space marquee, in state only because the overlay draws it. */
  const [marquee, setMarquee] = useState<Rect | null>(null)
  // "Panning" means a pan is ACTUALLY moving the camera, not that a button is
  // simply down on empty space (tic-1250).  Setting it on the press would hide
  // the nearest-line highlight before the release of the first click of a
  // double-click, so the second click would have no target left to fly to.  It
  // flips true only once the pointer crosses the drag threshold and the pan
  // really starts -- the moment the highlight should clear anyway.
  const [panning, setPanning] = useState(false)
  /** The previous empty-canvas click, to recognise the double-click that flies
   *  the camera to the nearest line's target (tic-1250). */
  const lastEmptyClick = useRef<{ time: number } | null>(null)

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
      // A press alone is not yet a pan: it may be the first click of the
      // empty-canvas double-click (tic-1250), whose nearest-line highlight and
      // target must survive until the release.  `panning` (which suppresses
      // that highlight) flips when the drag actually starts, in `move`.
      gesture.current = { kind: 'pan', last: pointer, moved: false }
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
        // The pan is real now -- the camera moves with the next `panBy` -- so
        // the nearest-line highlight (which never rides along on a drag) is
        // suppressed from here on (tic-1250).
        setPanning(true)
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
        if (!active.moved) {
          // A click on empty canvas clears the selection; a second one inside
          // the window is the double-click that flies the camera to the
          // nearest line's target (tic-1250).  The deselect still fires first,
          // so the flight starts from a clean selection.
          const now = performance.now()
          const prev = lastEmptyClick.current
          lastEmptyClick.current = { time: now }
          if (isEmptyDoubleClick(prev?.time ?? null, now)) {
            lastEmptyClick.current = null
            onEmptyDoubleClick()
          } else {
            onEmptyClick()
          }
        }
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
  }, [container, onMarquee, onEmptyClick, onEmptyDoubleClick])

  const fit = useCallback(() => {
    const bounds = getBounds()
    if (!bounds || size.width === 0 || size.height === 0) return
    useWorkspace.getState().fitTo(bounds, size)
  }, [getBounds, size])

  return { viewport, marquee, panning, fit, stageProps: { onWheel, onPointerDown } }
}
