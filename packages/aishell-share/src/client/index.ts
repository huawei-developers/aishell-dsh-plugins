/**
 * Session sharing, Page half.
 *
 * Two things: claim the `share` family so incoming links reach a surface, and
 * host the dialog both flows use. The claim is here — not in the Host — because
 * `aishellDeepLinks` is provided by the transport in the Page.
 *
 * The `share` family is a namespace, not a single resource:
 * `share/session/<id>` today, other kinds later, all owned by this plugin. A
 * link whose kind this build does not handle is ignored rather than reported —
 * the sender may be a newer version.
 *
 * @module @huaweidevtools/aishell-dsh-share/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.slots merge (the renderer owns the slot registry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the shell.overlay slot contract.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the chat plugin's slot ledger entry for the Turn action row.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the ctx.contextMenus merge and the `workspace` target shape,
// which is what a Workspace's own menu row registers into.
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
// Type-only: pulls ctx.aishellDeepLinks from the transport's Page half.
import type {} from '@huaweidevtools/aishell-dsh-deeplink/client'

import { createElement } from 'react'
import { IconDownloadOutlineRegular, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'

import type { SharePackage } from '../package.ts'
import { FAMILY, readShareId, SHARE_CLIENT_ROUTE } from '../route.ts'
import { createShareMachine, type ShareDriver } from './machine.ts'
import { openSessionAfterRefresh } from './open-session.ts'
import { installDialStyles } from './dial.ts'
import { installDialogStyles } from './styles.ts'
import { ShareMessageAction, type ShareMessageActionInjected } from './ShareMessageAction.tsx'
import { SharePreview, type SharePreviewInjected } from './SharePreview.tsx'
import { ShareSessionMenuItem, type ShareSessionMenuItemInjected } from './ShareSessionMenuItem.tsx'
import { NS, zh, en } from './locales.ts'

export { advance, beginImport, beginShare, CLOSED, flowOf, isOpen, type Flow, type ShareState } from './state.ts'
export { createShareMachine, type ShareDriver, type ShareMachine } from './machine.ts'
export { openSessionAfterRefresh, type OpenSessionDeps } from './open-session.ts'

export const name = 'aishell-share'

/**
 * Icon key for the Workspace menu's import row.
 *
 * Prefixed like every other key this plugin owns, so it cannot collide with a
 * shipped `workspace.*` glyph.
 */
const IMPORT_MENU_ICON = 'aishell-share.import'

export const inject = ['slots', 'locale', 'aishellDeepLinks', 'contextMenus']

/**
 * What the Host route answers.
 *
 * The Page does not decide what a failure means — the Host mapped an HTTP
 * status, and this only relays it.
 */
type HostAnswer =
  | { readonly ok: true, readonly url: string }
  | { readonly ok: true, readonly session: SharePackage }
  | { readonly ok: true, readonly sessionId: string }
  | { readonly ok: false, readonly reason: string }

/**
 * Call the Host route once.
 *
 * @param body - the request, as the Host's handler reads it.
 * @param signal - the reader's cancellation. Forwarded to `fetch` so the abort
 *   reaches the Host: the connection bridge binds `request.signal` to the
 *   response's `close`, so dropping the connection is what stops the work.
 * @returns the answer, or a rejection when the route could not be reached.
 */
