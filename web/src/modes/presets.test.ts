import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryStorage } from '../testing/memoryStorage'
import {
  PRESETS_STORAGE_KEY,
  deletePreset,
  exportPresets,
  readPresets,
  savePreset,
  writePresets,
  type Preset,
} from './presets'

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const preset = (name: string, overrides: Partial<Preset> = {}): Preset => ({
  name,
  modeId: 'fs-tree',
  params: { showImports: true },
  filters: ['src/**'],
  expandState: { 'src/app/loop.py': true },
  focusPath: '',
  ...overrides,
})

describe('presets', () => {
  it('round trips through localStorage', () => {
    const saved = savePreset(preset('all files'), [])
    writePresets(saved)
    expect(readPresets()).toEqual(saved)
  })

  it('upserts by name, so re-saving replaces the earlier snapshot', () => {
    let presets = savePreset(preset('src only', { filters: ['src/**'] }), [])
    presets = savePreset(preset('all files', { filters: [] }), presets)
    presets = savePreset(preset('src only', { filters: ['src/**', '!**/tests/**'] }), presets)
    expect(presets.map((p) => p.name)).toEqual(['all files', 'src only'])
    expect(presets[1].filters).toEqual(['src/**', '!**/tests/**'])
  })

  it('deletes by name', () => {
    let presets = savePreset(preset('a'), [])
    presets = savePreset(preset('b'), presets)
    presets = deletePreset('a', presets)
    expect(presets.map((p) => p.name)).toEqual(['b'])
    expect(deletePreset('missing', presets)).toHaveLength(1)
  })

  it('reports nothing rather than junk from a hand edit or older build', () => {
    localStorage.setItem(PRESETS_STORAGE_KEY, 'not json')
    expect(readPresets()).toEqual([])

    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify({ nope: true }))
    expect(readPresets()).toEqual([])

    localStorage.setItem(
      PRESETS_STORAGE_KEY,
      JSON.stringify([
        'a string',
        { name: '', modeId: 'fs-tree', params: {}, filters: [], expandState: {} },
        { name: 'no mode', params: {}, filters: [], expandState: {} },
        {
          name: 'bad expand',
          modeId: 'fs-tree',
          params: {},
          filters: [],
          expandState: { 'a.py': 'yes' },
        },
        preset('good'),
      ]),
    )
    expect(readPresets()).toEqual([preset('good')])
  })

  it('exports a JSON document that reads back identically', () => {
    const presets = savePreset(preset('src only', { expandState: { 'src/a.py': true } }), [])
    const parsed: unknown = JSON.parse(exportPresets(presets))
    expect(parsed).toEqual({ schema_version: 1, presets })
  })

  it('rides the focus path along in a saved preset (tic-e7d2)', () => {
    const saved = savePreset(preset('scoped', { focusPath: 'src/app' }), [])
    writePresets(saved)
    expect(readPresets()).toEqual(saved)
    expect(readPresets()[0].focusPath).toBe('src/app')

    // A preset with a non-string focusPath is junk, not a scope.
    localStorage.setItem(
      PRESETS_STORAGE_KEY,
      JSON.stringify([
        { ...preset('scoped'), focusPath: 7 },
        preset('root'),
      ]),
    )
    expect(readPresets()).toEqual([preset('root')])
  })

  it('is a no-op when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => writePresets([preset('a')])).not.toThrow()
    expect(readPresets()).toEqual([])
  })
})
