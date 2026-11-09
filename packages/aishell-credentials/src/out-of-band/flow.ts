/**
 * One browser login at a time, and what the browser half is told about it.
 *
 * ## The shape of a login
 *
 *   probe()           borrow a port, let the page fetch it, give it back
 *        |            -> whether a browser here can reach this host at all
 *        v
 *   begin(provider)   bind a port, fetch the plan, start serving
 *        |            -> where to send the browser
 *        v
 *   (the person signs in at the cloud, in their browser, for up to 10 minutes)
 *        v
 *   the cloud posts the credential to the loopback listener
 *        v
 *   verify against IAM  -> store  -> record the outcome for the browser half
 *
 * Probe and login are separate operations on purpose — see `./login.ts` for
 * why. The probe answers a question about the access route and holds a port
 * for seconds; the login binds its own and holds it for as long as the person
 * takes.
 *
 * The outcome does not come back as a return value, because there is nothing
 * waiting on it: the person may take minutes, and an HTTP request held open
 * that long is a request a proxy will cut. So the outcome is *recorded* — in
 * the entry's settings document, which the browser half already subscribes to
 * — and the browser half reads it when it changes. That is the same channel
 * the credential form request already travels on, and the same reasoning.
 *
 * ## Why one at a time
 *
 * The shipped provider's callback carries no correlation string (`correlation:
 * "none"`), so two concurrent logins on two ports could not be told apart by
 * anything but the port itself. The service's own contract states the
 * constraint in the same terms: one login occupies one port. Refusing the
 * second is honest; queueing it would be a promise the flow cannot keep.
 *
 * ## Why a cancel is not a timeout
 *
 * A person who dismisses the form gets the listener closed immediately and no
 * outcome recorded beyond the dismissal. A person who simply walks away leaves
 * the listener bound until either the credential arrives or `expires_in`
 * passes, at which point the cloud will not post and the port is released. The
 * two are distinguished because only the first is a decision.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/out-of-band/flow
 */

import {
  AuthContractError,
  findProvider as findProviderViaService,
  type ContractDeps,
  type MappedCredential,
  type ProviderInfo,
} from './contract.ts'
import { probeLoopback } from './listener.ts'
import { startBrowserLogin, type BrowserLogin } from './login.ts'
import { LOGIN_PROBE_PATH, type LoginStartResult } from './routes.ts'
import type { LoginOutcome } from '../login-status.ts'

/** Collaborators the flow runs against; injected so it is testable. */
export interface LoginFlowDeps {
  /**
   * Verify one credential against IAM, returning the account it belongs to.
   *
   * The flow calls this before it stores anything, and treats a rejection as
   * the end of the login. See `./login.ts` for why it is not optional.
   *
   * The name it returns is what the outcome reports: the store's own account
   * hint is written by the reconcile loop on its next tick, so reading it here
   * would report whatever was there *before* this login.
   */
  readonly verify: (credential: MappedCredential) => Promise<string>
  /** Write a verified credential to the store. */
  readonly store: (credential: MappedCredential) => Promise<void>
  /** Record the non-secret status the browser half reads. */
  readonly recordError: (error: string) => void
  /** Record a completed login for the browser half, or clear it. */
  readonly recordOutcome: (outcome: LoginOutcome | undefined) => void
  /** Transport overrides for the contract calls. */
  readonly contract?: ContractDeps | undefined
}

/** The browser-login flow. */
export interface LoginFlow {
  /** Look up a provider; `undefined` when the service does not offer it. */
  readonly findProvider: (providerId: string) => Promise<ProviderInfo | undefined>
  /**
   * Borrow a loopback port and hand back a URL the page can fetch.
   *
   * Reaching it is the whole test, and the page is the one that learns the
   * answer — see `./listener.ts`. The port is released as soon as it is
   * reached, or after a short window if the page never gets there, so a card
   * left open holds nothing.
   */
  readonly probe: () => Promise<{ probeUrl: string }>
  /** Begin a login. Rejects when one is already running. */
  readonly begin: (provider: ProviderInfo) => Promise<LoginStartResult>
  /** Abandon the login in progress, if any. Safe to call with none. */
  readonly cancel: () => void
  /** Whether a login is running. */
  readonly inProgress: () => boolean
}

/**
 * Build the flow.
 *
 * @param deps - the collaborators above.
 */
export function createLoginFlow(deps: LoginFlowDeps): LoginFlow {
  const { verify, store, recordError, recordOutcome, contract } = deps

  /** The login in progress, if any. */
  let active: BrowserLogin | undefined

  const finish = (): void => { active = undefined }

  return {
    findProvider: (providerId) => findProviderViaService(providerId, contract),

    probe: async () => {
      const { probeUrl } = await probeLoopback(LOGIN_PROBE_PATH)
      return { probeUrl }
    },

    inProgress: () => active !== undefined,

    cancel: () => {
      const login = active
      finish()
      // A dismissal is not a failure to report: the person knows what they
      // did. Clearing the outcome is what tells the browser half to stop
      // showing "waiting".
      login?.cancel()
      recordOutcome(undefined)
    },

    begin: async (provider: ProviderInfo): Promise<LoginStartResult> => {
      if (active !== undefined) {
        throw new AuthContractError('A browser login is already in progress.')
      }

      const login = await startBrowserLogin({
        provider,
        contract,
        // Verification happens inside the flow, before the credential is
        // handed back, so a forged or wrong credential never reaches `store`.
        // Its resolved value is the account name, kept for the outcome below.
        verify,
      })
      active = login

      // Detached: the credential arrives whenever the person finishes, which
      // is minutes after `begin` returns. Both outcomes are recorded rather
      // than returned.
      void login.credential.then(
        async (result) => {
          // A cancel or a second login may have superseded this one while the
          // person was still at the cloud. Recording its outcome then would
          // report a login nobody is looking at.
          if (active !== login) return
          try {
            // Stored only now, and only because the credential verified: the
            // two steps are ordered, not merely adjacent.
            await store(result.credential)
            if (active !== login) return
            finish()
            recordError('')
            recordOutcome({ kind: 'succeeded', accountName: result.accountName })
          } catch (error) {
            if (active !== login) return
            finish()
            const message = `The credential verified, but storing it failed: ${error instanceof Error ? error.message : String(error)}`
            recordError(message)
            recordOutcome({ kind: 'failed', error: message })
          }
        },
        (error: unknown) => {
          if (active !== login) return
          finish()
          const message = error instanceof Error ? error.message : String(error)
          recordError(message)
          recordOutcome({ kind: 'failed', error: message })
        },
      )

      return {
        ok: true,
        loginUrl: login.loginUrl,
        providerName: provider.display_name,
        expiresInSeconds: login.expiresInSeconds,
      }
    },
  }
}
