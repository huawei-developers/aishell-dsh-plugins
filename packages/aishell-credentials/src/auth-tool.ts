/**
 * The `auth` tool — verify the stored credentials and report the account.
 *
 * ## Why this belongs to the credentials package
 *
 * It answers "is this account authenticated, and as whom?" — which is the
 * question this package already owns. The tool belongs beside the form that
 * writes the credentials, not beside the tools that spend them.
 *
 * Keeping it in `aishell-deploy` would split one responsibility across two
 * packages: the form deciding what a valid credential is (via the credential
 * route), and a tool deciding the same thing again (via `verify`). Both go
 * through the same shared verifier, but the *tool* is the part a model sees and
 * names, and "who am I authenticated as" is not a question about cloud tooling
 * — a user asking it may never run terraform at all.
 *
 * ## What the model gets
 *
 *   - With valid credentials: the account id, its name, and every visible
 *     project (each project's name is a region). That is what a deployment plan
 *     needs.
 *   - With none stored: a failure that asks, on the model's behalf, for the form
 *     to be opened. The form appears in the conversation; the model calls
 *     `auth` again after the person is done.
 *   - With credentials the service rejects: the failure carries Huawei Cloud's
 *     reason, and the form is opened again so the person can correct them.
 *   - After the person cancelled: a terminal failure telling the model to stop
 *     and say why authentication is needed. Without that, a model whose first
 *     call failed has every incentive to retry until the turn ends, and the
 *     person has already answered "no".
 *
 * ## How the form is asked for
 *
 * Not by returning a credential — that would put a secret in the transcript.
 * The tool writes a request into this entry's settings document
 * (`./form-request.ts`), the browser half sees it through `configForms`, and the
 * form opens. The credential travels the other way, over the credential route,
 * and never comes back through a tool result.
 *
 * ## What decides "the person cancelled"
 *
 * The form records a cancel in the store, as a sentinel the verifier reads. See
 * `CANCEL_SENTINEL`: it is a marker, never a credential, and `readStoredPair`
 * does not see it.
 *
 * ## Why it does not write the store
 *
 * The credential route verifies *before* it writes, one layer up. Writing from a
 * tool would open a model-triggered path into the credential store, which is
 * exactly what "credentials never enter the tool-call context" protects.
 *
 * ## Soft injection
 *
 * Registered behind `ctx.inject(['tools'])`. A deployment without the tool
 * registry — a headless host that only serves the credential route — should
 * lose the tool, not lose credential management.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/auth-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { FormOutcome } from './form-request.ts'
import type { CredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store'
import { readStoredPair } from '@huaweidevtools/aishell-dsh-credentials-store/accounts'
import { verifyCredentials } from '@huaweidevtools/aishell-dsh-credentials-store/verify'

/** Model-facing name. Prefixed so it cannot collide with another cloud plugin. */
export const AUTH_TOOL_NAME = 'aishell__auth'

/** Region used to route the verification call; IAM is global, see the module note. */
const VERIFY_REGION = 'cn-north-4'

/**
 * Host-side controls the tool needs from the plugin that registers it.
 *
 * Injected rather than imported so this module stays a pure function over a
 * store and a writer: the settings document is the registration site's
 * business, and a tool that reached for `ctx.settings` itself could not be
 * called from a test.
 */
export interface AuthToolDeps {
  /**
   * Open the credential form in one session and wait for the person.
   *
   * Resolves when they submit or cancel — never on a timeout. A person may be
   * fetching a key from the console; a form that gives up while they are typing
   * is worse than a call that waits. The call's own cancellation is the way out,
   * and the caller passes its signal for that.
   *
   * `undefined` when there is no session to render the form in, which is the
   * case a call running outside an agent hits.
   *
   * Throws {@link CredentialFormBusy} when ANOTHER conversation already has a
   * form open. Callers in the same conversation still share one form; a second
   * conversation cannot, because the form renders inside the first one — a
   * caller there would wait for a person who is looking at a different
   * conversation.
   */
  readonly requestForm: (sessionId: string) => Promise<FormOutcome> | undefined
  /**
   * This call has stopped waiting on the form it asked for.
   *
   * Required, not optional, because the leak it prevents is invisible and
   * permanent: the host shares one pending request between concurrent callers,
   * so a call that walks away without saying so leaves that request in place.
   * The next `auth` then joins a promise nobody will ever settle — no form is
   * written to the document, so none appears, and the call waits until the
   * turn ends.
   *
   * A person who aborts a turn is the ordinary way in. Nothing about that is
   * an error, which is exactly why nothing else remembers to do this.
   */
  readonly releaseForm: () => void
  /**
   * Remove the stored pair and tell the interface.
   *
   * Called when IAM refuses the pair this call was holding. The refusal is the
   * fastest evidence the credential has stopped working — a temporary token
   * expired, or a key deleted in the console — and both make re-entering the
   * SAME pair useless. Clearing first is what turns the next form into "sign
   * in from scratch" instead of a signed-in card whose only button does
   * nothing.
   */
  readonly discard: () => void
}


