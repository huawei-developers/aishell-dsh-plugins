/**
 * The dialog's state machine: what a reader sees at each step.
 *
 * Driven through its public actions with stub Host calls, so the assertions are
 * on the state a component would render rather than on internals.
 */

import { describe, expect, it, vi } from 'vitest'

import { createShareMachine, type ShareDriver } from '../src/client/machine.ts'
import type { SharePackage } from '../src/package.ts'

/** A package with one turn. */
const PKG: SharePackage = {
  version: '0.0.21',
  title: 'Shared',
  createdAt: 1,
  events: [{ type: 'user/message', data: {} }],
}

/** A driver whose every call succeeds. */
function okDriver(overrides: Partial<ShareDriver> = {}): ShareDriver {
  return {
    share: async () => ({ ok: true, url: 'aishell://share/session/abc' }),
    fetch: async () => ({ ok: true, session: PKG }),
    import: async () => ({ ok: true, sessionId: 's-new' }),
    open: () => {},
    copy: async () => true,
    workspaces: () => [{ id: 'w-1', title: 'Project', path: '/work/project' }],
    pickWorkspace: async () => '/work/other',
    ...overrides,
  }
}

const LINK = 'aishell://share/session/abc'

describe('sharing', () => {
  it('opens on the confirmation, having sent nothing', () => {
    const machine = createShareMachine(okDriver())
    machine.shareSession('s-1')

    expect(machine.getSnapshot()).toEqual({ kind: 'confirm-share', sessionId: 's-1' })
  })

  it('moves to working when confirmed, then shows the link', async () => {
    const machine = createShareMachine(okDriver())
    machine.shareSession('s-1')
    machine.confirmShare()

    expect(machine.getSnapshot().kind).toBe('sharing')

    await vi.waitFor(() => {
      expect(machine.getSnapshot().kind).toBe('shared')
    })
    expect(machine.getSnapshot()).toMatchObject({ url: 'aishell://share/session/abc' })
  })

  it('does not upload until the confirmation is pressed', async () => {
    const share = vi.fn(async () => ({ ok: true as const, url: LINK }))
    const machine = createShareMachine({ ...okDriver(), share })

    machine.shareSession('s-1')
    await Promise.resolve()

    expect(share).not.toHaveBeenCalled()
  })

  it('passes the session id the reader chose', async () => {
    const share = vi.fn(async () => ({ ok: true as const, url: LINK }))
    const machine = createShareMachine({ ...okDriver(), share })

    machine.shareSession('s-42')
    machine.confirmShare()
    await vi.waitFor(() => { expect(share).toHaveBeenCalledWith('s-42', undefined, expect.any(AbortSignal)) })
  })

  it('reports an accepted copy without changing the card', async () => {
    const machine = createShareMachine(okDriver())
    machine.shareSession('s-1')
    machine.confirmShare()
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('shared') })
    const before = machine.getSnapshot()

    expect(await machine.copyLink()).toBe(true)

    // The banner is the caller's to raise; the state itself must not move, or
    // the link would jump while the reader is still looking at it.
    expect(machine.getSnapshot()).toBe(before)
  })

  it('reports a refused copy so the caller can stay silent about it', async () => {
    const machine = createShareMachine({ ...okDriver(), copy: async () => false })
    machine.shareSession('s-1')
    machine.confirmShare()
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('shared') })

    // A refused write still leaves the link on screen to be selected by hand;
    // saying "copied" over it would take away the reader's only cue.
    expect(await machine.copyLink()).toBe(false)
  })

  it('reports a failed upload with the stage it failed in', async () => {
    const machine = createShareMachine({
      ...okDriver(),
      share: async () => ({ ok: false, reason: 'too-large' }),
    })
    machine.shareSession('s-1')
    machine.confirmShare()

    await vi.waitFor(() => {
      expect(machine.getSnapshot()).toEqual({ kind: 'failed', stage: 'share', reason: 'too-large' })
    })
  })
})

