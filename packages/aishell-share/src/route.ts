/**
 * Everything both halves must agree on, and nothing either may import the
 * other for.
 *
 * Its own module because the Host half pulls in the session store and
 * `node:path`; a Page importing any value from there would drag those into the
 * browser bundle. Only constants and pure functions belong here.
 *
 * @module @huaweidevtools/aishell-dsh-share/route
 */

/** Absolute registration path on the Host. */
export const SHARE_ROUTE = '/api/aishell/share'

/** Document-relative form the Page addresses. */
export const SHARE_CLIENT_ROUTE = 'api/aishell/share'

/**
 * The URL family this plugin owns, as the hostname a share link carries.
 *
 * Lowercase, because the transport lowercases a hostname before it claims a
 * family — a link spelled `AISHELL://SHARE/...` keeps its case in `URL`, so
 * every comparison is made against this form.
 */
export const FAMILY = 'share'

/**
 * The resource kind in a share link, and the segment the service is called on.
 *
 * `share` is a family, not a single resource: `share/session/<id>` today, other
 * kinds later.
 */
export const SESSION_KIND = 'session'

/**
 * Read the resource kind and id out of a `share` link.
 *
 * The kind is the first segment; **everything after it is the id**, joined back
 * with slashes. The id is the service's to spell — it may be one opaque token
 * today and a path of its own later — so this parser must not be the thing that
 * decides how many segments a link may have. Splitting at the first slash is
 * also what keeps `share/session/a/b` and `share/file/f1/x/y` from needing a
 * new claimant: the family grows by kind, not by arity.
 *
 * A link with no kind, or a kind this build does not handle, is not an error —
 * a sender may be a newer version.
 *
 * This reads the grammar only, so it presumes the family has already matched.
 * {@link readShareId} is the admission that establishes both.
 *
 * @param url - a URL whose hostname is `share`.
 * @returns the kind and id, or undefined when the link names neither.
 */
export function readSharePath(url: URL): { kind: string, id: string } | undefined {
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const [kind, ...rest] = segments
  if (kind === undefined || rest.length === 0) return undefined
  return { kind, id: rest.join('/') }
}

/**
 * Read a session id out of a share link, and out of nothing else.
 *
 * The whole admission, in one place: family and kind. A link is a share link
 * because it names this family and a kind this build acts on — not because its
 * path happens to have two segments. The distinction matters at both call
 * sites. The claim only ever sees links the transport admitted for this family,
 * so for it the answer is already yes; a reader pasting into the import field
 * has whatever was on their clipboard, and `https://example.com/a/b` would
 * otherwise hand `b` to the service as an id — a lookup for a resource nobody
 * named, and a preview of an unrelated conversation if the id happens to exist.
 *
 * The scheme is deliberately not checked. The family is what identifies a link
 * here, and a deployment whose service spells its links with another scheme
 * would still be naming this plugin's resources.
 *
 * @param link - a URL, or its string form as delivered or pasted.
 * @returns the id, or undefined when the link is not one of this plugin's.
 */
export function readShareId(link: string | URL): string | undefined {
  let url: URL
  try {
    url = typeof link === 'string' ? new URL(link) : link
  } catch {
    return undefined
  }
  if (url.hostname.toLowerCase() !== FAMILY) return undefined
  const path = readSharePath(url)
  return path !== undefined && path.kind === SESSION_KIND ? path.id : undefined
}