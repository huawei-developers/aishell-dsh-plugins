/**
 * Deep-link transport, Host half.
 *
 * Pure transport: it admits a URL and hands it to the Page, and does nothing
 * else. It has no registry of link families, because the families are claimed
 * in the Page — a process this side cannot see. Filtering here would drop
 * links the Page would have accepted.
 *
 * Delivery is a server-sent-events stream rather than a queue the Page polls.
 * The Page cannot poll usefully: when the desktop window already has focus the
 * cursor never moves, and the IPC hop that carries the URL is asynchronous
 * while the focus call is not, so a fetch triggered by focus runs before the
 * URL exists.
 *
 * @module @huaweidevtools/aishell-dsh-deeplink
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.connection merge (the authenticated fetch registry).
import type {} from '@deepseek-ai/dsh-client-connection'

import { admit, type DeepLink } from './link.ts'
import { DEEPLINK_ROUTE } from './route.ts'

export { admit, SCHEME, type DeepLink } from './link.ts'
export { DEEPLINK_ROUTE, DEEPLINK_CLIENT_ROUTE } from './route.ts'

export const name = 'aishell-deeplink'

/**
 * Required services.
 *
 * `connection` is where the stream route registers. Without it the URL has
 * nowhere to go, so a deployment missing it fails at load instead of silently
 * accepting links that vanish.
 */
export const inject = ['connection']

/**
 * URLs held while no Page is connected.
 *
 * A cold start delivers the URL before the window exists, so the first launch
 * always lands here.
 *
 * The bound converts "unbounded growth" into "some links are lost". A flood
 * cannot be told from a burst of real clicks: recognising a URL as legitimate
 * requires knowing its family, and the families are claimed in the Page. The
 * process surviving matters more than every link arriving — this runs inside
 * the Host, and a Host that dies takes the application with it.
 *
 * This buffer covers the span from the Host becoming ready to the Page's stream
 * connecting: seconds, during which a person can click a link or two. 16 sits
 * well above that and far below anything the process would notice. The number
 * is this buffer's own; other buffers in the chain cover different spans and
 * carry their own.
 *
 * The newest are kept — a user who clicked five links wants the last one.
 */
export const MAX_PENDING = 16

/** One open Page stream. */
interface Stream {
  readonly controller: ReadableStreamDefaultController<Uint8Array>
}

/**
 * An SSE comment, sent when a stream opens.
 *
 * `fetch` and `EventSource` do not resolve a response until its first byte
 * arrives, so a stream that opens with nothing to say would leave the Page
 * waiting and never — from its side — connected. A comment is ignored by the
 * event parser and carries no event, so it costs nothing to send.
 */
const OPENING_FRAME = new TextEncoder().encode(': open\n\n')

/**
 * Encode one event for the `text/event-stream` framing.
 *
 * @param link - the admitted link.
 * @returns the encoded frame, including its terminating blank line.
 */
function frame(link: DeepLink): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify({ url: link.href })}\n\n`)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The deep-link delivery surface, provided by this plugin and consumed by
     * the desktop shell's Host half. One method, one string.
     */
    deepLinks: DeepLinks
  }
}

/** What the desktop shell delivers URLs through. */
export interface DeepLinks {
  /**
   * Accept one URL the operating system handed to the shell.
   *
   * The string is passed through untouched by the caller: this side is where
   * it is first parsed. A URL this transport does not own is dropped.
   *
   * @param raw - the URL exactly as received, e.g. `aishell://share/abc123`.
   */
  deliver(raw: string): void
}

export function apply(ctx: Context): void {
  const log = ctx.logger('aishell-deeplink')

  const streams = new Set<Stream>()
  const pending: DeepLink[] = []

  const push = (link: DeepLink): void => {
    if (streams.size === 0) {
      pending.push(link)
      if (pending.length > MAX_PENDING) pending.shift()
      return
    }
    const payload = frame(link)
    for (const stream of streams) {
      try {
        stream.controller.enqueue(payload)
      } catch {
        // The stream is closing; the abort handler removes it.
        streams.delete(stream)
      }
    }
  }

  ctx.provide('deepLinks', {
    deliver(raw: string): void {
      const link = admit(raw)
      if (link === undefined) {
        log.warn(`dropped a URL this transport does not own: ${raw}`)
        return
      }
      push(link)
    },
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path: DEEPLINK_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request: Request): Promise<Response> => {
      let stream: Stream
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = { controller }
          // Flush the response before anything is held, so the Page's
          // EventSource reports open and a later push has somewhere to go.
          controller.enqueue(OPENING_FRAME)
          streams.add(stream)
          // Shift rather than splice: a batch removed up front would be lost
          // entirely if a later enqueue threw on the same dead controller.
          while (pending.length > 0) {
            const link = pending.shift()
            if (link === undefined) break
            controller.enqueue(frame(link))
          }
        },
        cancel() {
          streams.delete(stream)
        },
      })
      request.signal.addEventListener('abort', () => {
        streams.delete(stream)
        try {
          stream.controller.close()
        } catch {
          // Already closed or errored; nothing to release.
        }
      })
      return Promise.resolve(new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
      }))
    },
  }), 'aishell-deeplink: stream route')
}