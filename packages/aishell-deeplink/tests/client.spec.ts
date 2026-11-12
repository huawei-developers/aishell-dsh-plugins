/**
 * The Page half: dispatch, claims, and the replay of early arrivals.
 *
 * Every case drives a frame through the stub transport and asserts what the
 * claimed handler received, or that nothing was dispatched.
 */

import { describe, expect, it } from 'vitest'

import { apply, MAX_WAITING, type AishellDeepLinks } from '../src/client/index.ts'
import { installStubEventSource, type StubEventSource } from './stub-event-source.ts'

/** The Page-half surface a test drives. */
interface Harness {
  readonly claims: AishellDeepLinks
  /** The live transport the plugin opened. */
  readonly source: () => StubEventSource
  readonly dispose: () => void
  readonly uninstall: () => void
}

function harness(): Harness {
  const stub = installStubEventSource()
  const disposers: (() => void)[] = []
  let claims: AishellDeepLinks | undefined

  const ctx = {
    provide: (name: string, value: AishellDeepLinks) => {
      if (name === 'aishellDeepLinks') claims = value
      return () => { claims = undefined }
    },
    effect: (make: () => unknown) => {
      const made = make()
      if (typeof made === 'function') disposers.push(made as () => void)
    },
  }

  apply(ctx as never)

  return {
    claims: claims!,
    source(): StubEventSource {
      const first = stub.sources()[0]
      if (first === undefined) throw new Error('no transport was opened')
      return first
    },
    dispose(): void {
      for (const dispose of disposers.reverse()) dispose()
    },
    uninstall: stub.uninstall,
  }
}

/** Publish one well-formed frame carrying a URL. */
function publish(source: StubEventSource, url: string): void {
  source.emit(JSON.stringify({ url }))
}

describe('Page half', () => {
  it('opens the stream at the documented route', () => {
    const test = harness()
    expect(test.source().url).toBe('api/aishell/deep-link')
    test.dispose()
    test.uninstall()
  })

  it('closes the transport when the effect is disposed', () => {
    const test = harness()
    const source = test.source()
    test.dispose()
    expect(source.closed).toBe(true)
    test.uninstall()
  })

  it('dispatches a link to the handler that claimed its family', () => {
    const test = harness()
    const seen: string[] = []
    test.claims.claim('share', (url) => { seen.push(url.href) })

    publish(test.source(), 'aishell://share/abc')

    expect(seen).toEqual(['aishell://share/abc'])
    test.dispose()
    test.uninstall()
  })

  it('leaves other families to their own claimant', () => {
    const test = harness()
    const share: string[] = []
    const connect: string[] = []
    test.claims.claim('share', (url) => { share.push(url.href) })
    test.claims.claim('connect', (url) => { connect.push(url.href) })

    publish(test.source(), 'aishell://connect/x')

    expect(share).toEqual([])
    expect(connect).toEqual(['aishell://connect/x'])
    test.dispose()
    test.uninstall()
  })

  it('replays a link that arrived before its family was claimed', () => {
    const test = harness()
    publish(test.source(), 'aishell://share/early')

    const seen: string[] = []
    test.claims.claim('share', (url) => { seen.push(url.href) })

    expect(seen).toEqual(['aishell://share/early'])
    test.dispose()
    test.uninstall()
  })

  it('replays only the current family on a late claim', () => {
    const test = harness()
    publish(test.source(), 'aishell://share/a')
    publish(test.source(), 'aishell://connect/b')

    const share: string[] = []
    test.claims.claim('share', (url) => { share.push(url.href) })

    expect(share).toEqual(['aishell://share/a'])

    const connect: string[] = []
    test.claims.claim('connect', (url) => { connect.push(url.href) })
    expect(connect).toEqual(['aishell://connect/b'])
    test.dispose()
    test.uninstall()
  })

  it('does not replay an early link to a second claimant', () => {
    const test = harness()
    publish(test.source(), 'aishell://share/once')
    test.claims.claim('share', () => {})

    const second: string[] = []
    // A second claim of the same family is refused; a different family sees none.
    test.claims.claim('other', (url) => { second.push(url.href) })

    expect(second).toEqual([])
    test.dispose()
    test.uninstall()
  })

  it('refuses a second claim of the same family', () => {
    const test = harness()
    test.claims.claim('share', () => {})
    expect(() => test.claims.claim('share', () => {})).toThrow(/already claimed/)
    test.dispose()
    test.uninstall()
  })

  it('accepts a family name in any case', () => {
    const test = harness()
    const seen: string[] = []
    test.claims.claim('SHARE', (url) => { seen.push(url.href) })

    publish(test.source(), 'aishell://Share/abc')

    expect(seen).toEqual(['aishell://Share/abc'])
    test.dispose()
    test.uninstall()
  })

  it('releases a family when its claim is disposed', () => {
    const test = harness()
    const release = test.claims.claim('share', () => {})
    release()

    const seen: string[] = []
    test.claims.claim('share', (url) => { seen.push(url.href) })
    publish(test.source(), 'aishell://share/abc')

    expect(seen).toEqual(['aishell://share/abc'])
    test.dispose()
    test.uninstall()
  })

  it('ignores a malformed frame without throwing', () => {
    const test = harness()
    const seen: string[] = []
    test.claims.claim('share', (url) => { seen.push(url.href) })
    const source = test.source()

    expect(() => source.emit('{')).not.toThrow()
    expect(() => source.emit('null')).not.toThrow()
    expect(() => source.emit(42)).not.toThrow()
    expect(() => source.emit(JSON.stringify({ url: 42 }))).not.toThrow()
    expect(() => source.emit(JSON.stringify({ url: 'https://x/y' }))).not.toThrow()

    expect(seen).toEqual([])
    test.dispose()
    test.uninstall()
  })

  it('keeps only the newest early links past the bound', () => {
    const test = harness()
    // Two past the bound, whatever the bound is: the assertion is about which
    // links survive, not about a number the test would have to keep in step.
    const sent = MAX_WAITING + 2
    for (let index = 0; index < sent; index++) publish(test.source(), `aishell://share/${index}`)

    const seen: string[] = []
    test.claims.claim('share', (url) => { seen.push(url.href) })

    const survived: string[] = []
    for (let index = sent - MAX_WAITING; index < sent; index++) {
      survived.push(`aishell://share/${index}`)
    }
    expect(seen).toEqual(survived)
    test.dispose()
    test.uninstall()
  })
})