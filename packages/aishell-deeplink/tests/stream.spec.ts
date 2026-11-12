/**
 * The stream through a real HTTP server.
 *
 * The unit tests call the route handler directly, which proves the handler
 * produces frames but not that those frames survive the transport. This file
 * puts the route behind a `node:http` server, connects with a real client, and
 * reads the bytes back — the layer where a streaming response either works or
 * buffers everything until close.
 */

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { apply, type DeepLinks } from '../src/index.ts'
import { DEEPLINK_ROUTE } from '../src/route.ts'

/** A running server plus the way to release it. */
interface Serving {
  readonly origin: string
  readonly deliver: (raw: string) => void
  readonly stop: () => Promise<void>
}

/**
 * Start a server whose only route is the plugin's stream.
 *
 * The route handler is called the way the connection bridge calls it: one
 * `Request` per incoming message, its body streamed back verbatim.
 */
async function serve(): Promise<Serving> {
  let deepLinks: DeepLinks | undefined
  let route: ((request: Request) => Promise<Response>) | undefined
  /** Every response stream handed out, so shutdown can cancel them. */
  const bodies = new Set<ReadableStreamDefaultReader<Uint8Array>>()

  const ctx = {
    logger: () => ({ warn: () => {} }),
    provide: (_name: string, value: DeepLinks) => {
      deepLinks = value
      return () => { deepLinks = undefined }
    },
    effect: (make: () => unknown) => { make() },
    connection: {
      fetch: {
        register: (registered: { fetch: (request: Request) => Promise<Response> }) => {
          route = registered.fetch
          return () => { route = undefined }
        },
      },
    },
  }
  apply(ctx as never)

  const server: Server = createServer((_incoming, outgoing) => {
    const handler = route
    if (handler === undefined) {
      outgoing.writeHead(404)
      outgoing.end()
      return
    }
    const abort = new AbortController()
    outgoing.on('close', () => {
      if (!outgoing.writableEnded) abort.abort()
    })
    const request = new Request(`http://127.0.0.1${DEEPLINK_ROUTE}`, {
      method: 'GET',
      signal: abort.signal,
    })
    void handler(request).then(async (response) => {
      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      if (response.body === null) {
        outgoing.end()
        return
      }
      const reader = response.body.getReader()
      bodies.add(reader)
      try {
        // Sequential reads are the stream's contract: one read at a time.
        /* eslint-disable no-await-in-loop */
        for (;;) {
          const read = await reader.read()
          if (read.done) break
          outgoing.write(read.value)
        }
        /* eslint-enable no-await-in-loop */
        outgoing.end()
      } catch {
        outgoing.destroy()
      } finally {
        bodies.delete(reader)
      }
    }).catch(() => {
      outgoing.destroy()
    })
  })

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no bound port')

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    deliver(raw: string): void {
      if (deepLinks === undefined) throw new Error('deepLinks was not provided')
      deepLinks.deliver(raw)
    },
    async stop(): Promise<void> {
      // A streaming response never ends on its own, so `server.close()` would
      // wait for it forever. Cancel every body first, then close the server
      // and its lingering keep-alive sockets.
      await Promise.all([...bodies].map((body) => body.cancel().catch(() => undefined)))
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/**
 * Read frames from the streaming endpoint until `until` says enough arrived.
 *
 * @param origin - the bound server.
 * @param until - predicate over the frames collected so far.
 * @param trigger - runs once the connection is established.
 * @returns the frames read, in arrival order.
 */
async function readFrames(
  origin: string,
  until: (frames: string[]) => boolean,
  trigger: () => void,
): Promise<string[]> {
  const abort = new AbortController()
  const response = await fetch(`${origin}${DEEPLINK_ROUTE}`, { signal: abort.signal })
  expect(response.headers.get('content-type')).toBe('text/event-stream')

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: string[] = []
  let buffer = ''
  trigger()

  try {
    // Frames arrive one read at a time; the loop cannot be parallelised.
    /* eslint-disable no-await-in-loop */
    for (;;) {
      const read = await Promise.race([
        reader.read(),
        new Promise<{ done: true, value: undefined }>((resolve) => {
          const timer = setTimeout(() => { resolve({ done: true, value: undefined }) }, 2000)
          timer.unref?.()
        }),
      ])
      if (read.done) break
      buffer += decoder.decode(read.value)
      let cut: number
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        frames.push(buffer.slice(0, cut + 2))
        buffer = buffer.slice(cut + 2)
      }
      if (until(frames.filter((frame) => frame.startsWith('data: ')))) break
    }
    /* eslint-enable no-await-in-loop */
  } finally {
    abort.abort()
    // Cancel the body so the server's response stream closes and the
    // connection is released; aborting the fetch alone can leave the reader
    // queued behind a pending read.
    await reader.cancel().catch(() => undefined)
  }
  return frames
}

/** The URL one SSE frame carries, or undefined for a comment frame. */
function urlOf(frame: string): string | undefined {
  const match = /^data: (.*)\n\n$/s.exec(frame)
  if (match === null) return undefined
  return (JSON.parse(match[1]!) as { url: string }).url
}

/** The URLs among a batch of frames, ignoring the opening comment. */
function urlsOf(frames: readonly string[]): string[] {
  const urls: string[] = []
  for (const frame of frames) {
    const url = urlOf(frame)
    if (url !== undefined) urls.push(url)
  }
  return urls
}

describe('stream over HTTP', () => {
  let serving: Serving | undefined

  afterEach(async () => {
    await serving?.stop()
    serving = undefined
  })

  it('delivers a held link to the first connection', async () => {
    serving = await serve()
    serving.deliver('aishell://share/held')

    const frames = await readFrames(serving.origin, (f) => f.length >= 1, () => {})

    expect(urlsOf(frames)).toEqual(['aishell://share/held'])
  })

  it('pushes a link published after the connection is open', async () => {
    serving = await serve()
    const live = serving

    const frames = await readFrames(
      live.origin,
      (f) => f.length >= 1,
      () => { setTimeout(() => { live.deliver('aishell://share/live') }, 10) },
    )

    expect(urlsOf(frames)).toEqual(['aishell://share/live'])
  })

  it('keeps the connection open after a frame', async () => {
    serving = await serve()
    const live = serving

    const frames = await readFrames(
      live.origin,
      (f) => f.length >= 2,
      () => {
        setTimeout(() => { live.deliver('aishell://share/1') }, 10)
        setTimeout(() => { live.deliver('aishell://share/2') }, 30)
      },
    )

    expect(urlsOf(frames)).toEqual(['aishell://share/1', 'aishell://share/2'])
  })

  it('frees the stream when the client disconnects', async () => {
    serving = await serve()
    const live = serving

    await readFrames(live.origin, (f) => f.length >= 1, () => {
      setTimeout(() => { live.deliver('aishell://share/first') }, 10)
    })

    // The read helper aborted the connection on return. Give the server's
    // close notification a turn to reach the plugin before publishing, then
    // confirm the next connection receives the held link rather than a write
    // aimed at the dead stream.
    await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    live.deliver('aishell://share/second')

    const frames = await readFrames(live.origin, (f) => f.length >= 1, () => {})
    expect(urlsOf(frames)).toEqual(['aishell://share/second'])
  })
})