/**
 * Browser-half entry: the credential form, plus the account hint chips.
 *
 * Secrets never travel through the settings document. The form POSTs the
 * plaintext to the Host's authenticated credential route
 * (`api/aishell/credentials`), where it is verified against Huawei Cloud IAM
 * and transferred into the credential store; the route answers with the
 * verdict in the same round trip. Only the non-secret presence flag and the
 * verified account name come back through `ctx.configForms`, which the chips
 * and the form read.
 *
 * The form is the one credential surface, and a chip click is what opens it.
 * It renders in `conversation.composer`, and there is no Settings section
 * beside it: one place to enter a credential means one place to look when none
 * is working.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls ctx.configForms.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.slots merge (the renderer owns the slot registry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Conversation slot contracts ('conversation.composer.dock'
// and 'conversation.input.dock').
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ctx.uiWorkspace merge, for navigating to a conversation
// that already has the form on screen.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the branded Session identity `openSession` takes. Same cast
// rationale as `./CredentialFormInteraction.ts` — the value IS a session id,
// but the brand can only be applied at the boundary.
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: pulls the ctx.uiSession merge (the pending-interaction registry the
// composer chain selects from) and its SessionPendingInteractionMap.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { CredentialStatus, SaveVerdict } from './credential-status.ts'
import { AishellAccountHint, type AishellAccountHintInjected } from './AishellAccountHint.tsx'
import { AishellHeroChip, type AishellHeroChipInjected } from './AishellHeroChip.tsx'
import { CredentialRequestForm, type CredentialRequestFormInjected } from './CredentialRequestForm.tsx'
import { isCredentialForm } from './CredentialFormInteraction.ts'
import { decodeRequest } from '../form-request.ts'
import { probeBrowserRoute, startBrowserLogin as startLogin } from './login-flow.ts'
import type { CredentialPrefill } from '../prefill.ts'
import { createCredentialFormVisibility } from './credential-form-visibility.ts'
import { installChipStyles } from './huawei-mark.ts'
import { installFormMotionStyles } from './form-motion.ts'
import { NS, zh, en, type AishellLocaleKey } from './locales.ts'

/** Non-secret status fields of the Host entry this page reads. */
interface AishellSettings {
  readonly credentialsStored?: boolean
  readonly accessKeyIdHint?: string
  readonly lastError?: string
  /** A pending request to open the form; JSON `{ token, sessionId }`, or `''`. */
  readonly credentialFormRequest?: string
  /** How the last browser login ended; JSON, or `''`. Carries no credential. */
  readonly loginOutcome?: string
}

/** Host entry id (= settings namespace) this page reads status from. */
const AISHELL_CREDENTIALS_NS = 'aishell-client-credentials'

/**
 * Host credential route, written document-relative: the served index carries
 * `<base href="./">`, so the leading slash is stripped and the request lands on
 * the same origin that served the page — which is what carries the browser
 * session cookie the route's authentication fence requires.
 */
const CREDENTIALS_ROUTE = 'api/aishell/credentials'
/** Clear route; the Host's fetch registry has no DELETE, so clearing is a POST. */
const CLEAR_ROUTE = 'api/aishell/credentials/clear'
/** Cancel route; names the request token the person declined. */
const CANCEL_ROUTE = 'api/aishell/credentials/cancel'
/** Confirm route; names the request token the person accepted as already stored. */
const CONFIRM_ROUTE = 'api/aishell/credentials/confirm'
/** Prefill route; returns the values the host's environment already holds. */
const PREFILL_ROUTE = 'api/aishell/credentials/prefill'
/**
 * POST one JSON body to a Host credential route and read back its verdict.
 * A non-JSON or unreadable body is reported as a transport failure rather than
 * thrown, so the form shows a message instead of an unhandled rejection.
 *
 * @param t - the form's translator; the failure copy is user-visible, so it
 *            follows the active locale like every other string in the form.
 */
