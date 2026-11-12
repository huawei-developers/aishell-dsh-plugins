/**
 * The path the deep-link stream is registered on.
 *
 * The Host registers the absolute form; the Page addresses the
 * document-relative form, the same split every `/api` route in this set uses.
 *
 * @module @huaweidevtools/aishell-dsh-deeplink/route
 */

/** Absolute registration path on the Host. */
export const DEEPLINK_ROUTE = '/api/aishell/deep-link'

/** Document-relative form the Page addresses. */
export const DEEPLINK_CLIENT_ROUTE = 'api/aishell/deep-link'