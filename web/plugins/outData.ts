/**
 * Dev-only Vite plugin: serve the adventure-call JSON exports and push a
 * change event when they are rewritten.
 *
 * The exports live outside the Vite root (`<repo>/out`), so they are streamed
 * through a middleware at `/data/*` rather than copied into `public/`.  The
 * same files are handed to Vite's existing chokidar watcher; when one changes
 * we send a custom HMR message and the client refetches in place.  No second
 * server, no polling, no extra dependency.
 */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'
import { DATA_CHANGED_EVENT } from '../src/data/events'

/** Only these names are reachable through `/data/` -- no path traversal. */
const SERVED = ['codebase_graph.json', 'symbol_registry.json'] as const

/** Synthetic endpoint: exposes the absolute analysed root for `vscode://` links
 *  (tic-4b0a) and the project id the page namespaces its saved state with
 *  (tic-168b).  Not a file on disk, so it is handled explicitly below. */
const META_NAME = 'meta.json'

/**
 * The absolute analysed root for `vscode://` deep links (tic-4b0a, tic-7f0b).
 *
 * Prefers the absolute root recorded at generation time (`root_abs`), which is
 * pinned against the cwd adventure-call ran in and so needs no guessing.  Older
 * exports carry only the relative `root`; for those we fall back to resolving
 * it against the out directory -- degraded, but still something.  Exported for
 * tests.
 */
export function resolveAbsoluteRoot(
  graph: { root?: unknown; root_abs?: unknown } | undefined,
  dir: string,
): string | null {
  const rootAbs = typeof graph?.root_abs === 'string' ? graph.root_abs : ''
  if (rootAbs !== '') return rootAbs.replace(/\\/g, '/')
  const root = typeof graph?.root === 'string' ? graph.root : ''
  return root === '' ? null : resolve(dir, root)
}

/**
 * The project namespace for the meta document (tic-168b).
 *
 * `vcall serve` derives the same id from the same root in Python
 * (`serve.project_id`), so a project reached through this dev server and through
 * a served bundle keeps one set of saved state: the directory name slugged for a
 * human reading devtools, plus the first 8 hex of the path's SHA-256.  A null or
 * empty root has no project to name, which leaves the client on its unnamespaced
 * keys.  Exported for tests.
 */
export function projectIdFromRoot(root: string | null): string | null {
  if (root === null || root === '') return null
  const digest = createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 8)
  const name = root.replace(/\/+$/, '').split('/').pop() ?? ''
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug === '' ? digest : `${slug}-${digest}`
}

/** The `/data/meta.json` body: the analysed root, and the project it names. */
export function metaDocument(root: string | null): { root: string | null; project: string | null } {
  return { root, project: projectIdFromRoot(root) }
}

export interface OutDataOptions {
  /** Directory holding the adventure-call exports, relative to the Vite root. */
  outDir?: string
}

export function outData({ outDir = '../out' }: OutDataOptions = {}): Plugin {
  let dir: string

  return {
    name: 'adventure-call:out-data',
    apply: 'serve',

    configResolved(config) {
      dir = resolve(config.root, outDir)
    },

    configureServer(server: ViteDevServer) {
      const paths = SERVED.map((name) => resolve(dir, name))
      server.watcher.add(paths)

      /**
       * The absolute analysed root, resolved once per export change
       * (tic-4b0a, tic-7f0b).  Modern exports record `root_abs` at generation
       * time and are used verbatim; an older export has only the relative
       * `root`, which the dev server joins with the out dir -- degraded but
       * still something.  Recomputes only when `codebase_graph.json` on disk
       * changes.
       */
      let cachedRoot: string | null = null
      let cachedMtime = -1
      const absoluteRoot = (): string | null => {
        const graphFile = resolve(dir, 'codebase_graph.json')
        let mtime: number
        try {
          mtime = statSync(graphFile).mtimeMs
        } catch {
          cachedRoot = null
          cachedMtime = -1
          return null
        }
        if (mtime === cachedMtime) return cachedRoot
        try {
          const graph = JSON.parse(readFileSync(graphFile, 'utf8')) as {
            graph?: { root?: unknown; root_abs?: unknown }
          }
          cachedRoot = resolveAbsoluteRoot(graph.graph, dir)
        } catch {
          cachedRoot = null
        }
        cachedMtime = mtime
        return cachedRoot
      }

      const announce = (file: string) => {
        if (!paths.includes(resolve(file))) return
        const name = basename(file)
        if (name === 'codebase_graph.json') cachedMtime = -1 // re-resolve the root
        server.config.logger.info(`  out-data changed: ${name}`, { timestamp: true })
        server.ws.send({ type: 'custom', event: DATA_CHANGED_EVENT, data: { file: name } })
      }
      server.watcher.on('change', announce)
      server.watcher.on('add', announce)

      server.middlewares.use('/data', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '')
        if (name === META_NAME) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(metaDocument(absoluteRoot())))
          return
        }
        if (!(SERVED as readonly string[]).includes(name)) return next()

        const file = resolve(dir, name)
        let stat
        try {
          stat = statSync(file)
        } catch {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: `missing ${name}`, expected: file }))
          return
        }

        // Exports are regenerated wholesale; never let a stale copy survive.
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Length', String(stat.size))
        createReadStream(file).pipe(res)
      })
    },
  }
}