async function postJson(route: string, t: (key: AishellLocaleKey) => string, body?: unknown): Promise<SaveVerdict> {
  try {
    const response = await fetch(route, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const verdict = await response.json() as SaveVerdict
    return verdict
  } catch (error) {
    return { ok: false, error: t('error.unreachable') + (error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * Store one credential through the Host route.
 *
 * Both ways the form comes up — a chip click and a blocked tool call — go
 * through this, so there is exactly one body shape for the credential route.
 *
 * An absent SecurityToken is omitted rather than sent empty: the Host reads an
 * empty string as absent anyway, so sending it would only make the wire shape
 * depend on which form was used.
 */
function saveCredential(
  t: (key: AishellLocaleKey) => string,
  accessKeyId: string,
  secretAccessKey: string,
  securityToken: string | undefined,
  requestToken: string | undefined,
): Promise<SaveVerdict> {
  return postJson(CREDENTIALS_ROUTE, t, {
    accessKeyId,
    secretAccessKey,
    ...(securityToken === undefined ? {} : { securityToken }),
    // Names the request this submit answers, so the host settles the call that
    // asked rather than whatever happens to be pending.
    ...(requestToken === undefined ? {} : { requestToken }),
  })
}

/**
 * Clear the stored credentials.
 *
 * One store, one write: the credentials live in the host's keyring and nowhere
 * else, so this is the local clear and its failure is the only one there is to
 * report.
 *
 * @param t - the form's translator; the failure copy is user-visible.
 */
async function clearBothStores(t: (key: AishellLocaleKey, params?: Record<string, unknown>) => string): Promise<SaveVerdict> {
  return postJson(CLEAR_ROUTE, t)
}

/**
 * Read the credential prefills the host has in its environment.
 *
 * Failure is not an event: a host with nothing in its environment answers an
 * empty object, and a route that cannot be reached answers `{}` too. A form
 * that starts empty is the ordinary case, so there is nothing to report.
 *
 * @returns the prefills, or an empty object.
 */
async function readPrefill(): Promise<CredentialPrefill> {
  try {
    const response = await fetch(PREFILL_ROUTE, { headers: { accept: 'application/json' } })
    if (!response.ok) return {}
    const body = await response.json() as Partial<CredentialPrefill>
    // A half pair is no pair, the same rule the host applies: one field filled
    // and the other empty would submit an incomplete credential.
    return typeof body.accessKeyId === 'string' && body.accessKeyId !== ''
      && typeof body.secretAccessKey === 'string' && body.secretAccessKey !== ''
      ? {
        accessKeyId: body.accessKeyId,
        secretAccessKey: body.secretAccessKey,
        ...(typeof body.securityToken === 'string' && body.securityToken !== ''
          ? { securityToken: body.securityToken }
          : {}),
      }
      : {}
  } catch {
    return {}
  }
}

/** Required services. */
export const inject = ['slots', 'locale', 'configForms', 'uiSession', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  // Register the `aishell` locale namespace so the chips and the form get a
  // typed `t`.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aishell-credentials: dictionaries')
  const t = ctx.locale.bind(NS)

  // The chips' shared hover/focus sheet. Installed here rather than by either
  // component: both carry the same CHIP_CLASS, so one sheet serves both and a
  // per-component installer would contend for the same dedupe key. Owning it
  // on this fiber is also what makes a reload pick up an edited rule.
  installChipStyles(ctx)

  // The card's animations: the running state's spinner and its progress line.
  // Installed on this fiber for the same reason the chip sheet is — one owner
  // for one dedupe key, and a reload picks up an edited rule.
  installFormMotionStyles(ctx)

  const form = ctx.configForms.get<AishellSettings>(AISHELL_CREDENTIALS_NS)
  // Presence + verdict the form and the chips report: the Host-written
  // non-secret fields. Secrets never appear here — they live in the credential
  // store, which the browser half has no route to read.
  const status = createSnapshotStore<CredentialStatus>({
    hasAccessKey: false,
    hasSecretKey: false,
    hasSecurityToken: false,
    accessKeyIdHint: '',
    lastError: '',
  })
  const derive = (): void => {
    const value = form.getSnapshot().value
    const stored = value?.credentialsStored === true
    status.set({
      hasAccessKey: stored,
      hasSecretKey: stored,
      hasSecurityToken: stored,
      accessKeyIdHint: value?.accessKeyIdHint ?? '',
      lastError: value?.lastError ?? '',
    })
  }
  ctx.effect(() => form.subscribe(derive), 'aishell-credentials: credential presence')
  derive()

  // The last browser login's outcome, as the Host wrote it. A store rather
  // than a plain read because the form has to react when it changes — the
  // credential lands minutes after the login starts, with no request pending.
  const loginOutcome = createSnapshotStore<string>(form.getSnapshot().value?.loginOutcome ?? '')
  ctx.effect(() => form.subscribe(() => {
    loginOutcome.set(form.getSnapshot().value?.loginOutcome ?? '')
  }), 'aishell-credentials: login outcome')

  // Publish (and withdraw) the pending interaction the chain selects on. The
  // decision lives in `CredentialFormVisibility`, which is unit-tested: a
  // missed withdrawal leaves the form on screen with nothing throwing.
  const publishCredentialForm = ctx.uiSession.registerPendingInteraction(() => 0)
  const visibility = createCredentialFormVisibility({
    publish: (interaction) => publishCredentialForm(interaction, () => Promise.resolve()),
    // The same navigation the sidebar performs when a conversation is clicked,
    // so a chip press in the wrong conversation lands on the card exactly as
    // choosing that conversation would.
    revealSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId as SessionId) },
    // Read back from the framework rather than trusting the machine's own
    // record, which only an explicit `close()` clears. `sessionStatus` is the
    // live fact — the highest-precedence interaction actually in front of each
    // conversation's composer — so this is what tells a stale record apart from
    // a card that is really there.
    isStillPending: (interaction) =>
      ctx.uiSession.sessionStatus.getSnapshot().get(interaction.sessionId as SessionId)?.pendingInteraction
      === interaction,
  })

  // Host-initiated opens. `aishell__auth` writes a request into this entry's
  // config when it finds no usable credential; the document is the only channel
  // the host has into the browser, so this is where that request arrives.
  //
  // The token is what makes a second request distinguishable from the first: a
  // person who cancelled must see the form again when a later call asks, and a
  // boolean would look identical to the request they already acted on.
  /** The last request the browser acted on, so a re-read is not a re-open. */
  let lastRequestToken: string | undefined
  /**
   * The token of the request this form is currently answering, if any.
   *
   * A chip-opened form has none: nothing asked for it, so a cancel must not
   * report one — a submit or cancel names a request, and there is no request to
   * name.
   */
  let pendingRequestToken: string | undefined

  /**
   * Whether the first pass over the document has run.
   *
   * The document is persisted, so on a fresh page load it still holds whatever
   * request the previous session left there. Acting on that would open the form
   * for a question nobody is asking — the same bug the host clears the field
   * for at startup, and this half must not open it in the window before that
   * write lands. The first pass establishes the baseline: whatever is already
   * in the document when this page loads is not a request addressed to it.
   */
  let primed = false

  const applyFormRequest = (): void => {
    const request = decodeRequest(form.getSnapshot().value?.credentialFormRequest)
    if (!primed) {
      // Adopt this token as "already seen" without acting on it, so a later
      // request with the same token is not mistaken for a new one.
      primed = true
      lastRequestToken = request?.token
      return
    }
    if (request === undefined || request.token === lastRequestToken) return
    lastRequestToken = request.token
    pendingRequestToken = request.token
    visibility.open(request.sessionId)
  }

  ctx.effect(() => form.subscribe(applyFormRequest), 'aishell-credentials: form requests')
  applyFormRequest()

  ctx.effect(() => () => { visibility.dispose() }, 'aishell-credentials: credential form teardown')

  /**
   * Answer the request this form is open for, if any.
   *
   * Only when this form was opened by a request: a chip-opened form has no
   * request behind it, and answering one would make the *next* `auth` call
   * believe the person had acted on a question nobody asked.
   *
   * The token is spent either way, so a second press cannot answer twice, and a
   * later request with the same token is not mistaken for this one.
   *
   * @param route - the cancel or confirm route to post to.
   */
  const answerRequest = (route: string): void => {
    const token = pendingRequestToken
    pendingRequestToken = undefined
    if (token === undefined) return
    void fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }).catch(() => { /* the form still closes; the host simply keeps asking */ })
  }

  // Account hint chip under the composer — shows the account name the Host's
  // IAM verification wrote so the user sees which account their chat is signed
  // as; the unconfigured prompt takes its place when no credentials are
  // stored. Clicking it opens the credential form for THIS conversation (the
  // slot is session-scoped, and the chip's props carry the session id).
  ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'aishell-account',
      order: 30,
      locale: NS,
      inject: (sessionId: string): AishellAccountHintInjected => ({
        hooks: { credentials: status },
        t,
        // Opening for the chip's own session is what makes the takeover land
        // in the conversation the person is looking at; a no-op if a form is
        // already up (either door).
        openCredentialForm: () => { visibility.open(sessionId) },
      }),
    }, AishellAccountHint)), 'aishell-credentials: account hint chip')

  // New-Session counterpart. The composer dock above does not render until a
  // session exists — DSH guards that slot with `variant === "composer" &&
  // sessionId !== undefined` — so a blank session showed neither the account
  // nor the mode. The row below the picker and above the input card is
  // `conversation.input.dock`, a `list` slot: entries compose side by side
  // instead of competing for one seat, so it cannot collide with an occupant
  // however the base evolves.
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => {
    const dispose = ctx.slots.register({
      name: 'conversation.input.dock',
      // A `list` slot, unlike the hero row's `single` seats: `id` + `order`
      // place this entry among the others (the TodoPanel precedent sits at
      // order 0) instead of competing for the seat — no priority shadowing,
      // no occupant to displace. `order: 10` sorts after the todo panel.
      id: 'aishell-hero',
      order: 10,
      locale: NS,
      inject: (sessionId: string): AishellHeroChipInjected => ({
        hooks: { credentials: status },
        // Same affordance as the composer chip: the form opens in this blank
        // session, whose composer the chain takes over exactly as it does
        // mid-conversation.
        openCredentialForm: () => { visibility.open(sessionId) },
      }),
    }, AishellHeroChip)
    return dispose
  }), 'aishell-credentials: hero account chip')

  // The credential form — the one surface where credentials are entered.
  //
  // A `chain` slot: `select` is a pure function, and the first entry to return
  // non-null becomes the composer. Returning the pending interaction only when
  // one is up is what makes this a takeover rather than an always-on panel —
  // the ordinary composer renders the rest of the time. This is the same
  // mechanism the approval panel and the question composer use. It works on
  // the New-Session hero page too: startup restores (or creates) a blank
  // session for the current workspace, so the hero page carries a sessionId
  // and the chain runs — the chain only falls back when NO session is
  // selected at all, a state the app reaches only with no workspace and no
  // session, where the hero chip does not render either (its dock renders
  // only with a live input zone), so no chip exists that could click into
  // that fallback.
  ctx.effect(() => ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    select: ({ pendingInteraction }) =>
      isCredentialForm(pendingInteraction) ? pendingInteraction : null,
    locale: NS,
    inject: (): CredentialRequestFormInjected => ({
      hooks: { credentials: status, loginOutcome },
      save: (ak, sk, token) => saveCredential(t, ak, sk, token, pendingRequestToken),
      readPrefill: () => readPrefill(),
      // Probed on every open rather than remembered in the component: the
      // answer is a fact about how this page is reached, so `login-flow.ts`
      // keeps it at module level, where a remount cannot lose it. It is not
      // asked again per card — see `./login-flow.ts`.
      probeBrowserRoute: (signal) => probeBrowserRoute(signal),
      // Called on click. Fetches a URL projected for the port it binds at that
      // moment, which is why the two are separate.
      startBrowserLogin: () => startLogin(),
      clear: () => clearBothStores(t),
      close: () => { visibility.close() },
      cancel: () => { answerRequest(CANCEL_ROUTE); visibility.close() },
      // Credentials are already stored and the person is done looking at them.
      // Nothing is written or verified here: the tool that asked re-reads and
      // verifies the store itself, so this only has to end the wait.
      confirm: () => { answerRequest(CONFIRM_ROUTE); visibility.close() },
    }),
  }, CredentialRequestForm)), 'aishell-credentials: credential form')
}
