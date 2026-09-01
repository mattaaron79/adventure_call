/**
 * Promise-based facade over elk's layered algorithm, run in a real Worker
 * (tic-e82b) so a large graph never blocks the main thread.
 *
 * elkjs already ships a complete, self-contained worker script
 * (elk-worker.min.js: registers algorithms, runs layout, converts GWT-style
 * errors) built for exactly this -- re-implementing that message loop by
 * hand would just be a worse copy of it. So this module doesn't own a
 * worker.ts of its own; it hands elk-api's thin ELK client a `workerFactory`
 * that points a real `Worker` at elkjs's script, and elk-api handles the
 * request/response plumbing (including matching concurrent calls to their
 * responses) internally.
 *
 * Two elkjs entry points matter here, and only these two: `elk-api.js` is
 * the plain client class this module talks to; `elk-worker.min.js` is the
 * worker script it points at. The bare `elkjs` package entry and
 * `elk.bundled.js` both resolve to a Node-oriented wrapper that conditionally
 * `require`s an uninstalled `web-worker` polyfill package -- fine in Node,
 * but it makes Rollup treat that package as an unresolved external during
 * the production build. Importing `elk-api.js` directly avoids that wrapper
 * entirely.
 *
 * `VizMode.layout()` (modes/types.ts) is a synchronous phase, so a consuming
 * mode cannot simply `await layoutGraph(...)` from inside its own `layout`.
 * That mode needs its own cache-and-recompute bridge -- kick off
 * `layoutGraph` once per distinct scene, return a previous or empty result
 * synchronously until it resolves, then trigger a re-render that picks up
 * the cached result. That bridge is the consuming mode's concern, not this
 * module's.
 */
import ElkConstructor from 'elkjs/lib/elk-api.js'
import type { ELK } from 'elkjs/lib/elk-api.js'
import { fromElkResult, toElkNode } from './elkConvert'
import type { ElkGraphInput, ElkGraphResult, ElkLayoutOptions } from './elkTypes'

let elk: ELK | null = null

function getElk(): ELK {
  if (!elk) {
    elk = new ElkConstructor({
      workerFactory: () =>
        new Worker(new URL('elkjs/lib/elk-worker.min.js', import.meta.url), {
          name: 'elk-layout',
        }),
    })
  }
  return elk
}

/** Lay out a graph with elk's layered algorithm, off the main thread. */
export async function layoutGraph(
  graph: ElkGraphInput,
  options?: ElkLayoutOptions,
): Promise<ElkGraphResult> {
  const laidOut = await getElk().layout(toElkNode(graph, options))
  return fromElkResult(laidOut)
}

/** Terminate the worker, e.g. in test teardown. */
export function disposeElkWorker(): void {
  elk?.terminateWorker()
  elk = null
}
