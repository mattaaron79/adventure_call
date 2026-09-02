/**
 * The mode registry (tic-83ec).
 *
 * The single place a mode is discovered from.  The app renders whichever mode
 * the store points at through `renderMode`, and must never reach past the
 * `VizMode` interface into a mode's internals -- adding a mode is adding one
 * entry here.
 */
import { callFlowMode } from './callFlow'
import { fsTreeMode } from './fsTree'
import { importGraphMode } from './importGraph'
import { sunburstMode } from './sunburst'
import type { VizMode } from './types'

/**
 * A mode of unknown param type.  The registry erases the param type: callers
 * that hold a concrete mode (the fs-tree tests) keep its typing, while the
 * app treats params as the opaque record the store persists.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AnyMode = VizMode<any>

/** Every registered mode, in picker order. */
export const MODES: readonly AnyMode[] = [fsTreeMode, sunburstMode, importGraphMode, callFlowMode]

/** The mode the workspace opens with. */
export const DEFAULT_MODE_ID = fsTreeMode.id

const byId = new Map(MODES.map((mode) => [mode.id, mode]))

/** The registered mode with this id, or the default when unknown. */
export function modeById(id: string): AnyMode {
  return byId.get(id) ?? MODES[0]
}
