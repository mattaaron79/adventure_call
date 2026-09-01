import { describe, expect, it } from 'vitest'
import {
  actionAffordance,
  iconGlyphGeometry,
  iconSlots,
  isIconClick,
  shouldShowGoIn,
} from './iconButtonLogic'

describe('isIconClick (tic-4d7c)', () => {
  it('counts a still press as a click', () => {
    expect(isIconClick({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(true)
  })

  it('tolerates a small jitter (<= 5px), the same slop as the chips', () => {
    expect(isIconClick({ x: 10, y: 10 }, { x: 13, y: 14 })).toBe(true) // 3,4 -> 25
    expect(isIconClick({ x: 10, y: 10 }, { x: 15, y: 10 })).toBe(true) // exactly 5
    expect(isIconClick({ x: 10, y: 10 }, { x: 5, y: 10 })).toBe(true) // negative direction
  })

  it('rejects a press that travelled far enough to be a drag', () => {
    expect(isIconClick({ x: 0, y: 0 }, { x: 4, y: 4 })).toBe(false) // 32 > 25
    expect(isIconClick({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(false)
  })
})

describe('shouldShowGoIn (tic-4d7c)', () => {
  it('shows the go-into button on any directory except the focused one', () => {
    expect(shouldShowGoIn('src/app', 'src')).toBe(true)
    expect(shouldShowGoIn('src/app', '')).toBe(true)
  })

  it('hides it when the target equals the active focus path', () => {
    expect(shouldShowGoIn('src/app', 'src/app')).toBe(false)
    // The whole-graph root (focusTo '') hides its button while focused.
    expect(shouldShowGoIn('', '')).toBe(false)
  })

  it('hides it on nodes that carry no focus target', () => {
    expect(shouldShowGoIn(undefined, '')).toBe(false)
    expect(shouldShowGoIn(undefined, 'src/app')).toBe(false)
  })
})

describe('iconGlyphGeometry (tic-4d7c)', () => {
  it('centres a 16x16 glyph inside the hit target, scaled to ~72% of it', () => {
    const g = iconGlyphGeometry(18)
    expect(g.scale).toBeCloseTo(0.81) // 18 * 0.72 / 16
    expect(g.x).toBeCloseTo(2.52) // (18 - 18*0.72) / 2
    expect(g.y).toBeCloseTo(2.52)
  })

  it('always keeps the glyph strictly inside the target', () => {
    for (const size of [14, 18, 24, 32]) {
      const g = iconGlyphGeometry(size)
      const glyph = 16 * g.scale
      expect(glyph).toBeLessThan(size)
      expect(g.x + glyph).toBeLessThanOrEqual(size)
      expect(g.y + glyph).toBeLessThanOrEqual(size)
    }
  })
})

describe('iconSlots (tic-ea7b)', () => {
  const CHIP = { width: 200, height: 40 }
  const ROW = { width: 260, height: 24 }
  const CONTAINER = { width: 300, height: 220 }

  it('gives the source link the outer slot and the action button the inner one', () => {
    // The swap the user asked for: "open the code" lands in the same place on
    // every item that offers it, whatever else the item carries.
    const both = iconSlots(CHIP.width, CHIP.height, true, true)
    expect(both.source).toBe(174)
    expect(both.action).toBe(150)
    expect(both.source).toBeGreaterThan(both.action)
  })

  it('puts a lone button in the outer slot rather than leaving a gap', () => {
    expect(iconSlots(CHIP.width, CHIP.height, true, false).source).toBe(174)
    expect(iconSlots(CHIP.width, CHIP.height, false, true).action).toBe(174)
  })

  it('centres the icons on a chip and on a row', () => {
    // The folder chips are the model: an 18-unit button centred in the box.
    expect(iconSlots(CHIP.width, CHIP.height, true, true).y).toBe(11)
    expect(iconSlots(150, 36, false, true).y).toBe(9)
    expect(iconSlots(ROW.width, ROW.height, true, true).y).toBe(3)
  })

  it('pins the icons to the top corner of an expanded container', () => {
    // Centred on a box this tall would be halfway down its rows, far from the
    // header the buttons belong to.
    expect(iconSlots(CONTAINER.width, CONTAINER.height, true, true).y).toBe(4)
  })

  it('reserves label width for the buttons that are actually there', () => {
    expect(iconSlots(CHIP.width, CHIP.height, false, false).labelInset).toBe(20)
    expect(iconSlots(CHIP.width, CHIP.height, true, false).labelInset).toBe(40)
    expect(iconSlots(CHIP.width, CHIP.height, false, true).labelInset).toBe(40)
    expect(iconSlots(CHIP.width, CHIP.height, true, true).labelInset).toBe(64)
  })

  it('keeps the label clear of the inner button', () => {
    // The regression that made this worth extracting: an import-graph file chip
    // carries both buttons, and a label inset measured for one ran under them.
    const both = iconSlots(CHIP.width, CHIP.height, true, true)
    expect(CHIP.width - both.labelInset).toBeLessThanOrEqual(both.action)
  })
})


describe('actionAffordance (tic-e738)', () => {
  const OPEN_IN = { modeId: 'import-graph', target: 'src/a.py' }

  it('gives the slot to a focus target', () => {
    expect(actionAffordance({ focusTo: 'src/app' }, '')).toBe('focus')
  })

  it('gives the slot to a goto target', () => {
    expect(actionAffordance({ gotoTo: 'src/a.py' }, '')).toBe('goto')
  })

  it('gives the slot to a cross-mode target', () => {
    expect(actionAffordance({ openIn: OPEN_IN }, '')).toBe('open-in')
  })

  it('is null when the node wants nothing', () => {
    expect(actionAffordance({}, '')).toBeNull()
  })

  it('prefers focus over both, since only focus navigates within the view', () => {
    expect(actionAffordance({ focusTo: 'src/app', gotoTo: 'x', openIn: OPEN_IN }, '')).toBe('focus')
  })

  it('prefers goto over a cross-mode jump, which the inspector also offers', () => {
    expect(actionAffordance({ gotoTo: 'x', openIn: OPEN_IN }, '')).toBe('goto')
  })

  it('falls through to the cross-mode jump on the folder already focused', () => {
    // A folder hides its own 'go into' (tic-4d7c), which frees the slot.
    expect(actionAffordance({ focusTo: 'src/app', openIn: OPEN_IN }, 'src/app')).toBe('open-in')
  })
})
