/**
 * Parsing and family normalisation for incoming deep links.
 *
 * Pure functions with no cordis dependency, so the rules that decide whether a
 * URL is admitted can be tested without a plugin tree.
 *
 * @module @huaweidevtools/aishell-dsh-deeplink/link
 */

/** The scheme this transport owns. */
export const SCHEME = 'aishell:'

/** One admitted link: the normalised family and the URL as sent. */
export interface DeepLink {
  /** Lowercase hostname segment, e.g. `share`. */
  readonly family: string
  /** The complete URL, in its canonical string form. */
  readonly href: string
}

/**
 * Admit one URL the operating system handed to the shell.
 *
 * Returns `undefined` for anything this transport does not own: a string that
 * is not a URL, a foreign scheme, or no hostname segment. Those are dropped
 * rather than reported — the sender may be a plugin version this build has
 * never seen.
 *
 * Two normalisations happen here, both required by what `URL` does with a
 * non-special scheme:
 *
 * - **The family is lowercased.** `https://X.COM` becomes `x.com`, but
 *   `aishell://Share/x` keeps `Share`, so a claim registered in one case would
 *   miss a link sent in another.
 * - **The fragment is removed.** A fragment never reaches a server and means
 *   nothing to this transport; keeping it would make two links that differ only
 *   after `#` compare unequal.
 *
 * @param raw - the URL exactly as received.
 * @returns the admitted link, or undefined when it is not ours.
 */
export function admit(raw: string): DeepLink | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== SCHEME) return undefined
  const family = url.hostname.toLowerCase()
  if (family === '') return undefined
  url.hash = ''
  return { family, href: url.href }
}