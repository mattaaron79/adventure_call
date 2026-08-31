/**
 * Mode and preset controls (tic-83ec).
 *
 * Switches the active mode via the registry, toggles the active mode's
 * declared boolean params, and saves / loads / deletes presets -- named,
 * serializable snapshots of { modeId, params, filters, expandState }.  The
 * exclude filters live in App state, so applying a preset's filters goes
 * through `onApplyFilters` rather than the workspace store.
 */
import { useState } from 'react'
import { MODES, modeById } from '../modes/registry'
import {
  deletePreset,
  downloadPresets,
  readPresets,
  savePreset,
  writePresets,
  type Preset,
} from '../modes/presets'
import { activeMode, useWorkspace } from '../state/store'

interface Props {
  /** The effective exclude list, captured into a preset on save. */
  filters: readonly string[]
  /** Applies a preset's filters; App owns the exclude state. */
  onApplyFilters: (filters: string[]) => void
}

export function ModePicker({ filters, onApplyFilters }: Props) {
  const modeId = useWorkspace((s) => s.modeId)
  const savedParams = useWorkspace((s) => activeMode(s).params)
  const expanded = useWorkspace((s) => activeMode(s).expanded)
  const focusPath = useWorkspace((s) => activeMode(s).focusPath)

  const mode = modeById(modeId)
  // Stored params are a sparse overlay on the mode's defaults.
  const params: Record<string, unknown> = { ...mode.defaultParams, ...savedParams }

  const [presets, setPresets] = useState<Preset[]>(readPresets)
  const [name, setName] = useState('')

  const commit = (next: Preset[]) => {
    setPresets(next)
    writePresets(next)
  }

  const save = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    commit(
      savePreset(
        {
          name: trimmed,
          modeId,
          params: { ...params },
          filters: [...filters],
          expandState: { ...expanded },
          focusPath,
        },
        presets,
      ),
    )
    setName('')
  }

  const apply = (preset: Preset) => {
    const store = useWorkspace.getState()
    store.setMode(preset.modeId)
    store.setParams(preset.params)
    store.setExpanded(preset.expandState)
    // A preset's focus rides along (tic-e7d2), so loading it reproduces the
    // exact scoped view it was saved from.
    store.setFocusPath(preset.focusPath)
    onApplyFilters(preset.filters)
  }

  const remove = (presetName: string) => commit(deletePreset(presetName, presets))

  return (
    <>
      <h2>Mode</h2>
      <select
        className="mode-select"
        value={modeId}
        onChange={(event) => useWorkspace.getState().setMode(event.target.value)}
      >
        {MODES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {mode.paramToggles?.map((toggle) => (
        <label key={toggle.key} className="noise-toggle">
          <input
            type="checkbox"
            checked={params[toggle.key] === true}
            onChange={(event) =>
              useWorkspace.getState().setParams({ ...params, [toggle.key]: event.target.checked })
            }
          />
          {toggle.label}
        </label>
      ))}
      {/* Multi-value params (tic-0419), e.g. the fs-tree orientation, render
          as a segmented control: one radio per declared option. */}
      {mode.paramOptions?.map((group) => (
        <fieldset key={group.key} className="param-options">
          <legend>{group.label}</legend>
          <div className="param-options-row">
            {group.options.map((option) => (
              <label
                key={option.value}
                className={`param-option${params[group.key] === option.value ? ' active' : ''}`}
              >
                <input
                  type="radio"
                  name={`param-${mode.id}-${group.key}`}
                  value={option.value}
                  checked={params[group.key] === option.value}
                  onChange={() =>
                    useWorkspace.getState().setParams({ ...params, [group.key]: option.value })
                  }
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {/* Numeric params (tic-3d87), e.g. the fs-tree sibling wrap, render as
          a labelled number input; 0/1 both mean "off". */}
      {mode.paramNumbers?.map((param) => (
        <label key={param.key} className="param-number">
          <span>{param.label}</span>
          <input
            type="number"
            min={param.min}
            max={param.max}
            step={param.step}
            value={Number(params[param.key] ?? 0)}
            onChange={(event) => {
              const next = event.target.value === '' ? 0 : Number(event.target.value)
              useWorkspace.getState().setParams({ ...params, [param.key]: next })
            }}
          />
        </label>
      ))}

      <h2>Presets</h2>
      <div className="preset-save">
        <input
          value={name}
          placeholder="Preset name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save()
          }}
        />
        <button type="button" onClick={save} disabled={!name.trim()}>
          Save
        </button>
      </div>
      <ul className="preset-list">
        {presets.map((preset) => (
          <li key={preset.name}>
            <span className="preset-name" title={preset.name}>
              {preset.name}
            </span>
            <button type="button" onClick={() => apply(preset)}>
              Load
            </button>
            <button type="button" onClick={() => remove(preset.name)} aria-label={`Delete ${preset.name}`}>
              ✕
            </button>
          </li>
        ))}
        {presets.length === 0 && <li className="preset-empty">No saved presets.</li>}
      </ul>
      <button
        type="button"
        className="preset-export"
        onClick={() => downloadPresets(presets)}
        disabled={presets.length === 0}
      >
        Export JSON
      </button>
    </>
  )
}
