/**
 * The dev-server settings `vcall serve --dev` hands to Vite through the
 * environment (tic-ac17).
 *
 * Only two things vary per run -- which directory holds the exports to serve
 * and which port to bind -- and both arrive as environment variables rather
 * than as argv, so the process the CLI spawns is exactly the checkout's own
 * `npm run dev`.  Unset or blank means "the committed default", which is what
 * keeps `npm run dev` by hand, and the F5 launch config in
 * `.vscode/launch.json` (port 5175), exactly as they are today.
 */

/** The port `npm run dev` has always bound, and the one the F5 config opens. */
export const DEFAULT_PORT = 5175

/** Where the exports live for a checkout that sets nothing. */
export const DEFAULT_OUT_DIR = '../out'

/** The store directory to serve, or the committed default when unset or blank. */
export function resolveOutDir(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  return value === '' ? DEFAULT_OUT_DIR : value
}

/**
 * The port to bind: `VCALL_PORT` when the CLI set it, else the default.
 *
 * An unusable value falls back rather than throwing, because the only writer of
 * this variable is the CLI, which always sends a real port; a human setting it
 * to nonsense gets the documented default instead of a broken config.  Whether
 * `strictPort` is on is not decided here -- see `vite.config.ts`: the port the
 * CLI printed has to be the port it binds, so Vite must fail rather than drift.
 */
export function resolvePort(raw: string | undefined): number {
  const value = Number.parseInt((raw ?? '').trim(), 10)
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_PORT
}

/** The bind address Vite is given, or `undefined` for Vite's own default. */
export function resolveHost(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim()
  return value === '' ? undefined : value
}
