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
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'
import { DATA_CHANGED_EVENT } from '../src/data/events'

/** Only these names are reachable through `/data/` -- no path traversal. */
const SERVED = ['codebase_graph.json', 'symbol_registry.json'] as const

/** Synthetic endpoint: exposes the absolute analysed root for `vscode://` links
 *  (tic-4b0a).  Not a file on disk, so it is handled explicitly below. */
const META_NAME = 'meta.json'

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
       * The absolute analysed root, resolved once per export change (tic-4b0a).
       * The graph's `root` is written relative to the generation cwd
       * ('../carnot' in the current export), which the browser cannot resolve;
       * the dev server knows the out dir, so it joins them and exposes the
       * result.  Recomputes only when `codebase_graph.json` on disk changes.
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
            graph?: { root?: unknown }
          }
          const root = typeof graph.graph?.root === 'string' ? graph.graph.root : ''
          cachedRoot = root === '' ? null : resolve(dir, root)
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
          res.end(JSON.stringify({ root: absoluteRoot() }))
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
