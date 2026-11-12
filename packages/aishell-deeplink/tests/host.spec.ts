/**
 * The Host half, driven through a real fetch route.
 *
 * `apply()` is given a minimal context; the registered route is then called the
 * way the HTTP bridge calls it, and the streamed frames are read back. The
 * assertions are on what a connected Page receives, not on internal counters.
 */

import { describe, expect, it } from 'vitest'

import { apply, MAX_PENDING, type DeepLinks } from '../src/index.ts'
import { DEEPLINK_ROUTE } from '../src/route.ts'

/** The pieces of a cordis context this half touches. */
interface Harness {
  readonly deliver: (raw: string) => void
  readonly open: () => Promise<OpenStream>
  readonly warn: string[]
  /** Undo every effect the plugin installed. */
  readonly dispose: () => void
}

interface OpenStream {
  /** Frames read since the last call, in arrival order. */
  readonly frames: () => Promise<string[]>
  /** Close the stream as the transport would on client disconnect. */
  readonly close: () => void
}

/**
 * Build a context whose fetch registry keeps the route, mirroring how the
 * connection service hands a request to it.
 */
function harness(): Harness {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const disposers: (() => void)[] = []
  const warn: string[] = []
  let deepLinks: DeepLinks | undefined

  const ctx = {
    logger: () => ({ warn: (message: string) => { warn.push(message) } }),
    provide: (name: string, value: DeepLinks) => {
      if (name === 'deepLinks') deepLinks = value
      return () => { deepLinks = undefined }
    },
    effect: (make: () => unknown) => {
      const made = make()
      if (typeof made === 'function') disposers.push(made as () => void)
    },
    connection: {
      fetch: {
        register: (route: { path: string, fetch: (request: Request) => Promise<Response> }) => {
          routes.set(route.path, route.fetch)
          return () => { routes.delete(route.path) }
        },
      },
    },
  }

  apply(ctx as never)

  return {
    deliver(raw: string): void {
      if (deepLinks === undefined) throw new Error('deepLinks was not provided')
      deepLinks.deliver(raw)
    },
    warn,
    async open(): Promise<OpenStream> {
      const handler = routes.get(DEEPLINK_ROUTE)
      if (handler === undefined) throw new Error('the stream route was not registered')
      const abort = new AbortController()
      const request = new Request(`http://127.0.0.1${DEEPLINK_ROUTE}`, { signal: abort.signal })
      const response = await handler(request)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer: string[] = []
      let closed = false

      // One background read loop collects frames as they are published, so a
      // frame enqueued between assertions is observable on the next drain.
      // Sequential reads are the channel's contract: a stream admits one read
      // at a time, so these awaits cannot be parallelised.
      /* eslint-disable no-await-in-loop */
      const pump = (async () => {
        for (;;) {
          const read = await reader.read()
          if (read.done) return
          buffer.push(decoder.decode(read.value))
        }
      })()

      /**
       * Let already-enqueued frames reach the read loop.
       *
       * A stream read settles across both queues: the frames enqueued by
       * `start()` are handed over one per read, and each read resolves as a
       * task rather than a microtask. Waiting on microtasks alone drains the
       * first frame and reports the rest as missing, so this yields to the
       * task queue between polls and stops once a poll adds nothing.
       */
      const settle = async (): Promise<void> => {
        let seen = -1
        while (seen !== buffer.length) {
          seen = buffer.length
          for (let tick = 0; tick < 4; tick++) {
            await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
          }
        }
      }
      /* eslint-enable no-await-in-loop */

      return {
        async frames(): Promise<string[]> {
          await settle()
          const out = buffer
          buffer = []
          return out
        },
        close(): void {
          if (closed) return
          closed = true
          abort.abort()
          void pump
        },
      }
    },
    dispose(): void {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

/** Parse one SSE frame body into the URL it carries. */
function urlOf(frame: string): string | undefined {
  const match = /^data: (.*)\n\n$/s.exec(frame)
  if (match === null) return undefined
  return (JSON.parse(match[1]!) as { url: string }).url
}

/** The URLs among a batch of frames, ignoring the stream's opening comment. */
function urlsOf(frames: readonly string[]): string[] {
  const urls: string[] = []
  for (const frame of frames) {
    const url = urlOf(frame)
    if (url !== undefined) urls.push(url)
  }
  return urls
}

describe('Host half', () => {
  it('provides deepLinks and registers the stream route', async () => {
    const test = harness()
    expect(() => test.deliver('aishell://share/a')).not.toThrow()
    const stream = await test.open()
    stream.close()
    test.dispose()
  })

  it('holds a link that arrives before any Page connects', async () => {
    const test = harness()
    test.deliver('aishell://share/early')

    const stream = await test.open()
    expect(urlsOf(await stream.frames())).toEqual(['aishell://share/early'])
    stream.close()
    test.dispose()
  })

  it('pushes a link that arrives while a Page is connected', async () => {
    const test = harness()
    const stream = await test.open()
    await stream.frames()

    test.deliver('aishell://share/live')

    expect(urlsOf(await stream.frames())).toEqual(['aishell://share/live'])
    stream.close()
    test.dispose()
  })

  it('drops a URL it does not own, without holding it', async () => {
    const test = harness()
    test.deliver('https://example.com/x')

    const stream = await test.open()
    expect(urlsOf(await stream.frames())).toEqual([])
    expect(test.warn).toHaveLength(1)
    stream.close()
    test.dispose()
  })

  it('delivers every link in the order they arrived', async () => {
    const test = harness()
    const stream = await test.open()
    await stream.frames()

    test.deliver('aishell://share/1')
    test.deliver('aishell://share/2')

    expect(urlsOf(await stream.frames())).toEqual([
      'aishell://share/1',
      'aishell://share/2',
    ])
    stream.close()
    test.dispose()
  })

  it('keeps the newest links when more than the bound arrive unsent', async () => {
    const test = harness()
    // Two past the bound, whatever the bound is: the assertion is about which
    // links survive, not about a number the test would have to keep in step.
    const sent = MAX_PENDING + 2
    for (let index = 0; index < sent; index++) test.deliver(`aishell://share/${index}`)

    const stream = await test.open()
    const survived: string[] = []
    for (let index = sent - MAX_PENDING; index < sent; index++) {
      survived.push(`aishell://share/${index}`)
    }
    expect(urlsOf(await stream.frames())).toEqual(survived)
    stream.close()
    test.dispose()
  })
})