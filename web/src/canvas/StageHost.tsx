/**
 * Sizes the Konva stage to its container.  The scene graph itself arrives with
 * the workspace primitives (tic-e8c5); for now this proves the renderer is
 * wired up and that resize handling is in place before layers exist.
 */
import { useEffect, useRef, useState } from 'react'
import { Layer, Rect, Stage } from 'react-konva'

export function StageHost() {
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

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

  return (
    <div ref={host} style={{ position: 'absolute', inset: 0 }}>
      {size.width > 0 && size.height > 0 && (
        <Stage width={size.width} height={size.height}>
          <Layer listening={false}>
            <Rect width={size.width} height={size.height} fill="#11111b" />
          </Layer>
        </Stage>
      )}
    </div>
  )
}
