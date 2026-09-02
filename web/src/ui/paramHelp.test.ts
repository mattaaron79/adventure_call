import { afterEach, describe, expect, it, vi } from 'vitest'
import { HELP_PINNED_KEY, readHelpPinned, writeHelpPinned } from './paramHelp'

/** A localStorage stand-in; the node test environment has none. */
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
    map,
  }
}

function install(storage: unknown) {
  vi.stubGlobal('localStorage', storage)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('help-pinned preference (tic-ec97)', () => {
  it('round-trips through storage', () => {
    const store = fakeStorage()
    install(store)
    expect(readHelpPinned()).toBe(false)
    writeHelpPinned(true)
    expect(store.map.get(HELP_PINNED_KEY)).toBe('true')
    expect(readHelpPinned()).toBe(true)
    writeHelpPinned(false)
    expect(readHelpPinned()).toBe(false)
  })

  it('stays out of the per-mode workspace keys', () => {
    // Switching modes must not change whether the explanations are open, and
    // a saved preset must not carry someone else's reading preference into
    // another session.
    expect(HELP_PINNED_KEY.startsWith('adventure-call:workspace:')).toBe(false)
  })

  it('reads a value it did not write as "closed" rather than trusting it', () => {
    install(fakeStorage({ [HELP_PINNED_KEY]: '1' }))
    expect(readHelpPinned()).toBe(false)
    install(fakeStorage({ [HELP_PINNED_KEY]: 'yes' }))
    expect(readHelpPinned()).toBe(false)
  })

  it('survives a store that throws on every access', () => {
    // Private-mode browsers and blocked site data both do this.  The failure
    // of a reading preference has to be "the help is closed", not a sidebar
    // that will not render.
    install({
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(readHelpPinned()).toBe(false)
    expect(() => writeHelpPinned(true)).not.toThrow()
  })

  it('survives an environment with no localStorage at all', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(readHelpPinned()).toBe(false)
    expect(() => writeHelpPinned(true)).not.toThrow()
  })
})
