/**
 * The `auth` tool — verify the stored credentials and report the account.
 *
 * What matters here, in order of how much damage getting it wrong does:
 *
 *   1. With no credentials it fails with a real error, not an empty success.
 *      A model that reads "ok" from a verification which verified nothing goes
 *      on to plan work against an account nobody is signed in to.
 *   2. It never writes the store. Credentials enter through the form's route,
 *      which verifies before writing; a tool writing them would be a
 *      model-triggered path into the keyring.
 *   3. A rejected credential surfaces IAM's reason, unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryBackend } from '@huaweidevtools/aishell-dsh-credentials-store'
import { writeHuaweiCloud } from '@huaweidevtools/aishell-dsh-credentials-store/accounts'

/** What the stubbed verifier answers. */
let verdict: unknown = {
  ok: true,
  account: {
    accountId: 'acc-1',
    name: 'example-corp',
    projects: [
      { id: 'p-1', name: 'cn-north-4' },
      { id: 'p-2', name: 'ap-southeast-3', description: 'production' },
    ],
  },
  region: 'cn-north-4',
  sts: false,
}
/** The credentials the verifier was handed. */
let verifiedWith: unknown = undefined

vi.mock('@huaweidevtools/aishell-dsh-credentials-store/verify', () => ({
  verifyCredentials: async (credentials: unknown) => {
    verifiedWith = credentials
    return verdict
  },
}))

const { registerAuthTool, AUTH_TOOL_NAME } = await import('../src/auth-tool.ts')

/** Definitions registered on a stub tool registry. */
let definitions: Array<{
  name: string
  parameters: Record<string, unknown>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string, text: string }> }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}> = []

/** Sessions the tool asked to open the form in, in order. */
let formRequests: string[] = []
/**
 * Resolvers of the forms the tool is waiting on, oldest first.
 *
 * The tool blocks on a form, so a test drives it by resolving one. A queue that
 * stays non-empty models a person who has not answered: the call remains
 * pending, which is the behaviour under test in the "waits" cases.
 */
let pendingResolvers: Array<(outcome: unknown) => void> = []
/**
 * Whether the tool gave a shared form back after it stopped waiting.
 *
 * The host keeps one pending request across concurrent callers, so a call that
 * walks away without releasing it strands the next one: no form is written, so
 * none appears. See the `abandoned call` cases.
 */
let releases: boolean[] = []
let discards: boolean[] = []

/**
 * Answer the oldest unanswered form.
 *
 * @param kind - what the person did.
 */
function answerForm(kind: 'submitted' | 'cancelled'): void {
  const settle = pendingResolvers.shift()
  if (settle === undefined) throw new Error('the tool was not waiting on a form')
  settle({ kind })
}

/** Execution context carrying a session, as the agent loop supplies one. */
const inSession = (id: string): unknown => ({ agent: { session: { id } } })

/** Register the tool into a stub context holding `store`. */
function mount(store: MemoryBackend, hasTools: boolean = true): void {
  const ctx = {
    inject: (deps: string[], fn: (scope: unknown) => void) => {
      if (!hasTools || !deps.includes('tools')) return
      fn({
        tools: {
          register: (definition: (typeof definitions)[number]) => {
            definitions.push(definition)
            return () => {}
          },
        },
      })
    },
  }
  registerAuthTool(ctx as never, store, {
    requestForm: (sessionId) => {
      formRequests.push(sessionId)
      let settle: (outcome: unknown) => void = () => {}
      const outcome = new Promise((resolve) => { settle = resolve as never })
      pendingResolvers.push(settle)
      return outcome as never
    },
    // Mirrors the host's bookkeeping: a call that stops waiting gives the
    // shared request back. Recorded so a test can assert the release happened.
    releaseForm: () => { releases.push(true) },
    // A refused credential is cleared before the form opens, so the form asks
    // for a pair instead of showing one that cannot work.
    discard: () => { discards.push(true) },
  })
}

/** The one registered definition. */
function tool() {
  const found = definitions.find(definition => definition.name === AUTH_TOOL_NAME)
  if (found === undefined) throw new Error('auth tool was not registered')
  return found
}

beforeEach(() => {
  definitions = []
  formRequests = []
  pendingResolvers = []
  releases = []
  discards = []
  verifiedWith = undefined
  verdict = {
    ok: true,
    account: {
      accountId: 'acc-1',
      name: 'example-corp',
      projects: [
        { id: 'p-1', name: 'cn-north-4' },
        { id: 'p-2', name: 'ap-southeast-3', description: 'production' },
      ],
    },
    region: 'cn-north-4',
    sts: false,
  }
})

