import { describe, expect, it } from 'vitest'
import { LOD_LABEL, LOD_SUBLABEL, LOD_SUMMARY, lodOf } from './lod'

describe('lodOf', () => {
  it('keeps everything at readable scales', () => {
    expect(lodOf(1)).toBe(0)
    expect(lodOf(LOD_SUBLABEL)).toBe(0)
  })

  it('drops sublabels first, then labels', () => {
    expect(lodOf(LOD_SUBLABEL - 0.01)).toBe(1)
    expect(lodOf(LOD_LABEL)).toBe(1)
    expect(lodOf(LOD_LABEL - 0.01)).toBe(2)
  })

  it('collapses containers only at extreme zoom-out', () => {
    expect(lodOf(LOD_SUMMARY)).toBe(2)
    expect(lodOf(LOD_SUMMARY - 0.01)).toBe(3)
    expect(lodOf(0.01)).toBe(3)
  })
})
