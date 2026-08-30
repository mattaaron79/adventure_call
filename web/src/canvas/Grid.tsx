/**
 * The dotted background.
 *
 * Drawn as a single screen-space Rect filled with a repeating dot tile, so the
 * cost is one shape and one pattern fill no matter how far out the camera is.
 * A Konva shape per dot would be tens of thousands of nodes at low zoom.
 *
 * Panning moves the pattern phase; zooming re-bakes the tile at the new
 * spacing, which keeps the dots a constant size on screen instead of swelling
 * with the scale.
 */
import { useMemo } from 'react'
import { Rect } from 'react-konva'
import { MAJOR_EVERY, gridStep, wrap } from './gridMetrics'
import type { Viewport } from './viewport'

interface Props {
  width: number
  height: number
  viewport: Viewport
  minor?: string
  major?: string
}

/** A MAJOR_EVERY-square block of dots, at device resolution. */
function dotTile(spacing: number, dpr: number, minor: string, major: string): HTMLCanvasElement {
  const tile = document.createElement('canvas')
  const size = Math.max(1, Math.round(spacing * MAJOR_EVERY * dpr))
  tile.width = size
  tile.height = size

  const ctx = tile.getContext('2d')
  if (!ctx) return tile
  const pitch = size / MAJOR_EVERY
  const radius = Math.max(0.75, 0.9 * dpr)

  for (let row = 0; row < MAJOR_EVERY; row++) {
    for (let col = 0; col < MAJOR_EVERY; col++) {
      ctx.beginPath()
      // Half-pitch inset: a dot on the tile seam would be clipped in half and
      // drawn twice, once by each neighbouring tile.
      ctx.arc(col * pitch + pitch / 2, row * pitch + pitch / 2, radius, 0, Math.PI * 2)
      ctx.fillStyle = row === 0 && col === 0 ? major : minor
      ctx.fill()
    }
  }
  return tile
}

export function Grid({ width, height, viewport, minor = '#2a2b3c', major = '#3d3f57' }: Props) {
  const step = gridStep(viewport.scale)
  // Integer spacing keeps the baked dots on device pixels; the sub-pixel error
  // it introduces is invisible on a background grid.
  const spacing = Math.max(2, Math.round(step * viewport.scale))
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1

  const tile = useMemo(() => dotTile(spacing, dpr, minor, major), [spacing, dpr, minor, major])

  // The pattern transform is translate -> scale, so the offset is in screen
  // pixels while the scale undoes the tile's device-pixel oversampling.
  const period = spacing * MAJOR_EVERY
  return (
    <Rect
      x={0}
      y={0}
      width={width}
      height={height}
      listening={false}
      perfectDrawEnabled={false}
      // Konva hands the image straight to createPattern, which takes any
      // CanvasImageSource; its typings only admit HTMLImageElement.
      fillPatternImage={tile as unknown as HTMLImageElement}
      fillPatternRepeat="repeat"
      fillPatternScaleX={1 / dpr}
      fillPatternScaleY={1 / dpr}
      fillPatternX={wrap(viewport.x, period)}
      fillPatternY={wrap(viewport.y, period)}
    />
  )
}