describe('auth tool — registration', () => {
  it('registers under the aishell namespace, with no parameters', () => {
    mount(new MemoryBackend())

    expect(tool().name).toBe('aishell__auth')
    // An empty object rather than an omitted field: the model reads "takes no
    // arguments" explicitly instead of inferring it.
    expect(tool().parameters).toMatchObject({ type: 'object', properties: {} })
  })

  it('is a no-op when the tool registry is absent', () => {
    // A headless host serving only the credential route must lose the tool,
    // not lose credential management.
    expect(() => { mount(new MemoryBackend(), false) }).not.toThrow()
    expect(definitions).toHaveLength(0)
  })
})

describe('auth tool — verification', () => {
  it('verifies the stored pair and reports the account', async () => {
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    mount(store)

    await expect(tool().execute({}, inSession('session-1'))).resolves.toMatchObject({
      authenticated: true,
      account: { accountId: 'acc-1', name: 'example-corp' },
      sts: false,
    })
    // The pair handed to the verifier is the pair in the store, not a copy
    // cached at registration.
    expect(verifiedWith).toEqual({ ak: 'AK1', sk: 'SK1' })
  })

  it('does not write the store', async () => {
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    const set = vi.spyOn(store, 'set')
    mount(store)

    await tool().execute({}, inSession('session-1'))

    expect(set).not.toHaveBeenCalled()
  })

  it('opens the form instead of failing when no credentials are stored', async () => {
    // It does not fail — it waits. A rejection here would tell the model the
    // tool is done, and the person would never have been asked.
    mount(new MemoryBackend())

    const call = tool().execute({}, inSession('session-1'))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(formRequests).toEqual(['session-1'])
    // Nothing was sent anywhere — a request without a signature could only
    // fail at IAM, and would report the wrong cause.
    expect(verifiedWith).toBeUndefined()

    answerForm('cancelled')
    await expect(call).rejects.toThrow(/cancelled/)
  })

  it('opens the form when only half the pair is stored', async () => {
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: '' })
    mount(store)

    const call = tool().execute({}, inSession('session-1'))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(formRequests).toEqual(['session-1'])

    answerForm('cancelled')
    await expect(call).rejects.toThrow(/cancelled/)
  })

  it('reopens the form after a rejected pair rather than returning the error', async () => {
    // The reason reaches the person through the form, which renders the route's
    // verdict — so the model is not the one relaying it.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    verdict = { ok: false, status: 401, message: 'Huawei Cloud rejected the credentials (HTTP 401)' }
    mount(store)

    const call = tool().execute({}, inSession('session-1'))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(formRequests).toEqual(['session-1'])

    answerForm('cancelled')
    await expect(call).rejects.toThrow(/cancelled/)
  })

  it('clears a refused pair before opening the form', async () => {
    // A credential IAM refused cannot be used again — a temporary token that
    // expired, or a key deleted in the console — and re-entering the same pair
    // changes nothing. Clearing first is what makes the form ask for a pair
    // instead of showing a signed-in card whose only button does nothing.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    verdict = { ok: false, status: 401, message: 'Huawei Cloud rejected the credentials (HTTP 401)' }
    mount(store)

    const call = tool().execute({}, inSession('session-1'))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(discards).toHaveLength(1)
    // And the form is up: the person is being asked, not shown.
    expect(formRequests).toEqual(['session-1'])

    answerForm('cancelled')
    await expect(call).rejects.toThrow(/cancelled/)
  })

  it('keeps a pair the call could not reach IAM to check', async () => {
    // `status === 0` means the request never arrived. The credential may be
    // perfectly good, and clearing it would log a person out because their
    // network blipped.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    verdict = { ok: false, status: 0, message: 'could not reach IAM' }
    mount(store)

    const call = tool().execute({}, inSession('session-1'))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(discards).toHaveLength(0)

    answerForm('cancelled')
    await expect(call).rejects.toThrow(/cancelled/)
  })

  it('keeps a pair when IAM is the one failing', async () => {
    // A 5xx is IAM breaking rather than refusing: the same pair may work as
    // soon as IAM recovers, so it is not discarded.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    verdict = { ok: false, status: 503, message: 'IAM is unavailable' }
    mount(store)

    const call = tool().execute({}, inSession('session-1'))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(discards).toHaveLength(0)

    answerForm('cancelled')
    await expect(call).rejects.toThrow(/cancelled/)
  })

  it('passes a stored SecurityToken through', async () => {
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1', securityToken: 'STS1' })
    mount(store)

    await tool().execute({}, inSession('session-1'))
    expect(verifiedWith).toMatchObject({ securityToken: 'STS1' })
  })
})