async function askHost(body: unknown, signal: AbortSignal): Promise<HostAnswer> {
  const response = await fetch(SHARE_CLIENT_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }).catch(() => undefined)
  if (response?.ok !== true) return { ok: false, reason: 'unavailable-service' }
  // A body that is not the answer — a proxy's error page, a truncated read —
  // is a failed call, not a crash inside the dialog.
  const answer = await response.json().catch(() => undefined) as HostAnswer | undefined
  return answer ?? { ok: false, reason: 'unavailable-service' }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aishell-share: dictionaries')
  installDialStyles(ctx)
  installDialogStyles(ctx)

  const driver: ShareDriver = {
    copy: (text) => writeClipboard(text),

    workspaces: () => {
      const workspaces = ctx.get('workspaces') as { list: { getSnapshot: () => { items: readonly { workspaceId: string, path: string, title: string }[] } } } | undefined
      const snapshot = workspaces?.list.getSnapshot()
      if (snapshot === undefined) return []
      return snapshot.items.map((item) => ({ id: item.workspaceId, title: item.title, path: item.path }))
    },

    pickWorkspace: async () => {
      const ui = ctx.get('uiWorkspace') as { pickDirectory: () => Promise<string | null> } | undefined
      const registry = ctx.get('workspaces') as { create: (input: { path: string }) => Promise<unknown> } | undefined
      if (ui === undefined || registry === undefined) return undefined
      const picked = await ui.pickDirectory().catch(() => null)
      if (picked === null || picked === '') return undefined
      // A session is grouped by a directory the shell knows about, so a
      // directory that is not yet a workspace is adopted before it is used.
      // `create` is idempotent, so an existing one resolves to itself.
      await registry.create({ path: picked }).catch(() => undefined)
      return picked
    },
    share: async (sessionId, messageId, signal) => {
      const answer = await askHost({
        op: 'share',
        sessionId,
        ...messageId === undefined ? {} : { messageId },
      }, signal)
      return answer.ok && 'url' in answer
        ? { ok: true, url: answer.url }
        : { ok: false, reason: 'reason' in answer ? toFailure(answer.reason) : 'rejected' }
    },
    fetch: async (id, signal) => {
      const answer = await askHost({ op: 'fetch', id }, signal)
      return answer.ok && 'session' in answer
        ? { ok: true, session: answer.session }
        : { ok: false, reason: 'reason' in answer ? toFailure(answer.reason) : 'rejected' }
    },
    import: async (session, cwd, signal) => {
      const answer = await askHost({ op: 'import', session, cwd }, signal)
      return answer.ok && 'sessionId' in answer
        ? { ok: true, sessionId: answer.sessionId }
        : { ok: false, reason: 'reason' in answer ? toFailure(answer.reason) : 'rejected' }
    },

    open: (sessionId) => {
      // The copy is a stored session, so this is the ordinary navigation the
      // sidebar performs when a row is clicked.
      const ui = ctx.get('uiWorkspace') as { openSession: (id: string) => void } | undefined
      // The session is newer than this client's list snapshot, and navigation
      // resolves ids against that snapshot. See `./open-session.ts` for why the
      // pull has to land first and why a failed one still opens.
      const sessions = ctx.get('sessions') as { refresh: () => Promise<void> } | undefined
      void openSessionAfterRefresh(sessionId, {
        refresh: sessions === undefined
          ? () => Promise.resolve()
          : () => sessions.refresh(),
        // A shell without the workspace service cannot navigate at all. Thrown
        // rather than skipped so it reaches `onOpenFailed` with the others: an
        // import that stored the session and then did nothing is the outcome
        // this whole path exists to make visible.
        open: (id) => {
          if (ui === undefined) throw new Error('the shell offers no workspace navigation')
          ui.openSession(id)
        },
        onOpenFailed: (error, id) => {
          ctx.logger(name).warn(`could not open imported session ${id}: ${String(error)}`)
        },
      })
    },
  }

  const machine = createShareMachine(driver)

  ctx.effect(() => ctx.aishellDeepLinks.claim(FAMILY, (url: URL) => {
    // A kind this build does not handle is ignored rather than reported: the
    // sender may be a newer version, and the claim answers for the whole family.
    if (readShareId(url) === undefined) return
    machine.openLink(url.href)
  }), 'aishell-share: share family')

  // The row that starts a share. `order: 350` places it after the shipped
  // `fork` (300) and before the archive section, which the host flags with a
  // separator — so this lands with the actions on a conversation.
  ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'aishell-share',
    order: 350,
    locale: NS,
    inject: (): ShareSessionMenuItemInjected => ({
      startShare: (sessionId) => { machine.shareSession(sessionId) },
    }),
  }, ShareSessionMenuItem)), 'aishell-share: menu row')

  // Import, from a Workspace's own menu.
  //
  // `ctx.contextMenus` rather than a slot: the shipped row and delete actions
  // are built-in contributions, and the slot documentation says plainly that
  // slot priority cannot replace or join them. A structured contribution is the
  // supported way to add a row to that menu, and it is the same registry the
  // shipped entries use.
  //
  // The target carries the Workspace's absolute `path`, so the import lands
  // where the reader right-clicked without a second question. That is the one
  // difference from an incoming link, which arrives with no such context.
  ctx.effect(() => ctx.contextMenus.register({
    id: 'aishell-share.import',
    target: 'workspace',
    // Before rename (100): importing into a Workspace is what a reader comes to
    // that menu for far more often than renaming it.
    order: 50,
    resolve: (workspace) => [{
      id: 'import',
      label: ctx.locale.bind(NS)('menu.importSession'),
      // Every other row in this menu carries one, and a bare label among them
      // reads as unfinished rather than as a different kind of action.
      icon: { key: IMPORT_MENU_ICON },
      run: () => { machine.requestImport(workspace.path) },
    }],
  }), 'aishell-share: workspace import action')

  // The renderer for that key. `contextMenu.icon` is a keyed slot: an action
  // names a string, and whoever owns the glyph registers it here. Without this
  // the action still appears — it simply has no icon.
  ctx.effect(() => ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
    name: 'contextMenu.icon',
    key: IMPORT_MENU_ICON,
  }, () => createElement(IconDownloadOutlineRegular, { size: 16 }))), 'aishell-share: import menu icon')

  // The share button in a completed Turn's action row. `inject` receives the
  // session id, so a row in any conversation opens that conversation's dialog;
  // the message id it also passes is what the Host cuts the package at.
  //
  // `order: 20` places it after the shipped Like/Dislike pair (10). Slot entries
  // all land in the same seat — the chat package renders
  // `[copy] extraActions [branch]` — so this is not "after branch"; it is the
  // second entry in the gap between copy and branch, beside the rating pair.
  ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'aishell-share',
    order: 20,
    locale: NS,
    inject: (sessionId: string): ShareMessageActionInjected => ({
      shareTurn: (messageId) => { machine.shareSession(sessionId, messageId) },
    }),
  }, ShareMessageAction)), 'aishell-share: turn action')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'aishell-share',
    locale: NS,
    inject: (): SharePreviewInjected => ({ hooks: { share: machine }, actions: machine }),
  }, SharePreview)), 'aishell-share: dialog')
}

/**
 * Narrow a reason string to the failure vocabulary.
 *
 * @param reason - what the Host reported.
 * @returns the failure a dialog can show.
 */
function toFailure(reason: string): 'rejected' | 'unavailable' | 'too-large' | 'unavailable-service' | 'bad-request' {
  switch (reason) {
    case 'unavailable': return 'unavailable'
    case 'too-large': return 'too-large'
    case 'unavailable-service': return 'unavailable-service'
    case 'bad-request': return 'bad-request'
    default: return 'rejected'
  }
}