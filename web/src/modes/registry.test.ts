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

/** Every param control a registered mode offers, whatever kind it is. */
function everyControl() {
  return MODES.flatMap((mode) =>
    [
      ...(mode.paramToggles ?? []),
      ...(mode.paramOptions ?? []),
      ...(mode.paramNumbers ?? []),
    ].map((control) => ({ mode: mode.id, ...control })),
  )
}

describe('control help (tic-ec97)', () => {
  it('explains every control every registered mode declares', () => {
    // A sweep rather than a case per mode: a control shipping unexplained is
    // the failure this exists to prevent, and a new mode should inherit the
    // requirement without anyone remembering to add a case for it.
    const controls = everyControl()
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) {
      expect(control.help, `${control.mode}.${control.key}`).toBeTruthy()
    }
  })

  it('writes an explanation rather than a restated label', () => {
    // `help: 'Sibling wrap'` would satisfy a truthiness check and tell a
    // reader nothing.  A real sentence runs longer than its own label and
    // ends like one.
    for (const control of everyControl()) {
      const where = `${control.mode}.${control.key}`
      expect(control.help.length, where).toBeGreaterThan(control.label.length * 4)
      expect(control.help.trim(), where).toMatch(/\.$/)
      expect(control.help, where).not.toBe(control.label)
    }
  })

  it('names each control exactly once per mode, so no help goes unreachable', () => {
    // Two controls sharing a key would render two rows writing to the same
    // param, and the second explanation would describe a control that is not
    // the one the reader is looking at.
    for (const mode of MODES) {
      const keys = everyControl()
        .filter((c) => c.mode === mode.id)
        .map((c) => c.key)
      expect(new Set(keys).size, mode.id).toBe(keys.length)
    }
  })

  it('describes a param the mode actually has', () => {
    // A key that has drifted from `defaultParams` renders a control that sets
    // something nothing reads, with an explanation for a feature that is not
    // there.
    for (const control of everyControl()) {
      const defaults = MODES.find((m) => m.id === control.mode)!.defaultParams
      expect(Object.keys(defaults), `${control.mode}.${control.key}`).toContain(control.key)
    }
  })
})