describe('auth tool — waiting on the form', () => {
  it('opens the form and stays pending while the person has not answered', async () => {
    // The whole point of the rewrite: a call that opened a form must not return.
    // An earlier version failed immediately, so the conversation moved on before
    // the person had typed anything.
    mount(new MemoryBackend())

    let settled = false
    const call = tool().execute({}, inSession('session-7')).then(
      () => { settled = true },
      () => { settled = true },
    )

    // Give the microtask queue a turn; the call must still be waiting.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    expect(formRequests).toEqual(['session-7'])

    answerForm('cancelled')
    await call
  })

  it('fails terminally when the person cancels', async () => {
    mount(new MemoryBackend())

    const call = tool().execute({}, inSession('session-1'))
    answerForm('cancelled')

    const error = await call.then(() => undefined, (e: unknown) => e)
    // Asserted against the English half: the message is bilingual, and the
    // English is the one that must not drift. Matching a whole translated
    // sentence would make this fail on a wording change while the behaviour it
    // guards stayed correct.
    expect(String(error)).toMatch(/cancelled the authentication flow/)
    // States the fact and stops. An instruction used to follow — "Do not call
    // auth again until they say to" — and a model holding it treated every
    // later sentence from the person as a question about permission, stalling
    // instead of retrying or explaining. The assertion is inverted rather than
    // deleted so a future edit cannot quietly put it back.
    expect(String(error)).not.toMatch(/Do not call auth again/)
  })

  it('returns the account once the person submits a usable pair', async () => {
    // The submit lands in the store through the credential route; the tool then
    // re-reads it rather than receiving anything from the form.
    const store = new MemoryBackend()
    mount(store)

    const call = tool().execute({}, inSession('session-1'))
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    answerForm('submitted')

    expect(await call).toMatchObject({
      authenticated: true,
      account: { accountId: 'acc-1', name: 'example-corp' },
    })
  })

  it('reopens the form when the submitted pair is rejected, and still waits', async () => {
    // A rejection is not the end: the person is correcting a mistake, and the
    // reason is what tells them what to fix. This is the case that made a
    // "fail on first failure" design wrong.
    const store = new MemoryBackend()
    verdict = { ok: false, status: 401, message: 'Huawei Cloud rejected the credentials (HTTP 401)' }
    mount(store)

    const call = tool().execute({}, inSession('session-1'))

    // First submit: stored and rejected.
    writeHuaweiCloud(store, { ak: 'BAD', sk: 'BAD' })
    answerForm('submitted')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(formRequests).toHaveLength(2)

    // Second submit: accepted.
    verdict = {
      ok: true,
      account: { accountId: 'acc-1', name: 'example-corp', projects: [] },
      region: 'cn-north-4',
      sts: false,
    }
    writeHuaweiCloud(store, { ak: 'AK2', sk: 'SK2' })
    answerForm('submitted')

    expect(await call).toMatchObject({ authenticated: true })
  })

  it('does not open a form when the stored pair already verifies', async () => {
    // The common case: a session that was authenticated before it started.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    mount(store)

    await tool().execute({}, inSession('session-3'))
    expect(formRequests).toEqual([])
  })

  it('fails without waiting when the call carries no session', async () => {
    // No session means no composer to render the form in, so there is nobody to
    // wait for. Failing is the only honest answer.
    mount(new MemoryBackend())

    await expect(tool().execute({}, {})).rejects.toThrow(/not attached to a conversation/)
    expect(formRequests).toEqual([])
  })

  it('reports a stopped turn the same way as a cancel', async () => {
    // Both end the call with no credential entered, which is the whole of what
    // the caller can act on. A separate wording for this state would add a state
    // without adding a decision.
    mount(new MemoryBackend())
    const controller = new AbortController()

    const call = tool().execute({}, { agent: { session: { id: 's' } }, signal: controller.signal })
    setTimeout(() => controller.abort(), 5)

    await expect(call).rejects.toThrow(/cancelled the authentication flow/)
  })
})

