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
 * @param url - a URL whose hostname is `share`.
 * @returns the kind and id, or undefined when the link names neither.
 */
export function readSharePath(url: URL): { kind: string, id: string } | undefined {
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const [kind, ...rest] = segments
  if (kind === undefined || rest.length === 0) return undefined
  return { kind, id: rest.join('/') }
}