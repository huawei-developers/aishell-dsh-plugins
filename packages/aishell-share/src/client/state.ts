/**
 * The share dialog's state.
 *
 * One dialog, two flows. Sharing walks confirm → working → done; importing
 * walks loading → preview → choosing a workspace → working. The transitions are
 * pure, so what a reader sees at each step can be asserted without a renderer.
 *
 * A state is not a message: the component maps it to copy, and keeping the
 * mapping out of here is what lets both flows share one machine.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/state
 */

import type { SharePackage } from '../package.ts'
import type { ServiceFailure } from '../service.ts'

/** One directory an import can land in. */
export interface WorkspaceChoice {
  /** Stable identity, used as the list key. */
  readonly id: string
  /** What the row shows. */
  readonly title: string
  /** The directory itself, passed to the import. */
  readonly path: string
}

/** What the dialog is showing. */
export type ShareState =
  /** Nothing open. */
  | { readonly kind: 'closed' }
  /**
   * Sharing: before anything leaves the machine.
   *
   * `messageId` is present when the reader started from a message's action row;
   * the package then carries the conversation through that message's Turn. It
   * travels with the state because the confirmation and the upload must name
   * the same thing — a dialog that promised a prefix and sent everything would
   * disclose more than the reader agreed to.
   */
  | { readonly kind: 'confirm-share', readonly sessionId: string, readonly messageId?: string }
  /**
   * Sharing: the package is being uploaded.
   *
   * Carries what `confirm-share` carried, because the upload is what needs the
   * message id: the cut is applied by the Host when it builds the package.
   */
  | { readonly kind: 'sharing', readonly sessionId: string, readonly messageId?: string }
  /**
   * Sharing: done, with the link to hand out.
   *
   * `copied` is deliberately absent. A successful copy is reported by a
   * transient banner outside the card — the link and the two buttons do not
   * change, because a card that rewrites itself to say "copied" makes the
   * reader re-find the thing they were looking at.
   */
  | { readonly kind: 'shared', readonly url: string }
  /** Importing: the package is being fetched. */
  | { readonly kind: 'fetching', readonly link: string }
  /**
   * Importing: the conversation, before anything is written.
   *
   * The link is gone from here on: everything after this point acts on the
   * package in hand, so nothing downstream needs to name the URL again.
   */
  | { readonly kind: 'preview', readonly session: SharePackage }
  /**
   * Importing: picking where the copy lands.
   *
   * A session is grouped by its directory, so an import with nowhere to go
   * asks — the same way a new conversation asks before it starts.
   */
  | {
    readonly kind: 'choose-workspace'
    readonly session: SharePackage
    /** The directories the reader can pick from. */
    readonly workspaces: readonly WorkspaceChoice[]
  }
  /** Importing: the copy is being created. */
  | { readonly kind: 'importing', readonly session: SharePackage }
  /** A step failed; the reader can close. */
  | { readonly kind: 'failed', readonly stage: 'share' | 'import', readonly reason: ServiceFailure }

/** The initial state. */
export const CLOSED: ShareState = { kind: 'closed' }

/** Whether the dialog is on screen at all. */
export function isOpen(state: ShareState): boolean {
  return state.kind !== 'closed'
}

/**
 * Open the dialog for sharing one session.
 *
 * @param sessionId - the conversation to share.
 * @param messageId - the message the reader acted on, when the share started
 *   from a message's action row. The package then stops at that message's Turn.
 * @returns the confirm state; nothing has left the machine yet.
 */
export function beginShare(sessionId: string, messageId?: string): ShareState {
  return {
    kind: 'confirm-share',
    sessionId,
    ...messageId === undefined ? {} : { messageId },
  }
}

/**
 * Open the dialog for one incoming link.
 *
 * The link is kept only until the package arrives: from the preview onward
 * every step acts on the package, so the URL has no further use.
 *
 * @param link - the `aishell://share/...` URL as delivered.
 * @returns the fetching state.
 */
export function beginImport(link: string): ShareState {
  return { kind: 'fetching', link }
}

/**
 * Move one step forward.
 *
 * @param state - the current state.
 * @param event - what happened.
 * @returns the next state; the same reference when the event does not apply.
 */
export function advance(
  state: ShareState,
  event:
    | { readonly type: 'confirm-share' }
    | { readonly type: 'shared', readonly url: string }
    | { readonly type: 'fetched', readonly session: SharePackage }
    | { readonly type: 'choose', readonly workspaces: readonly WorkspaceChoice[] }
    | { readonly type: 'import' }
    | { readonly type: 'imported' }
    | { readonly type: 'failed', readonly reason: ServiceFailure },
): ShareState {
  switch (event.type) {
    case 'confirm-share':
      return state.kind === 'confirm-share'
        ? {
          kind: 'sharing',
          sessionId: state.sessionId,
          ...state.messageId === undefined ? {} : { messageId: state.messageId },
        }
        : state

    case 'shared':
      return state.kind === 'sharing'
        ? { kind: 'shared', url: event.url }
        : state

    case 'fetched':
      return state.kind === 'fetching'
        ? { kind: 'preview', session: event.session }
        : state

    case 'choose':
      return state.kind === 'preview'
        ? { kind: 'choose-workspace', session: state.session, workspaces: event.workspaces }
        : state

    case 'import':
      return state.kind === 'preview' || state.kind === 'choose-workspace'
        ? { kind: 'importing', session: state.session }
        : state

    case 'imported':
      // The copy exists; the dialog has nothing left to show.
      return state.kind === 'importing' ? CLOSED : state

    case 'failed': {
      if (state.kind === 'closed' || state.kind === 'failed') return state
      const stage = isSharing(state) ? 'share' : 'import'
      return { kind: 'failed', stage, reason: event.reason }
    }
  }
}

/** Whether a state belongs to the sharing flow. */
function isSharing(state: ShareState): boolean {
  return state.kind === 'confirm-share' || state.kind === 'sharing' || state.kind === 'shared'
}