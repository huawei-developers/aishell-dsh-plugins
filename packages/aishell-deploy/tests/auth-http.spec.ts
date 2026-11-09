/**
 * Where a signed request is allowed to go.
 *
 * The access key id rides in the `Authorization` header of every signed call,
 * and `openapi_request` takes the URL straight from the model. So the
 * destination is a security boundary, not a convenience check — verified
 * before this existed: a signed request to `http://127.0.0.1:<port>/steal`
 * arrived with `authorization: SDK-HMAC-SHA256 Access=AKIDEXAMPLE, ...`.
 *
 * These pin the boundary itself. The requests are refused before a socket
 * opens, so nothing here needs a network.
 */

import { describe, it, expect } from 'vitest'

import { denyUnsignedTarget, readCapped } from '../src/auth-http.ts'

describe('denyUnsignedTarget', () => {
  it('admits the endpoints this plugin calls', () => {
    for (const url of [
      'https://ecs.cn-north-4.myhuaweicloud.com/v1/proj/cloudservers',
      'https://bss.myhuaweicloud.com/v2/bills/ratings/on-demand-resources',
      'https://rms.myhuaweicloud.com/v1/resource-manager/domains/x/all-resources',
      'https://iam.cn-north-4.myhuaweicloud.com/v3/projects',
      'https://ims.cn-north-4.myhuaweicloud.com/v2/cloudimages',
      'https://obs.cn-north-4.myhuaweicloud.com/?prefix=a',
      'https://apiexplorer.cn-north-4.myhuaweicloud.com/v4/products',
    ]) {
      expect(denyUnsignedTarget(new URL(url)), url).toBeUndefined()
    }
  })

  it('refuses a host that only looks like the cloud domain', () => {
    // A suffix test without the leading dot would admit this, and the AK would
    // go with it.
    expect(denyUnsignedTarget(new URL('https://evilmyhuaweicloud.com/x'))).toMatch(/not a HuaweiCloud endpoint/)
    expect(denyUnsignedTarget(new URL('https://myhuaweicloud.com.evil.test/x'))).toMatch(/not a HuaweiCloud endpoint/)
    expect(denyUnsignedTarget(new URL('https://myhuaweicloud.com/x'))).toMatch(/not a HuaweiCloud endpoint/)
  })

  it('refuses any other host', () => {
    expect(denyUnsignedTarget(new URL('https://attacker.example/collect'))).toMatch(/not a HuaweiCloud endpoint/)
    expect(denyUnsignedTarget(new URL('http://127.0.0.1:8080/internal'))).toMatch(/not https|not a HuaweiCloud/)
  })

  it('refuses plain http anywhere, because the key would travel in the clear', () => {
    // HMAC signing offers nothing when the signature and the key id it was
    // derived from travel together unprotected.
    const refusal = denyUnsignedTarget(new URL('http://ecs.cn-north-4.myhuaweicloud.com/v1/x'))
    expect(refusal).toMatch(/not https/)
  })

  it('names the allowlist, so a caller can tell a typo from a missing entry', () => {
    expect(denyUnsignedTarget(new URL('https://ecs.cn-north-1.example.com/x')))
      .toMatch(/myhuaweicloud\.com/)
  })
})
describe('readCapped', () => {
  /** Serve one body of the given size and read it through the real cap. */
  async function serve(bytes: number, chunk = 64 * 1024): Promise<{ body: string, truncated: boolean }> {
    const { createServer } = await import('node:http')
    const url = await new Promise<string>((resolve) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        // Streamed in chunks, so the cap has to stop mid-body rather than
        // reject one oversized string.
        let sent = 0
        const pump = (): void => {
          while (sent < bytes) {
            const size = Math.min(chunk, bytes - sent)
            sent += size
            if (!res.write('x'.repeat(size))) {
              res.once('drain', pump)
              return
            }
          }
          res.end()
        }
        pump()
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number }
        resolve(`http://127.0.0.1:${address.port}/data`)
        server.on('close', () => server.unref())
      })
    })
    try {
      const response = await fetch(url)
      return await readCapped(response)
    } finally {
      // The server holds the socket until the body is drained or cancelled;
      // `readCapped` cancels on truncation, so this settles either way.
    }
  }

  it('keeps a body under the cap whole', async () => {
    const result = await serve(200 * 1024)
    expect(result.truncated).toBe(false)
    expect(result.body.length).toBe(200 * 1024)
  })

  it('stops a body over the cap, and says it did', async () => {
    // The tool returns this to the model. A cut body that claimed to be whole
    // would read as a complete inventory with most of it missing — verified
    // before the cap existed: `signedHttp` read `response.text()` with no limit
    // at all, so one `GET` of an account's whole record set filled the
    // conversation.
    const result = await serve(6 * 1024 * 1024)
    expect(result.truncated).toBe(true)
    expect(result.body.length).toBe(4 * 1024 * 1024)
  })

  it('reads an empty body as empty, not truncated', async () => {
    const result = await serve(0)
    expect(result).toEqual({ body: '', truncated: false })
  })

  it('answers for a response with no body at all', async () => {
    // A HEAD or a 204 carries a null stream, which is not an error.
    await expect(readCapped({ body: null })).resolves.toEqual({ body: '', truncated: false })
  })
})
