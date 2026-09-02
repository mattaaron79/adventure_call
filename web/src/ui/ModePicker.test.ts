/**
 * The mode panel's control explanations reach the page (tic-ec97).
 *
 * Rendered to static markup rather than driven through a DOM: the suite runs
 * in the node environment (see vite.config.ts), which is enough to answer the
 * question this file asks -- does the help a mode declares actually appear on
 * its control, and does the `?` decide whether it is also written out inline.
 *
 * Two limits come with that, and both shape what is asserted here rather than
 * being worked around:
 *
 * 1. The store is read through zustand's `useSyncExternalStore`, whose SERVER
 *    snapshot is the store's INITIAL state.  Calling `setMode` before
 *    rendering therefore changes nothing in the markup, so these cases test
 *    the mode the workspace opens with.  That is not a thin sample: the
 *    fs-tree declares all three control kinds, so a toggle, a segmented
 *    control and a number input are each covered.  The other modes' controls
 *    are held by the sweep in modes/registry.test.ts, which does not need a
 *    renderer to check that every one of them is explained.
 * 2. Nothing here clicks the `?`; both of its states are rendered from
 *    storage instead, which is what a returning session does anyway.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callFlowMode } from '../modes/callFlow'
import { fsTreeMode } from '../modes/fsTree'
import { DEFAULT_MODE_ID } from '../modes/registry'
import { HELP_PINNED_KEY } from './paramHelp'
import { ModePicker } from './ModePicker'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

const render = (pinned: boolean) => {
  vi.stubGlobal('localStorage', fakeStorage(pinned ? { [HELP_PINNED_KEY]: 'true' } : {}))
  return renderToStaticMarkup(
    createElement(ModePicker, { filters: [], onApplyFilters: () => {} }),
  )
}

/** Markup with entities decoded, so a help string can be searched literally. */
const text = (markup: string) =>
  markup
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')

/** The fs-tree's three controls, one of each kind the picker can render. */
const controls = [
  ...fsTreeMode.paramToggles!,
  ...fsTreeMode.paramOptions!,
  ...fsTreeMode.paramNumbers!,
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ModePicker help', () => {
  it('renders the mode the store opens with, which is what these cases assert against', () => {
    // Stated as its own case because the SSR snapshot makes it unchangeable
    // (see the file docstring): if the default ever moves, these tests are
    // describing a different panel and should say so out loud.
    expect(DEFAULT_MODE_ID).toBe(fsTreeMode.id)
    expect(render(false)).toContain(`<option value="${fsTreeMode.id}" selected=""`)
    expect(controls).toHaveLength(3)
  })

  it('puts every control on a tooltip whether the help is pinned or not', () => {
    // The tooltip is the always-available half: it costs nothing and answers
    // "what is this one thing" without changing the panel's layout.
    for (const pinned of [false, true]) {
      const markup = text(render(pinned))
      for (const control of controls) {
        expect(markup, `${control.key} pinned=${pinned}`).toContain(`title="${control.help}"`)
      }
    }
  })

  it('writes the explanations out inline only when the pin is on', () => {
    // The inline copy is what the `?` controls, and it is what a reader
    // meeting the panel for the first time needs -- nine tooltips hovered one
    // at a time is not the same answer to the same question.
    const pinned = text(render(true))
    for (const control of controls) {
      expect(pinned, control.key).toContain(`<p class="param-help">${control.help}</p>`)
    }
    expect(text(render(false))).not.toContain('param-help')
  })

  it('shows the pin as pressed, so its state reads without hovering it', () => {
    expect(render(true)).toContain('aria-pressed="true"')
    expect(render(false)).toContain('aria-pressed="false"')
  })

  it('explains only the active mode, so the panel matches what is drawn', () => {
    // Every mode's help sits in one registry, and rendering all of it would
    // describe controls that are not on screen.
    const markup = text(render(true))
    expect(markup).toContain(fsTreeMode.paramToggles![0].help)
    expect(markup).not.toContain(callFlowMode.paramToggles![0].help)
  })
})