/**
 * The JSON Schema for `auth`'s parameters: none.
 *
 * Declared as an empty object rather than omitted so the model reads "takes no
 * arguments" explicitly, instead of inferring it from a missing field.
 */
const AUTH_PARAMETERS = {
  type: 'object' as const,
  properties: {},
  additionalProperties: false,
}

/** What a successful verification reports. */
interface AuthOutput {
  readonly authenticated: true
  readonly account: { readonly accountId: string, readonly name: string }
  readonly projects: ReadonlyArray<{ readonly id: string, readonly name: string, readonly description?: string }>
  readonly sts: boolean
}

/**
 * Register the `auth` tool on the host's tool registry.
 *
 * @param ctx - host context.
 * @param store - the credential store this package owns.
 */
export function registerAuthTool(
  ctx: Context,
  store: CredentialsStore,
  deps: AuthToolDeps,
): void {
  ctx.inject(['tools'], (scope) => {
    const dispose = scope.tools.register({
      name: AUTH_TOOL_NAME,
      description:
        'Authenticate with Huawei Cloud IAM, then report the account: its id and name, and '
        + "every project visible to it (a project's name is a region; its id is what a "
        + 'region-scoped API needs). '
        + 'Opens the credential form and waits for the user to finish — it does not return '
        + 'until they have authenticated or cancelled.',
      parameters: AUTH_PARAMETERS,
      output: {
        // `authenticated` is always true on success: a failure is a rejection,
        // so the value never has to carry a `false` a caller might ignore.
        schema: {
          type: 'object',
          properties: {
            authenticated: { type: 'boolean' },
            account: {
              type: 'object',
              properties: { accountId: { type: 'string' }, name: { type: 'string' } },
              required: ['accountId', 'name'],
            },
            projects: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['id', 'name'],
              },
            },
            sts: { type: 'boolean' },
          },
          required: ['authenticated', 'account', 'projects', 'sts'],
        },
        render: (_args: unknown, value: unknown) => renderAuth(value as AuthOutput),
      },
      async execute(_args, exec) {
        return await runAuth(store, deps, sessionOf(exec), exec.signal)
      },
    })
    return dispose
  })
}

/** The session a tool call runs under, from its execution context. */
function sessionOf(exec: { agent?: { session?: { id?: string } } }): string | undefined {
  return exec.agent?.session?.id
}

/**
 * Verify and describe the stored account.
 *
 * Four outcomes, and each one is a different instruction to the model:
 *
 *   - **Verified.** The account and its projects.
 *   - **The person cancelled.** Terminal: stop, and say what the credential was
 *     needed for. Without this the model's only signal is the same failure it
 *     got before, and it retries until the turn ends — while the person has
 *     already said no.
 *   - **Nothing stored, or the stored pair was rejected.** Open the form and
 *     fail with the reason. The model calls again once the person is done.
 *
 * The last two both open the form, which is deliberate: a rejected credential is
 * the case where the person most needs to see the form again, and Huawei's own
 * reason is what tells them what to correct.
 *
 * @param store - the credential store to read.
 * @param deps - host controls: open the form and wait for its answer.
 * @param sessionId - the conversation to open the form in; `undefined` when the
 *   call carries no agent, in which case no form can be shown.
 * @param signal - the call's cancellation; the way out of a form nobody answers.
 * @returns the account, its projects, and whether the credentials are temporary.
 * @throws when the person cancels, or when no form can be shown at all.
 */
