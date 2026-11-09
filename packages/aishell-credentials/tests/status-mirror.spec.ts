/**
 * The status mirror's behaviour across a refused settings write.
 *
 * The mirror (`recordedStored` / `recordedHint`) is what the reconciler reads
 * as its "already recorded" baseline and what the GET route answers
 * `accountName` from. It is updated *before* the async `ctx.settings.mutate`,
 * so the GET route can answer with the value just written without waiting for
 * the config flow-back.
 *
 * That ordering has one failure mode worth pinning: `mutate` can reject (the
 * profile patch file lock times out after 2s, an entry stops being
 * configurable, the plugin deactivates mid-write). If the mirror keeps the
 * value the document never received, `reconcile` reads it as "already
 * recorded", sends nothing on the next tick, and the divergence is permanent —
 * every server-side reader sees one status while the browser, which reads
 * `configForms` rather than this mirror, sees another.
 *
 * These specs drive the real `apply()` with a stub ctx: the mirror was moved
 * into a `mirrorOps` helper and given a rollback, and neither is observable
 * from `createCredentialRoutes` alone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { apply } from '../src/index.ts'

/** A SettingsPathOp-shaped write, as `recordStatus` takes them. */
type Op = { op: string, path: string[], value?: unknown }

/**
 * A ctx stub covering exactly what apply() touches. `mutate` records every
 * call and rejects when `failWrites` is set — the condition under test.
 */
function makeCtx(options: { failWrites: boolean }) {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const mutateCalls: Op[][] = []
  const warns: unknown[] = []
  const events = new Map<string, () => void>()

  const ctx = {
    fiber: { entry: { options: { id: 'aishell-client-credentials' } } },
    logger: { warn: (error: unknown) => { warns.push(error) } },
    settings: {
      mutate: (_ns: string, ops: Op[]) => {
        mutateCalls.push(ops)
        return options.failWrites
          ? Promise.reject(new Error('atomic-write: timed out waiting for the writer lock'))
          : Promise.resolve()
      },
      configure: () => {},
    },
    connection: {
      fetch: {
        register: (entry: { path: string, fetch: (request: Request) => Promise<Response> }) => {
          routes.set(entry.path, entry.fetch)
          return () => {}
        },
      },
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
    on: (event: string, handler: () => void) => { events.set(event, handler); return () => {} },
    emit: (event: string) => { events.get(event)?.() },
    get: () => undefined,
    // The `auth` tool registers behind a soft `tools` injection, so it is a
    // no-op when the registry is absent — this stub models exactly that. The
    // tool's own behaviour is covered in auth-tool.spec.ts.
    inject: () => {},
  }

  return { ctx, routes, mutateCalls, warns }
}

/** A Config-shaped object: the volatile getters apply() reads. */
function makeConfig(initial: { stored: boolean, hint: string }) {
  const box = { ...initial }
  return {
    box,
    config: {
      credentialsStored: { get: () => box.stored },
      accessKeyIdHint: { get: () => box.hint },
      lastError: { get: () => '' },
      // The full Config this plugin declares. `credentialRequestSession` was
      // removed when the tool-blocked form channel it served was replaced, and
      // a stub naming a field that no longer exists hides the ones that do:
      // the boot-time clear reads `credentialFormRequest`, and without it here
      // the failure read as an unrelated TypeError.
      credentialFormRequest: { get: () => '' },
      loginOutcome: { get: () => '' },
    },
  }
}

const CREDENTIALS = '/api/aishell/credentials'

function saveRequest(): Request {
  return new Request(`http://x${CREDENTIALS}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }),
  })
}

let fetchStub: ReturnType<typeof vi.fn>

beforeEach(() => {
  // verifyCredentials() signs and calls IAM through global fetch. Stub that so
  // the save path completes; the settings write that follows it is what these
  // specs are about.
  //
  // Both endpoints the shared verifier uses must be answered: `/v3/projects` is
  // the question ("are these valid, and what is the account id"), and
  // `/v3/auth/domains` is the best-effort name lookup. Answering only the
  // second leaves the verifier with no project and rejects the save for a
  // reason that has nothing to do with settings writes.
  fetchStub = vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (href.includes('/v3/projects')) {
      return new Response(JSON.stringify({
        projects: [{ id: 'project-1', name: 'cn-north-4', domain_id: 'domain-1' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('/v3/auth/domains')) {
      return new Response(JSON.stringify({ domains: [{ id: 'domain-1', name: 'hwc_test_account' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('credential status mirror — a refused settings write', () => {
  it('does not leave the mirror holding a value the document never got', async () => {
    const { ctx, routes, mutateCalls, warns } = makeCtx({ failWrites: true })
    const { config } = makeConfig({ stored: false, hint: '' })
    apply(ctx as never, config as never)

    const credentials = routes.get(CREDENTIALS)!
    const saved = await credentials(saveRequest())
    expect(saved.status).toBe(200)

    // The write was attempted and rejected.
    expect(mutateCalls.length).toBe(1)
    expect(warns.length).toBe(1)

    // The GET route answers `accountName` from the mirror. After a refused
    // write the document still holds the old status, so the route must not
    // report the account name the write failed to record — otherwise the two
    // readers disagree and reconcile believes there is nothing left to send.
    const status = await credentials(new Request(`http://x${CREDENTIALS}`))
    const body = await status.json() as { configured: boolean, accountName: string }
    expect(body.accountName).toBe('')
  })

  it('re-sends the status on the next reconcile tick after a failed write', async () => {
    const { ctx, routes, mutateCalls } = makeCtx({ failWrites: true })
    const { config } = makeConfig({ stored: false, hint: '' })
    apply(ctx as never, config as never)

    const credentials = routes.get(CREDENTIALS)!
    await credentials(saveRequest())
    const afterSave = mutateCalls.length

    // Every GET runs `reconciler.reconcile()` first. Because the mirror was
    // rolled back, the reconciler still sees "not recorded" and re-sends — the
    // failure is retried rather than becoming permanent.
    await credentials(new Request(`http://x${CREDENTIALS}`))
    expect(mutateCalls.length).toBeGreaterThan(afterSave)
  })

  it('keeps the mirror in step when the write succeeds (control)', async () => {
    const { ctx, routes, mutateCalls, warns } = makeCtx({ failWrites: false })
    const { config } = makeConfig({ stored: false, hint: '' })
    apply(ctx as never, config as never)

    const credentials = routes.get(CREDENTIALS)!
    await credentials(saveRequest())
    const afterSave = mutateCalls.length
    // The save's own status write, plus whatever the save's
    // `credentials-updated` emit drove through reconcile. Not pinned to an
    // exact count: the point is that none of them failed.
    expect(afterSave).toBeGreaterThan(0)
    expect(warns.length).toBe(0)

    const status = await credentials(new Request(`http://x${CREDENTIALS}`))
    const body = await status.json() as { configured: boolean, accountName: string }
    expect(body.accountName).toBe('hwc_test_account')

    // And the success is not re-sent: the mirror matches the document, so a
    // later reconcile has nothing to record. (The refused-write case above
    // shows the opposite, which is the behaviour the rollback exists for.)
    const before = mutateCalls.length
    await credentials(new Request(`http://x${CREDENTIALS}`))
    expect(mutateCalls.length).toBe(before)
  })
})