describe('auth tool — secrets stay out of the conversation', () => {
  it('never puts a credential in its result', async () => {
    // The tool reads the store to verify, and the value it hands back is what
    // the model sees. A credential appearing here would be in the transcript
    // and in every later request.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK-SECRET', sk: 'SK-SECRET', securityToken: 'STS-SECRET' })
    mount(store)

    const value = await tool().execute({}, inSession('session-1'))
    const serialized = JSON.stringify(value)

    expect(serialized).not.toContain('AK-SECRET')
    expect(serialized).not.toContain('SK-SECRET')
    expect(serialized).not.toContain('STS-SECRET')
  })

  it('never puts a credential in a failure message', async () => {
    // A rejection's message reaches the model too, and the verifier echoes the
    // service's own text — which must not be constructed from the secret.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK-SECRET', sk: 'SK-SECRET' })
    verdict = { ok: false, status: 401, message: 'Huawei Cloud rejected the credentials (HTTP 401)' }
    mount(store)

    const call = tool().execute({}, inSession('session-1'))
    await new Promise(resolve => setTimeout(resolve, 10))
    answerForm('cancelled')

    const error = await call.then(() => undefined, (e: unknown) => e)
    expect(String(error)).not.toContain('SK-SECRET')
  })

  it('declares no parameters, so a credential cannot be passed in', async () => {
    // The other half of the property: not only does nothing come out, nothing
    // can be handed in — there is no field a model could fill with a key.
    mount(new MemoryBackend())
    expect(tool().parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false })
  })
})

describe('auth tool — rendering', () => {
  it('names the account and lists the projects', async () => {
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    mount(store)

    const value = await tool().execute({}, inSession('session-1'))
    const blocks = tool().output.render(undefined, value)
    const text = blocks[0]?.text ?? ''

    expect(text).toContain('example-corp')
    expect(text).toContain('acc-1')
    // The project table is what the next call needs: a region-scoped API wants
    // the project_id, and its name is the region.
    expect(text).toContain('p-1')
    expect(text).toContain('cn-north-4')
    expect(text).toContain('p-2')
  })

  it('does not claim a verified region', async () => {
    // IAM is global: the routing region does not scope the result, so printing
    // it would suggest a fact nothing checked.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    mount(store)

    const text = tool().output.render(undefined, await tool().execute({}, inSession('session-1')))[0]?.text ?? ''
    expect(text).not.toContain('region cn-north-4')
  })

  it('says so when the credentials are temporary', async () => {
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    verdict = { ...(verdict as Record<string, unknown>), sts: true }
    mount(store)

    const text = tool().output.render(undefined, await tool().execute({}, inSession('session-1')))[0]?.text ?? ''
    // STS credentials expire; the reader needs to know before planning long work.
    expect(text).toContain('temporary')
  })

  it('reports an account with no visible projects without pretending otherwise', async () => {
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    verdict = {
      ok: true,
      account: { accountId: 'acc-1', name: 'example-corp', projects: [] },
      region: 'cn-north-4',
      sts: false,
    }
    mount(store)

    const text = tool().output.render(undefined, await tool().execute({}, inSession('session-1')))[0]?.text ?? ''
    expect(text).toContain('No projects are visible')
  })
})
describe('abandoned calls give the shared form back', () => {
  it('releases the request when the turn is stopped while the form is up', async () => {
    // The case from a live session: the person stopped the turn with the form
    // on screen. The host shares one pending request between callers, so a call
    // that leaves without releasing it strands every later one — no form is
    // written, so none appears, and `auth` waits for an answer nobody can give.
    const store = new MemoryBackend()
    mount(store)
    const controller = new AbortController()

    const pending = tool().execute({}, { ...(inSession('s1') as object), signal: controller.signal })
    await vi.waitFor(() => { expect(formRequests).toHaveLength(1) })

    controller.abort()
    await expect(pending).rejects.toThrow(/cancelled the authentication flow/i)

    expect(releases).toHaveLength(1)
  })

  it('releases the request when the person cancels', async () => {
    const store = new MemoryBackend()
    mount(store)

    const pending = tool().execute({}, inSession('s1'))
    await vi.waitFor(() => { expect(formRequests).toHaveLength(1) })

    answerForm('cancelled')
    await expect(pending).rejects.toThrow(/cancelled the authentication flow/i)

    // Cancelling already ends the call, so the request must not outlive it
    // either — the next `auth` has to start a fresh form, not join a settled
    // one and be told the person refused a question they never saw.
    expect(releases).toHaveLength(1)
  })

  it('does not release while it is still waiting', async () => {
    const store = new MemoryBackend()
    mount(store)

    void tool().execute({}, inSession('s1'))
    await vi.waitFor(() => { expect(formRequests).toHaveLength(1) })

    // A call that is still blocked owns the form; releasing early would drop
    // the request out from under the person filling it.
    expect(releases).toHaveLength(0)
  })
})
