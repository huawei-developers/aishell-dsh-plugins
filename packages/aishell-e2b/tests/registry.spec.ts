/**
 * The conversation's sandbox binding.
 *
 * One conversation, one sandbox — so the properties under test are about the
 * binding rather than about choosing between candidates:
 *
 *   - **The binding is created explicitly.** Nothing here invents a sandbox:
 *     the registry only ever answers "which one" or "none", because inventing
 *     one would mean choosing a template and a lifetime the operator never saw.
 *   - **It survives a restart.** The binding is recoverable from the sandbox's
 *     own metadata, which is what keeps a running sandbox from being orphaned
 *     when the process that created it goes away.
 *   - **Only a running sandbox is adopted.** A paused one would have to be
 *     resumed to be used, restarting its clock — a billing decision nobody
 *     made, so it is deliberately not taken.
 *   - **Gone is distinguished from never-had.** The two need different
 *     remedies, and only one of them means the work is unrecoverable.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  NO_SANDBOX_MESSAGE,
  SANDBOX_GONE_MESSAGE,
  SESSION_METADATA_KEY,
  SandboxRegistry,
  sessionMetadata,
} from '../src/sandbox-registry.ts'

/** Sandboxes the injected finder reports, in order of presentation. */
let found: Array<{ sandboxId: string, state: string }> = []
/** Metadata pairs the finder was asked for. */
let queries: Array<Record<string, string>> = []

/** A finder that reports whatever the spec queued. */
function finder(metadata: Record<string, string>): Promise<Array<{ sandboxId: string, state: string }>> {
  queries.push(metadata)
  return Promise.resolve(found)
}

beforeEach(() => {
  found = []
  queries = []
})

describe('SandboxRegistry — the in-memory binding', () => {
  it('answers the sandbox the conversation created', async () => {
    const registry = new SandboxRegistry(finder)
    registry.bind('s1', 'sbx-1')

    expect(await registry.resolve('s1')).toBe('sbx-1')
    // No lookup: the binding was already known, so no round trip was spent.
    expect(queries).toHaveLength(0)
  })

  it('rebinding replaces the previous sandbox rather than adding one', async () => {
    const registry = new SandboxRegistry(finder)
    registry.bind('s1', 'sbx-1')
    registry.bind('s1', 'sbx-2')

    expect(await registry.resolve('s1')).toBe('sbx-2')
  })

  it('keeps conversations separate', async () => {
    const registry = new SandboxRegistry(finder)
    registry.bind('s1', 'sbx-1')
    registry.bind('s2', 'sbx-2')

    expect(await registry.resolve('s2')).toBe('sbx-2')
    expect(await registry.resolve('s3')).toBeUndefined()
  })

  it('has nothing to bind for a call outside any conversation', async () => {
    const registry = new SandboxRegistry(finder)
    registry.bind(undefined, 'sbx-1')

    // Recorded nowhere: without a conversation to key on, no later call could
    // resolve it, so storing it would only be a leak.
    expect(await registry.resolve(undefined)).toBeUndefined()
  })

  it('drops a binding when the sandbox is gone', async () => {
    const registry = new SandboxRegistry(finder)
    registry.bind('s1', 'sbx-1')

    registry.forget('sbx-1')

    expect(registry.bound('s1')).toBeUndefined()
    // A resolve now falls through to the lookup, which reports nothing.
    expect(await registry.resolve('s1')).toBeUndefined()
  })
})

describe('SandboxRegistry — recovery after a restart', () => {
  it('rebuilds the binding from the sandbox metadata', async () => {
    found = [{ sandboxId: 'sbx-7', state: 'running' }]
    const registry = new SandboxRegistry(finder)

    // Nothing was bound in this process, so the answer comes from the lookup.
    expect(await registry.resolve('s1')).toBe('sbx-7')
    // The query names the conversation, and is therefore the tag the sandbox
    // has to have been created with.
    expect(queries).toEqual([{ [SESSION_METADATA_KEY]: 's1' }])
  })

  it('remembers a recovered binding instead of querying again', async () => {
    found = [{ sandboxId: 'sbx-7', state: 'running' }]
    const registry = new SandboxRegistry(finder)

    await registry.resolve('s1')
    await registry.resolve('s1')

    expect(queries).toHaveLength(1)
  })

  it('refuses to adopt a paused sandbox', async () => {
    // Adopting it would mean resuming it, which restarts its clock. That is a
    // billing decision, so it is left to the operator via aishell__sandbox_create.
    found = [{ sandboxId: 'sbx-7', state: 'paused' }]
    const registry = new SandboxRegistry(finder)

    expect(await registry.resolve('s1')).toBeUndefined()
  })

  it('prefers a running sandbox when several carry the same tag', async () => {
    found = [
      { sandboxId: 'sbx-old', state: 'paused' },
      { sandboxId: 'sbx-live', state: 'running' },
    ]
    const registry = new SandboxRegistry(finder)

    expect(await registry.resolve('s1')).toBe('sbx-live')
  })

  it('reports nothing when no sandbox carries the tag', async () => {
    const registry = new SandboxRegistry(finder)

    expect(await registry.resolve('s1')).toBeUndefined()
  })
})

describe('sessionMetadata', () => {
  it('tags the sandbox with its conversation', () => {
    expect(sessionMetadata('s1', undefined)).toEqual({ [SESSION_METADATA_KEY]: 's1' })
  })

  it('keeps operator-supplied labels alongside the conversation tag', () => {
    expect(sessionMetadata('s1', { team: 'a' })).toEqual({
      [SESSION_METADATA_KEY]: 's1',
      team: 'a',
    })
  })

  it('contributes nothing when there is no conversation and no label', () => {
    // Undefined rather than an empty object: an empty metadata map would be
    // written to the sandbox as a present-but-empty value.
    expect(sessionMetadata(undefined, undefined)).toBeUndefined()
  })

  it('still carries operator labels without a conversation', () => {
    expect(sessionMetadata(undefined, { team: 'a' })).toEqual({ team: 'a' })
  })
})

describe('the failure messages', () => {
  it('names aishell__sandbox_create when the conversation has no sandbox', () => {
    expect(NO_SANDBOX_MESSAGE).toMatch(/aishell__sandbox_create/)
    // And does not offer to create one implicitly: the model owns the template
    // and lifetime choices, and cannot make them from inside this failure.
    expect(NO_SANDBOX_MESSAGE).toMatch(/lifetime|choosing/)
  })

  it('says the contents are gone when the sandbox expired', () => {
    // Distinct from the message above, because only this case means the work
    // in the previous sandbox is unrecoverable.
    expect(SANDBOX_GONE_MESSAGE).toMatch(/no longer exists/)
    expect(SANDBOX_GONE_MESSAGE).toMatch(/contents are gone/)
  })
})