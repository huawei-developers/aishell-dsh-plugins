/**
 * Putting an imported session into the Workspace the reader chose.
 *
 * The failure this pins is quiet: the copy is written, the import reports
 * success, and the session shows up under "ungrouped" because membership is an
 * explicit registry list rather than something derived from the header. Nothing
 * throws, so nothing else would catch it.
 *
 * The second half matters just as much: an attach that fails must not turn a
 * successful import into a failed one. The conversation arrived; only its place
 * in a group is missing.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { attachToWorkspace } from '../src/attach.ts'

/** A context whose `get` answers with the given registry. */
function hostWith(registry: unknown): Context {
  return { get: (name: string) => (name === 'workspaceRegistry' ? registry : undefined) } as unknown as Context
}

/** A logger that records what it was told. */
function recorder(): { warn: (message: string) => void, messages: string[] } {
  const messages: string[] = []
  return { messages, warn: (message: string) => { messages.push(message) } }
}

describe('attachToWorkspace', () => {
  it('attaches the session to the Workspace with the chosen directory', async () => {
    const attach = vi.fn(async () => {})
    const registry = {
      list: () => [
        { path: '/work/other', attachSession: vi.fn() },
        { path: '/work/project', attachSession: attach },
      ],
    }

    await attachToWorkspace(hostWith(registry), 'session-1', '/work/project', recorder())

    expect(attach).toHaveBeenCalledWith('session-1')
  })

  it('does nothing when the deployment has no Workspace registry', async () => {
    // A composition without Workspaces has no groups to join, and requiring
    // the service would refuse to load the plugin over a sidebar feature it
    // does not need.
    const log = recorder()
    await expect(attachToWorkspace(hostWith(undefined), 'session-1', '/work/project', log)).resolves.toBeUndefined()
    expect(log.messages).toEqual([])
  })

  it('reports a directory no Workspace owns, and does not attach elsewhere', async () => {
    // Attaching to *some* Workspace would file the copy where the reader did
    // not choose. The log is the only place this can be noticed.
    const attach = vi.fn(async () => {})
    const registry = { list: () => [{ path: '/work/project', attachSession: attach }] }
    const log = recorder()

    await attachToWorkspace(hostWith(registry), 'session-1', '/work/gone', log)

    expect(attach).not.toHaveBeenCalled()
    expect(log.messages.join('\n')).toContain('/work/gone')
  })

  it('keeps an import successful when attaching fails', async () => {
    // The session is written and openable. Surfacing this as a failed import
    // would tell the reader their conversation did not arrive when it did.
    const registry = {
      list: () => [{
        path: '/work/project',
        attachSession: async () => { throw new Error('header does not resolve') },
      }],
    }
    const log = recorder()

    await expect(attachToWorkspace(hostWith(registry), 'session-1', '/work/project', log))
      .resolves.toBeUndefined()
    expect(log.messages.join('\n')).toContain('header does not resolve')
    expect(log.messages.join('\n')).toContain('session-1')
  })
})