describe('importing', () => {
  it('opens on fetching and lands on the preview, which carries the package', async () => {
    const machine = createShareMachine(okDriver())
    machine.openLink(LINK)

    expect(machine.getSnapshot()).toEqual({ kind: 'fetching', link: LINK })

    await vi.waitFor(() => {
      // The URL is gone once the package is here: the import acts on what the
      // reader was shown, not on a link to fetch again.
      expect(machine.getSnapshot()).toEqual({ kind: 'preview', session: PKG })
    })
  })

  it('writes nothing until the import is pressed', async () => {
    const importFn = vi.fn(async () => ({ ok: true as const, sessionId: 's-new' }))
    const machine = createShareMachine({ ...okDriver(), import: importFn })

    machine.openLink(LINK)
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('preview') })
    await Promise.resolve()

    expect(importFn).not.toHaveBeenCalled()
  })

  it('closes once the copy exists', async () => {
    const machine = createShareMachine(okDriver())
    machine.openLink(LINK)
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('preview') })

    machine.importPreview()
    machine.importInto('/work/project')
    expect(machine.getSnapshot().kind).toBe('importing')

    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('closed') })
  })

  it('asks where the copy should land before importing', async () => {
    const machine = createShareMachine(okDriver())
    machine.openLink(LINK)
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('preview') })

    machine.importPreview()

    expect(machine.getSnapshot()).toMatchObject({
      kind: 'choose-workspace',
      workspaces: [{ id: 'w-1', title: 'Project', path: '/work/project' }],
    })
  })

  it('files the copy under the workspace the reader picked', async () => {
    const importFn = vi.fn(async () => ({ ok: true as const, sessionId: 's-new' }))
    const machine = createShareMachine({ ...okDriver(), import: importFn })

    machine.openLink(LINK)
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('preview') })
    machine.importPreview()
    machine.importInto('/work/project')

    await vi.waitFor(() => { expect(importFn).toHaveBeenCalledWith(PKG, '/work/project', expect.any(AbortSignal)) })
  })

  it('opens the copy once it exists', async () => {
    const open = vi.fn()
    const machine = createShareMachine(okDriver({ open }))

    machine.openLink(LINK)
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('preview') })
    machine.importPreview()
    machine.importInto('/work/project')

    await vi.waitFor(() => { expect(open).toHaveBeenCalledWith('s-new') })
  })

  it('does not open anything when the import fails', async () => {
    const open = vi.fn()
    const machine = createShareMachine(okDriver({
      open,
      import: async () => ({ ok: false as const, reason: 'rejected' as const }),
    }))

    machine.openLink(LINK)
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('preview') })
    machine.importPreview()
    machine.importInto('/work/project')

    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('failed') })
    expect(open).not.toHaveBeenCalled()
  })

  it('offers the directory picker when the reader browses', async () => {
    const importFn = vi.fn(async () => ({ ok: true as const, sessionId: 's-new' }))
    const machine = createShareMachine({ ...okDriver(), import: importFn })

    machine.openLink(LINK)
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('preview') })
    machine.importPreview()
    await machine.browseForWorkspace()

    await vi.waitFor(() => { expect(importFn).toHaveBeenCalledWith(PKG, '/work/other', expect.any(AbortSignal)) })
  })

  it('stays put when the reader cancels the directory picker', async () => {
    const importFn = vi.fn(async () => ({ ok: true as const, sessionId: 's-new' }))
    const machine = createShareMachine({
      ...okDriver(),
      import: importFn,
      pickWorkspace: async () => undefined,
    })

    machine.openLink(LINK)
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('preview') })
    machine.importPreview()
    await machine.browseForWorkspace()

    expect(machine.getSnapshot().kind).toBe('choose-workspace')
    expect(importFn).not.toHaveBeenCalled()
  })

  it('passes the id from the link', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true as const, session: PKG }))
    const machine = createShareMachine({ ...okDriver(), fetch: fetchFn })

    machine.openLink(LINK)
    await vi.waitFor(() => { expect(fetchFn).toHaveBeenCalledWith('abc', expect.any(AbortSignal)) })
  })

  it('reports an unavailable link without writing anything', async () => {
    const importFn = vi.fn(async () => ({ ok: true as const, sessionId: 'x' }))
    const machine = createShareMachine({
      ...okDriver(),
      fetch: async () => ({ ok: false, reason: 'unavailable' }),
      import: importFn,
    })

    machine.openLink(LINK)
    await vi.waitFor(() => {
      expect(machine.getSnapshot()).toEqual({ kind: 'failed', stage: 'import', reason: 'unavailable' })
    })
    expect(importFn).not.toHaveBeenCalled()
  })

  it('ignores a link whose path names no id', async () => {
    const machine = createShareMachine(okDriver())
    machine.openLink('aishell://share/session')

    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('failed') })
  })
})