async function runAuth(
  store: CredentialsStore,
  deps: AuthToolDeps,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<AuthOutput> {
  // A stored pair that still verifies is answered without a form: the common
  // case is a session that was authenticated before it started.
  const stored = readStoredPair(store)
  if (stored !== undefined) {
    const verified = await verifyCredentials(stored, { region: VERIFY_REGION })
    if (verified.ok) return describeAccount(verified)
    // Refused rather than merely unreachable: this pair cannot be used again,
    // so it is cleared before the form opens. A transport failure (status 0) or
    // an IAM outage (5xx) is left alone — the pair may be perfectly good.
    if (verified.status === 401 || verified.status === 403) deps.discard()
  }

  // From here the call is blocked on a person.
  if (sessionId === undefined || sessionId === '') {
    throw new Error(
      'Not authenticated with Huawei Cloud IAM, and this call is not attached to a '
      + 'conversation, so the credential form cannot be shown. Ask the user to open the '
      + 'credential form themselves, then call auth again.',
    )
  }

  // A loop, because a rejected pair reopens the form rather than failing the
  // call. Each pass waits for a person; the bound is a safety net against a
  // settle that lands with nobody behind it, not a retry policy — someone
  // correcting a mistyped key is entitled to as many rounds as they need.
  for (let round = 0; round < MAX_FORM_ROUNDS; round += 1) {
    // Each pass blocks until a person answers, and the next cannot begin
    // before this one ends — two rounds in flight would put two forms in front
    // of one person and settle the wrong one. Sequential by construction.
    //
    // `CredentialFormBusy` propagates rather than being caught: the form is
    // open in a different conversation, so there is nothing to wait for here
    // and no later round would find it any clearer. Letting it out of the loop
    // is what makes the tool fail at once with an actionable message.
    const pending = deps.requestForm(sessionId)
    if (pending === undefined) break
    let outcome: FormOutcome | { readonly kind: 'aborted' }
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await raceCancellation(pending, signal)
    } catch (error) {
      // The wait itself failed. Releasing here matters for the same reason the
      // abort path releases: the request is shared, and leaving it in place
      // would strand the next caller on a promise nothing will settle.
      deps.releaseForm()
      throw error
    }
    if (outcome.kind === 'cancelled' || outcome.kind === 'aborted') {
      // The call is over either way, and the shared request must not outlive
      // it. An abort leaves the promise pending, so without this the next
      // `auth` would join it and no form would appear.
      deps.releaseForm()
      // One message for both: from here they are the same outcome, and no
      // credential was entered either way.
      throw new CredentialEntryCancelled()
    }

    // Submitted. The store is the source of truth: the form posts to the
    // credential route, which verifies and writes, so a successful submit has
    // already left a usable pair here.
    const pair = readStoredPair(store)
    if (pair === undefined) continue
    // eslint-disable-next-line no-await-in-loop
    const result = await verifyCredentials(pair, { region: VERIFY_REGION })
    if (result.ok) return describeAccount(result)
    // Rejected: the reason is on screen already — the form renders the route's
    // verdict — and the next round reopens it for a corrected pair.
  }

  throw new Error(
    'Not authenticated with Huawei Cloud IAM. The credential form was shown but no usable '
    + 'credential was stored. Ask the user to authenticate, then call auth again.',
  )
}

/** How many form rounds one call will wait through before giving up. */
const MAX_FORM_ROUNDS = 10

/**
 * Credential entry ended without a credential.
 *
 * One message for both ways it ends — the person pressed cancel, or the turn
 * was stopped while the form was up. From the call's side they are the same
 * outcome: nothing was entered, so the call cannot continue.
 *
 * Bilingual, and stating only the fact. That is the shape `aishell-e2b` uses
 * for its blocked-call error: the reader is whichever language the session
 * runs in, and the message says what happened rather than what to do about it.
 *
 * ## Why no instruction follows
 *
 * The message states the fact and stops. Adding "do not call auth again until
 * they say to" reads as a permission rule to be interpreted, and a model given
 * a rule it cannot evaluate narrates its uncertainty instead of acting: asked
 * to look again, it reasons about whether that counts as consent, and neither
 * retries nor explains. The fact is what the model needs; what follows from it
 * is its judgement.
 */
