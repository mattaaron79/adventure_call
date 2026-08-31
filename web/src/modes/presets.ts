/**
 * Mode presets (tic-83ec).
 *
 * A preset is a named, serializable snapshot of how the workspace was
 * configured: which mode, that mode's params, the exclude filters and what
 * was expanded.  'Modes as saved presets instead of hand-coded' -- loading
 * one reproduces the view exactly, and the JSON export moves them between
 * machines.
 *
 * Everything read back is validated: the store is user-editable and survives
 * across versions of the app, so a stale or hand-mangled entry degrades to
 * "no presets" rather than taking the picker down with it.
 */

export const PRESETS_STORAGE_KEY = 'adventure-call:presets'

export interface Preset {
  name: string
  modeId: string
  params: Record<string, unknown>
  /** Exclude patterns active when the preset was saved. */
  filters: string[]
  /** Node id -> expanded, handed to the mode's `UiState` on load. */
  expandState: Record<string, boolean>
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // private-mode / blocked site data
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPreset(value: unknown): value is Preset {
  if (!isRecord(value)) return false
  return (
    typeof value.name === 'string' &&
    value.name !== '' &&
    typeof value.modeId === 'string' &&
    value.modeId !== '' &&
    isRecord(value.params) &&
    Array.isArray(value.filters) &&
    value.filters.every((f) => typeof f === 'string') &&
    isRecord(value.expandState) &&
    Object.values(value.expandState).every((v) => typeof v === 'boolean')
  )
}

/** The saved presets, or an empty list when nothing usable is stored. */
export function readPresets(): Preset[] {
  let raw: string | null | undefined
  try {
    raw = storage()?.getItem(PRESETS_STORAGE_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isPreset).map((preset) => ({
      name: preset.name,
      modeId: preset.modeId,
      params: { ...preset.params },
      filters: [...preset.filters],
      expandState: { ...preset.expandState },
    }))
  } catch {
    return []
  }
}

export function writePresets(presets: readonly Preset[]): void {
  try {
    storage()?.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets))
  } catch {
    // Persistence is a convenience; the in-memory list still applies.
  }
}

/** Upsert by name; later saves with the same name replace the earlier one. */
export function savePreset(preset: Preset, presets: readonly Preset[]): Preset[] {
  const next = presets.filter((p) => p.name !== preset.name)
  next.push({ ...preset, params: { ...preset.params }, filters: [...preset.filters], expandState: { ...preset.expandState } })
  return next
}

export function deletePreset(name: string, presets: readonly Preset[]): Preset[] {
  return presets.filter((p) => p.name !== name)
}

/** The JSON document behind the export button. */
export function exportPresets(presets: readonly Preset[]): string {
  return JSON.stringify({ schema_version: 1, presets }, null, 2)
}

/** Download the presets as JSON; a no-op outside a browser. */
export function downloadPresets(presets: readonly Preset[]): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([exportPresets(presets)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'adventure-call-presets.json'
  anchor.click()
  URL.revokeObjectURL(url)
}
