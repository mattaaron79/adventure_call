import { describe, expect, it } from 'vitest'
import { DEFAULT_MODE_ID, MODES, modeById } from './registry'

describe('mode registry', () => {
  it('registers fs-tree as the default mode', () => {
    expect(DEFAULT_MODE_ID).toBe('fs-tree')
    expect(MODES.map((m) => m.id)).toContain('fs-tree')
    expect(modeById('fs-tree')).toBe(MODES[0])
  })

  it('falls back to the default for an unknown id, e.g. a stale preset', () => {
    expect(modeById('call-graph')).toBe(MODES[0])
  })

  it('gives every mode a unique id, label and default params', () => {
    const ids = new Set(MODES.map((m) => m.id))
    expect(ids.size).toBe(MODES.length)
    for (const mode of MODES) {
      expect(mode.label).not.toBe('')
      expect(mode.defaultParams).toBeTruthy()
    }
  })
})
