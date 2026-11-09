/**
 * The browser-login flow, as two separate operations.
 *
 * ## Why two, and not one
 *
 * The card has to answer "can the browser reach a listener here?" before
 * offering the button, and answering it requires binding a loopback socket —
 * the question is whether the browser can reach a listener here, and nothing
 * weaker answers it. That lives in `./listener.ts` as `probeLoopback`.
 *
 * A login is a different thing: fetch a URL for a specific port, send the
 * person there, wait for the cloud to post a credential back. That is
 * {@link startBrowserLogin}, and it binds **its own** port.
 *
 * These are two operations rather than one, and merging them breaks in two
 * ways that only show up when a person takes their time:
 *
 *   - **A shared port would be held from the moment the card opened.** The
 *     probe binds a socket to answer its question and releases it immediately;
 *     a port kept until someone clicked would be held for as long as the page
 *     lived, by anyone who merely read the card.
 *   - **A login window would start before the person did.** The `login_url`
 *     names the port it was projected for and the service states how long it
 *     stays valid. Fixed at probe time, a card left open for a while would
 *     offer a URL that had already expired — and a countdown would run down on
 *     a sign-in nobody had begun.
 *
 * So each operation binds what it needs and releases it when its own job ends.
 * The probe's port is closed as soon as the browser has answered; the login's
 * port lives exactly as long as the login does, and the URL is fetched at the
 * moment it is about to be opened.
 *
 * ## Why verification is not optional
 *
 * `credential` resolves with a credential already proven against the cloud, or
 * it rejects. A caller cannot get an unverified credential out of it, because
 * the one failure mode that matters — a forged credential reaching the store —
 * is the one this exists to prevent, and a boolean flag is something a caller
 * can forget to check.
 *
 * ## What verification does not catch
 *
 * It proves the credential is *valid*, not that it belongs to the account the
 * person meant to sign in as. A local attacker posting their own real
 * credential passes it. That is the residual risk the service's own docs
 * record as unfixable at the receiving end, and the reason the account is
 * reported back to the person rather than silently stored.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/out-of-band/login
 */

import {
  AuthContractError,
  listProviders,
  mapCredential,
  requestLogin,
  type ContractDeps,
  type MappedCredential,
  type ProviderInfo,
} from './contract.ts'
import { bindLoopback, unrefIfPossible, type CallbackListener } from './listener.ts'

/**
 * A credential that has been proven against the cloud, and whose account is
 * therefore known.
 *
 * The two travel together because the same call establishes both: verification
 * proves the credential and names the account it belongs to. Separating them
 * would leave the caller to look the name up again, reading the store before
 * the reconcile loop has caught up with the write.
 */
export interface VerifiedCredential {
  readonly credential: MappedCredential
  /** The account the credential belongs to, as IAM reported it. */
  readonly accountName: string
}

/** A login in flight. */
export interface BrowserLogin {
  /** The address the callback listener bound to, `host:port`. */
  readonly address: string
  /** Where to send the browser. */
  readonly loginUrl: string
  /** The credential, once the person has finished and the cloud accepted it. */
  readonly credential: Promise<VerifiedCredential>
  /** How long the login stays valid, in seconds — the service's own figure. */
  readonly expiresInSeconds: number
  /** Abandon the login: close the listener and reject anything pending. */
  readonly cancel: () => void
}

/** Transport and provider facts both operations need. */
export interface LoginContext {
  /** The provider, as the service describes it — including its `credential_schema`. */
  readonly provider: ProviderInfo
  /** Transport overrides for the contract calls. */
  readonly contract?: ContractDeps | undefined
}

/** Options for {@link startBrowserLogin}. */
export interface StartLoginOptions extends LoginContext {
  /**
   * Proves a credential works, and names the account it belongs to.
   *
   * Called before anything is returned, and a rejection ends the login — a
   * throw is the only way to say no, so there is no boolean a caller could
   * forget to check. The resolved name is what a successful login reports.
   */
  readonly verify: (credential: MappedCredential) => Promise<unknown>
}

/**
 * How long to wait when the service does not say.
 *
 * The service's own contract states ten minutes; this matches it rather than
 * inventing a different number, so a response omitting the field behaves the
 * same as one carrying the documented value.
 */
const DEFAULT_EXPIRES_SECONDS = 600

/**
 * Find the provider to sign in with, and the schema its credentials use.
 *
 * Needs no socket, so the card can ask "is this even on offer, and what am I
 * signing in to?" before anything binds.
 *
 * @param providerId - the provider to look for.
 * @param deps - transport overrides.
 * @returns the provider, or `undefined` when the service does not offer it.
 * @throws {AuthContractError} when the service is unreachable or answers unusably.
 */