describe('closing', () => {
  it('closes from any open state', async () => {
    const machine = createShareMachine(okDriver())
    machine.openLink(LINK)

    machine.close()

    expect(machine.getSnapshot()).toEqual({ kind: 'closed' })
  })

  it('notifies subscribers on each transition', async () => {
    const machine = createShareMachine(okDriver())
    let changes = 0
    machine.subscribe(() => { changes += 1 })

    machine.shareSession('s-1')
    machine.close()

    expect(changes).toBe(2)
  })
})
describe('closing while a request is in flight', () => {
  /** A promise the test releases when it wants the request to answer. */
  function gated<T>(value: T): { promise: Promise<T>, release: () => void } {
    let release: (() => void) | undefined
    const promise = new Promise<T>((resolve) => { release = () => { resolve(value) } })
    return { promise, release: () => { release?.() } }
  }

  /** Let a settled promise's continuation run. */
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10) })

  it('does not open a session whose import the reader cancelled', async () => {
    const gate = gated({ ok: true as const, sessionId: 's-new' })
    const open = vi.fn()
    const machine = createShareMachine(okDriver({ open, import: () => gate.promise }))

    machine.openLink(LINK)
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('preview') })
    machine.importPreview()
    machine.importInto('/work/project')
    expect(machine.getSnapshot().kind).toBe('importing')

    machine.close()
    gate.release()
    await settle()

    // The copy exists — the Host wrote it — but navigating a reader who
    // dismissed the card takes them somewhere they did not ask to go.
    expect(open).not.toHaveBeenCalled()
    expect(machine.getSnapshot().kind).toBe('closed')
  })

  it('does not reopen the card when a dismissed upload finishes', async () => {
    const gate = gated({ ok: true as const, url: 'aishell://share/session/old' })
    const machine = createShareMachine(okDriver({ share: () => gate.promise }))

    machine.shareSession('s-1')
    machine.confirmShare()
    machine.close()
    expect(machine.getSnapshot().kind).toBe('closed')

    gate.release()
    await settle()

    expect(machine.getSnapshot().kind).toBe('closed')
  })

  it('does not paint a stale answer over the link the reader opened next', async () => {
    const gate = gated({ ok: true as const, url: 'aishell://share/session/old' })
    const machine = createShareMachine(okDriver({
      share: () => gate.promise,
      fetch: () => new Promise(() => {}),
    }))

    machine.shareSession('s-1')
    machine.confirmShare()
    machine.close()
    machine.openLink('aishell://share/session/new')
    expect(machine.getSnapshot().kind).toBe('fetching')

    gate.release()
    await settle()

    expect(machine.getSnapshot().kind).toBe('fetching')
  })
})

describe('closing cancels the request', () => {
  it('aborts the upload in flight', async () => {
    let signal: AbortSignal | undefined
    const machine = createShareMachine(okDriver({
      share: (_id, _messageId, received) => { signal = received; return new Promise(() => {}) },
    }))

    machine.shareSession('s-1')
    machine.confirmShare()
    expect(signal?.aborted).toBe(false)

    machine.close()

    // The abort reaches the Host as `request.signal`, which is what stops the
    // transfer; without it, "cancel" would only stop the dialog watching.
    expect(signal?.aborted).toBe(true)
  })

  it('aborts the import in flight', async () => {
    let signal: AbortSignal | undefined
    const machine = createShareMachine(okDriver({
      import: (_session, _cwd, received) => { signal = received; return new Promise(() => {}) },
    }))

    machine.openLink(LINK)
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('preview') })
    machine.importPreview()
    machine.importInto('/work/project')
    expect(signal?.aborted).toBe(false)

    machine.close()

    expect(signal?.aborted).toBe(true)
  })

  it('aborts the download when the reader dismisses the loading state', async () => {
    let signal: AbortSignal | undefined
    const machine = createShareMachine(okDriver({
      fetch: (_id, received) => { signal = received; return new Promise(() => {}) },
    }))

    machine.openLink(LINK)
    machine.close()

    expect(signal?.aborted).toBe(true)
  })

  it('aborts the previous request when a new dialog opens over it', async () => {
    let uploading: AbortSignal | undefined
    const machine = createShareMachine(okDriver({
      share: (_id, _messageId, received) => { uploading = received; return new Promise(() => {}) },
      fetch: () => new Promise(() => {}),
    }))

    machine.shareSession('s-1')
    machine.confirmShare()
    machine.openLink(LINK)

    expect(uploading?.aborted).toBe(true)
  })

  it('does not abort a request that already settled', async () => {
    let signal: AbortSignal | undefined
    const machine = createShareMachine(okDriver({
      share: async (_id, _messageId, received) => { signal = received; return { ok: true as const, url: LINK } },
    }))

    machine.shareSession('s-1')
    machine.confirmShare()
    await vi.waitFor(() => { expect(machine.getSnapshot().kind).toBe('shared') })

    machine.close()

    // Closing a finished dialog must not reach back into a completed request.
    expect(signal?.aborted).toBe(false)
  })
})
