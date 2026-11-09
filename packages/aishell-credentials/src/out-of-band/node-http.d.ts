/**
 * Ambient surface for `node:http` — exactly what the loopback callback
 * listener uses, and nothing more.
 *
 * ## Why this exists instead of `@types/node`
 *
 * This package is dual-half: `src/index.ts` is the Node host plugin and
 * `src/client/` is browser code, and both are built from one tsconfig. That
 * tsconfig sets `types: []` deliberately — without it the browser half would
 * typecheck against Node globals it cannot use, and the DOM lib it does need
 * would be joined by a process/fs surface that does not exist in a page.
 *
 * The callback listener is the first host-only code here that needs a Node
 * builtin. Turning `@types/node` on for the whole package to get it would
 * undo that decision for the browser half; splitting the package into two
 * composite projects is a larger change than one declaration file, and this
 * repo already answers the same problem this way — see
 * `credentials-store/src/node-machine-id.d.ts`, which declares a module whose
 * shipped types do not fit how the code imports it.
 *
 * ## Why it is narrow
 *
 * An ambient module declaration replaces the real one outright, so anything
 * omitted here becomes a type error at its use site rather than a silent
 * `any`. That is the point: the listener gets checked against the shape below,
 * and a future edit that reaches for a different HTTP API fails the build
 * instead of quietly losing its types.
 *
 * Signatures follow the real module's observable behavior for this use:
 * `on` returns `this` for chaining, `listen`/`close` return the server, and
 * `address()` is the union the real one is.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/out-of-band/node-http
 */

declare module 'node:http' {
  /** A chunk of a request body. */
  export interface Buffer {
    readonly length: number
    toString(encoding?: string): string
  }

  /** The request half of one exchange. */
  export interface IncomingMessage {
    /** Uppercase method, absent on a malformed request line. */
    readonly method?: string
    /** Origin-form target, e.g. `/probe?n=x`. */
    readonly url?: string
    /** Header names lowercased; a repeated header arrives as an array. */
    readonly headers: Record<string, string | string[] | undefined>
    on(event: 'data', listener: (chunk: Buffer) => void): this
    on(event: 'end', listener: () => void): this
    on(event: 'error', listener: (error: Error) => void): this
    /** Suspend `data` delivery without tearing the socket down. */
    pause(): this
    /** Stop reading and tear the socket down. */
    destroy(): void
  }

  /** The response half of one exchange. */
  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string | number>): this
    end(data?: string): void
  }

  /** Result of `address()` on a bound server. */
  export interface AddressInfo {
    readonly address: string
    readonly family: string
    readonly port: number
  }

  /** A listening or bindable HTTP server. */
  export interface Server {
    /**
     * Bind and listen.
     *
     * @param port - 0 asks the OS for a free one, which is what the callback
     *   listener wants: the port is not a secret, but a fixed one can be taken.
     * @param host - the loopback address; the contract requires the callback
     *   to land on the machine the browser runs on.
     * @param callback - invoked once bound; a bind failure arrives on `error`.
     */
    listen(port: number, host: string, callback?: () => void): this
    close(callback?: (error?: Error) => void): this
    address(): AddressInfo | string | null
    on(event: 'listening', listener: () => void): this
    on(event: 'error', listener: (error: Error) => void): this
  }

  /** Create a server from a request handler. */
  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Server
}