export async function findProvider(
  providerId: string,
  deps: ContractDeps = {},
): Promise<ProviderInfo | undefined> {
  const providers = await listProviders(deps)
  return providers.find(provider => provider.id === providerId)
}

/**
 * Begin a browser login.
 *
 * Binds its own listener and fetches a login URL projected for it, so both are
 * as fresh as the moment the person clicked — see the module note for why that
 * matters. Everything except `credential` is settled by the time this returns;
 * a failure to bind, reach the service, or match the plan throws instead.
 *
 * @param options - the provider and the verifier.
 * @returns the running login.
 * @throws {AuthContractError} when the port cannot be bound, the service
 *   cannot be reached, or the plan names an address this machine is not on.
 */
export async function startBrowserLogin(options: StartLoginOptions): Promise<BrowserLogin> {
  const { provider, verify, contract } = options

  const bound = await bindLoopback()
  let cancelled = false

  try {
    const target = await requestLogin(provider.id, `http://${bound.address}/`, contract)

    // The plan must name the address that bound. The service's own reference
    // client makes this check for the same reason: a mismatch would otherwise
    // surface as a timeout with the cause invisible.
    if (target.callback.address !== '' && target.callback.address !== bound.address) {
      throw new AuthContractError(
        `The login service expects the callback at ${target.callback.address}, but this `
        + `machine is listening on ${bound.address}. Refusing to wait for a callback that `
        + `cannot arrive.`,
      )
    }

    const listener: CallbackListener = bound.serve(target.callback)
    const expiresInSeconds = target.expires_in > 0 ? target.expires_in : DEFAULT_EXPIRES_SECONDS

    let settleCredential: (value: VerifiedCredential) => void
    let failCredential: (error: Error) => void
    const completion = Promise.withResolvers<VerifiedCredential>()
    settleCredential = completion.resolve
    failCredential = completion.reject
    const credential = completion.promise
    // The caller may only await the URL, or abandon the flow; a rejection with
    // no awaiter must not become an unhandled rejection.
    credential.catch(() => {})

    void (async (): Promise<void> => {
      // The window the service states starts now, because now is when the
      // person is being sent to the cloud. Past it the callback will not come,
      // so the listener would wait for something that cannot happen.
      let expiry: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<'expired'>((resolve) => {
        expiry = setTimeout(() => { resolve('expired') }, expiresInSeconds * 1000)
        // Node keeps the process alive for a pending timer, and this one runs
        // for minutes; it must not hold a host open after everything else is
        // done. A browser timer is a number and has no `unref`, which is why
        // the method is probed rather than assumed.
        unrefIfPossible(expiry)
      })

      let payload: Record<string, unknown>
      try {
        const outcome = await Promise.race([
          listener.accepted.then(value => ({ kind: 'accepted' as const, value })),
          expired.then(() => ({ kind: 'expired' as const })),
        ])
        if (outcome.kind === 'expired') {
          // Close the listener first: the port is the resource, and the
          // rejection below tells the person what happened.
          bound.close()
          failCredential(new AuthContractError(
            `The browser sign-in was not completed within `
            + `${String(Math.round(expiresInSeconds / 60))} minutes. Start it again when you are ready.`,
          ))
          return
        }
        payload = outcome.value
      } catch (error) {
        if (cancelled) return
        failCredential(error instanceof Error ? error : new Error(String(error)))
        return
      } finally {
        if (expiry !== undefined) clearTimeout(expiry)
      }
      if (cancelled) return

      // Map through the provider's declared schema. A payload that does not
      // satisfy it is a malformed callback, not a credential: storing half a
      // pair is exactly what the store's single-record design exists to
      // prevent.
      const mapped = mapCredential(provider.credential_schema, payload)
      if (mapped === undefined) {
        failCredential(new AuthContractError(
          'The callback arrived but did not carry the fields the provider declared.',
        ))
        return
      }

      // Verify before handing anything back. See the module note. The call both
      // proves the credential and names its account, so the two are settled
      // together.
      let accountName: unknown
      try {
        accountName = await verify(mapped)
      } catch (error) {
        failCredential(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (cancelled) return
      settleCredential({
        credential: mapped,
        accountName: typeof accountName === 'string' ? accountName : '',
      })
    })()

    return {
      address: bound.address,
      loginUrl: target.login_url,
      expiresInSeconds,
      credential,
      cancel: () => {
        if (cancelled) return
        cancelled = true
        bound.close()
        failCredential(new AuthContractError('The browser login was cancelled.'))
      },
    }
  } catch (error) {
    // Nothing is serving yet: the plan never arrived, so the socket has no
    // reason to stay bound.
    bound.close()
    throw error
  }
}
