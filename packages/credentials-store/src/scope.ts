/**
 * Which credential namespace this build uses.
 *
 * ## The knob
 *
 * A build-time constant, not a runtime setting:
 *
 * ```sh
 * AISHELL_CREDENTIAL_SCOPE=staging pnpm run build
 * ```
 *
 * Default `plugins`. It decides two things, and it decides both at once —
 * which is the point:
 *
 * | Used as | Default |
 * |---|---|
 * | keyring service name | `aishell-dsh-plugins` |
 * | encrypted file name | `plugins.credentials.enc` |
 *
 * ## Why it is a build-time constant
 *
 * The value has to be the same on both sides of a credential: the writer that
 * stores it and the reader that looks it up. A runtime setting can be applied
 * to one plugin and not another, and the result is a form that says "saved"
 * beside tools that say "not authenticated" — a failure whose only symptom is
 * the one thing the setting exists to control.
 *
 * A constant cannot be set on one side only. Two deployments that must not see
 * each other's credentials (a staging profile beside a production one) differ
 * by *building* differently, which is the honest place for a persistence
 * boundary.
 *
 * ## Why the default namespace carries no migration path
 *
 * `plugins` is the first and only scope, so a build that sets nothing lands on
 * it and a build that sets something has deliberately moved to a namespace of
 * its own. There are no two names to reconcile, so there is no migration path
 * to write — and none is needed until a release renames this default.
 *
 * @module @huaweidevtools/aishell-dsh-credentials-store/scope
 */

/**
 * The default scope.
 *
 * Named for the repository, not for a feature: the credential store is shared
 * by every plugin in this set, so it is not `llm`'s or `e2b`'s.
 */
export const DEFAULT_SCOPE = 'plugins'

/**
 * Injected at build time; see `tsdown.config.ts`.
 *
 * Declared as possibly-absent because a source run (the test suite, which
 * resolves `src/` directly) never passes through the bundler. The `typeof`
 * guard below handles that without a `ReferenceError`.
 */
declare const __AISHELL_CREDENTIAL_SCOPE__: string | undefined

/**
 * Accepted scope shape: a lowercase identifier.
 *
 * The value reaches a keyring service name and a file name, so it is validated
 * as a strict identifier rather than merely "not obviously a path": no
 * separators, no dots, no leading dash. Assuming a value is benign because the
 * caller is trusted is how path traversal gets in.
 */
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * Resolve the scope for this build.
 *
 * Fails loudly on a malformed value rather than falling back to the default:
 * a typo would otherwise silently share the namespace with every unset build,
 * which is exactly the confusion scoping exists to avoid.
 *
 * @returns the validated scope.
 * @throws when the injected value is not a valid scope.
 */
function resolveScope(): string {
  // `typeof` rather than a direct read: an undeclared identifier throws, and a
  // source run legitimately has no injected value.
  const injected = typeof __AISHELL_CREDENTIAL_SCOPE__ === 'string'
    ? __AISHELL_CREDENTIAL_SCOPE__
    : undefined
  if (injected === undefined || injected === '') return DEFAULT_SCOPE
  const normalized = injected.trim().toLowerCase()
  if (normalized.length === 0) return DEFAULT_SCOPE
  if (!SCOPE_PATTERN.test(normalized)) {
    throw new Error(
      `AISHELL_CREDENTIAL_SCOPE=${JSON.stringify(injected)} is not a valid credential scope: `
      + `expected 1-64 characters of [a-z0-9_-], starting with a letter or digit `
      + '(for example "plugins" or "staging").',
    )
  }
  return normalized
}

/** The scope this build uses. */
export const CREDENTIAL_SCOPE = resolveScope()

/**
 * The keyring service every entry of this build lives under.
 *
 * Part of the persistence contract: renaming it orphans every stored entry
 * while looking like a harmless constant change.
 */
export const KEYRING_SERVICE = `aishell-dsh-${CREDENTIAL_SCOPE}`

/**
 * The encrypted file name for this build.
 *
 * Scoped the same way as the keyring service, so two builds on one machine
 * cannot collide in either backend.
 */
export const CREDENTIALS_FILE_NAME = `${CREDENTIAL_SCOPE}.credentials.enc`