class CredentialEntryCancelled extends Error {
  constructor() {
    super(
      '用户取消了认证流程。 / The user cancelled the authentication flow.',
    )
    this.name = 'CredentialEntryCancelled'
  }
}

/**
 * Another conversation already has the credential form open.
 *
 * ## Why this is a refusal and not a queue
 *
 * The form renders inside ONE conversation. A call in a different conversation
 * that waited on it would be waiting for a person looking at somewhere else —
 * they would see no form, and the call would hang until the turn was stopped.
 * Queueing would fix the display but not the wait: the second caller would sit
 * until the first was answered, which may never happen because nobody is
 * looking at the first one either.
 *
 * ## Why no timeout
 *
 * The obvious alternative — give the first request a deadline and release it —
 * was rejected. There is no honest number: a person fetching a key from the
 * console can legitimately take ten minutes, and cutting them off mid-typing is
 * worse than making a second conversation retry. The first request does get
 * released, just by a definite event rather than a clock: stopping the turn, or
 * answering the form.
 *
 * ## The instruction is part of the message
 *
 * Unlike {@link CredentialEntryCancelled}, this one DOES say what to do next.
 * That is the difference between them: a cancel is a decision the person made
 * and the model must not talk them out of, while a busy form is a transient
 * state with an obvious next move. Saying it here saves a round trip and keeps
 * a model from inventing a retry loop of its own.
 */
export class CredentialFormBusy extends Error {
  constructor() {
    super(
      '另一个会话已经打开了凭据表单。 / Another conversation already has the '
      + 'credential form open. Ask the user to finish or cancel it there, then '
      + 'call auth again.',
    )
    this.name = 'CredentialFormBusy'
  }
}

/**
 * Wait for the form's answer, or for the call to be cancelled.
 *
 * An abandoned call must not keep a promise alive: the turn is over, and nobody
 * is going to answer a prompt for it. `aborted` is a separate outcome from
 * `cancelled` in shape, and treated the same in effect — either way the person
 * did not supply a credential and asking again would be wrong.
 *
 * @param pending - the open form request.
 * @param signal - the call's cancellation, if any.
 */
async function raceCancellation(
  pending: Promise<FormOutcome>,
  signal: AbortSignal | undefined,
): Promise<FormOutcome | { readonly kind: 'aborted' }> {
  if (signal === undefined) return pending
  if (signal.aborted) return { kind: 'aborted' }
  return await new Promise((resolve) => {
    const onAbort = (): void => { resolve({ kind: 'aborted' }) }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then((outcome) => {
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    })
  })
}

/** Project a successful verification into the tool's canonical value. */
function describeAccount(
  result: Extract<Awaited<ReturnType<typeof verifyCredentials>>, { ok: true }>,
): AuthOutput {
  return {
    authenticated: true,
    account: { accountId: result.account.accountId, name: result.account.name },
    projects: result.account.projects.map(project => ({
      id: project.id,
      name: project.name,
      ...(project.description === undefined ? {} : { description: project.description }),
    })),
    sts: result.sts,
  }
}

/**
 * The text the model reads.
 *
 * A short summary then the project table: the summary answers the question the
 * tool was called with, and the table is what the next call needs. The region
 * is deliberately absent — IAM does not verify it, so printing it would suggest
 * it had been checked.
 *
 * @param value - the verified account.
 */
function renderAuth(value: AuthOutput): Array<{ type: 'text', text: string }> {
  const projects = value.projects.length === 0
    ? 'No projects are visible to these credentials.'
    : ['Project id                            region         description', ...value.projects.map(
      project => `${project.id.padEnd(36)} ${project.name.padEnd(14)} ${project.description ?? ''}`.trimEnd(),
    )].join('\n')

  const kind = value.sts ? 'temporary (STS)' : 'stored'

  return [{
    type: 'text',
    text:
      `Authenticated with Huawei Cloud as ${value.account.name} `
      + `(account id ${value.account.accountId}); using ${kind} credentials.\n\n`
      + projects,
  }]
}