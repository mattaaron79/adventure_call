/**
 * `onDataChanged`'s live-update fallback (tic-70f3).
 *
 * Vitest runs in node (vite.config.ts:18-28), so there is no `EventSource` to
 * talk to and no `import.meta.hot`: the factory below stands in for the first,
 * and the second being absent is what puts `onDataChanged` on the events path.
 * Nothing here opens a socket -- the wire contract is tests/test_serve.py.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DATA_CHANGED_EVENT } from './events'
import { RETRY_MAX_MS, RETRY_MIN_MS, loadRegistry, onDataChanged, setEventSourceFactory } from './load'
import type { DataEventSource } from './load'

class FakeEventSource implements DataEventSource {
  static opened: FakeEventSource[] = []

  closed = false
  private readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>()

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const forType = this.listeners.get(type) ?? []
    forType.push(listener)
    this.listeners.set(type, forType)
  }

  close(): void {
    this.closed = true
  }

  /** Hand one frame to everything listening for `type`. */
  emit(type: string, data = ''): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent)
    }
  }

  static get latest(): FakeEventSource {
    const source = FakeEventSource.opened.at(-1)
    if (!source) throw new Error('no EventSource was opened')
    return source
  }
}

beforeEach(() => {
  FakeEventSource.opened = []
  setEventSourceFactory((url) => new FakeEventSource(url))
})

afterEach(() => {
  setEventSourceFactory(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('subscribes to /data/events when there is no HMR client', () => {
  const unsubscribe = onDataChanged(() => {})
  expect(FakeEventSource.latest.url).toBe('/data/events')
  unsubscribe()
})

it('falls back to the browser EventSource when no stand-in is installed', () => {
  const constructed = vi.fn<(url: string) => void>()
  class RealEventSource {
    constructor(url: string) {
      constructed(url)
    }
    addEventListener(): void {}
    close(): void {}
  }
  vi.stubGlobal('EventSource', RealEventSource)
  setEventSourceFactory(null)

  const unsubscribe = onDataChanged(() => {})
  expect(constructed).toHaveBeenCalledWith('/data/events')
  unsubscribe()
})

it('a change frame drops the cached registry and calls the handler once', async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  vi.stubGlobal('fetch', fetchMock)
  await loadRegistry() // whatever the memo holds, count from here
  const reads = fetchMock.mock.calls.length

  const seen: string[] = []
  const unsubscribe = onDataChanged((file) => seen.push(file))
  FakeEventSource.latest.emit(DATA_CHANGED_EVENT, JSON.stringify({ file: 'src/api.py' }))

  expect(seen).toEqual(['src/api.py'])
  await loadRegistry()
  expect(fetchMock.mock.calls.length).toBe(reads + 1) // the memo was dropped
  unsubscribe()
})

it('an unreadable frame still reports a change and never throws', () => {
  const seen: string[] = []
  const unsubscribe = onDataChanged((file) => seen.push(file))
  expect(() => FakeEventSource.latest.emit(DATA_CHANGED_EVENT, 'not json')).not.toThrow()
  expect(seen).toEqual([''])
  unsubscribe()
})

it('unsubscribe closes the stream and is safe to call again', () => {
  const unsubscribe = onDataChanged(() => {})
  const source = FakeEventSource.latest
  expect(source.closed).toBe(false)

  unsubscribe()
  expect(source.closed).toBe(true)
  expect(() => unsubscribe()).not.toThrow()
})

it('a transport error stays quiet and retries on a doubling, capped backoff', async () => {
  vi.useFakeTimers()
  const noise = vi.spyOn(console, 'error').mockImplementation(() => {})

  const unsubscribe = onDataChanged(() => {})
  const first = FakeEventSource.latest
  expect(() => first.emit('error')).not.toThrow()
  expect(first.closed).toBe(true) // the browser's own retry is stopped
  expect(FakeEventSource.opened).toHaveLength(1)

  await vi.advanceTimersByTimeAsync(RETRY_MIN_MS)
  expect(FakeEventSource.opened).toHaveLength(2)
  FakeEventSource.latest.emit('error')
  await vi.advanceTimersByTimeAsync(RETRY_MIN_MS)
  expect(FakeEventSource.opened).toHaveLength(2) // the second wait is twice as long
  await vi.advanceTimersByTimeAsync(RETRY_MIN_MS)
  expect(FakeEventSource.opened).toHaveLength(3)

  // A connection that opens resets the backoff, so a flapping server recovers.
  FakeEventSource.latest.emit('open')
  FakeEventSource.latest.emit('error')
  await vi.advanceTimersByTimeAsync(RETRY_MIN_MS)
  expect(FakeEventSource.opened).toHaveLength(4)

  expect(noise).not.toHaveBeenCalled()
  unsubscribe()
})

it('gives up on nothing: a permanent failure is still retried, only rarely', async () => {
  vi.useFakeTimers()
  const unsubscribe = onDataChanged(() => {})
  FakeEventSource.latest.emit('error')

  // Nine failures doubles the wait to the cap, and it stays there.
  for (let i = 0; i < 9; i += 1) {
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS)
    FakeEventSource.latest.emit('error')
  }
  const atCap = FakeEventSource.opened.length
  await vi.advanceTimersByTimeAsync(RETRY_MAX_MS)
  expect(FakeEventSource.opened.length).toBe(atCap + 1)
  unsubscribe()
})
