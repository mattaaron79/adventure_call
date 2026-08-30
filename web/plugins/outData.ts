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
import { createReadStream, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'
import { DATA_CHANGED_EVENT } from '../src/data/events'

/** Only these names are reachable through `/data/` -- no path traversal. */
const SERVED = ['codebase_graph.json', 'symbol_registry.json'] as const

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

      const announce = (file: string) => {
        if (!paths.includes(resolve(file))) return
        const name = basename(file)
        server.config.logger.info(`  out-data changed: ${name}`, { timestamp: true })
        server.ws.send({ type: 'custom', event: DATA_CHANGED_EVENT, data: { file: name } })
      }
      server.watcher.on('change', announce)
      server.watcher.on('add', announce)

      server.middlewares.use('/data', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\//, '')
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
