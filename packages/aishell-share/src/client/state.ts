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
   * Importing: no link yet, and the reader is typing one.
   *
   * The incoming-link flow starts from a URL the shell already has, so
   * `fetching` is its first state. A reader who starts from a Workspace's menu
   * has no URL at all — the link is what they came to paste — and a dialog that
   * opened on `fetching` would be fetching nothing.
   */
  | {
    readonly kind: 'enter-link'
    /**
     * Where the copy will land, when the caller already knows.
     *
     * A Workspace menu names its Workspace, so the import skips the directory
     * question. Absent for a dialog opened without a context that picks one.
     */
    readonly presetCwd?: string
  }
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
  | {
    readonly kind: 'fetching'
    readonly link: string
    /** Where the copy lands, when the caller named it before the fetch. */
    readonly presetCwd?: string
  }
  /**
   * Importing: the conversation, before anything is written.
   *
   * The link is gone from here on: everything after this point acts on the
   * package in hand, so nothing downstream needs to name the URL again.
   */
  | {
    readonly kind: 'preview'
    readonly session: SharePackage
    /**
     * The directory the copy goes to, when the caller already named one.
     *
     * Set when the import started from a Workspace's menu: that Workspace is
     * the reader's answer to "where should this land", and asking again would
     * be asking them to repeat themselves. Absent for an incoming link, which
     * arrives with no such context.
     */
    readonly presetCwd?: string
  }
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
 * @param presetCwd - where the copy lands, when the caller already knows.
 *   Carried through to the preview so the directory question can be skipped.
 * @returns the fetching state.
 */
export function beginImport(link: string, presetCwd?: string): ShareState {
  return { kind: 'fetching', link, ...presetCwd === undefined ? {} : { presetCwd } }
}

/**
 * Open the dialog with no link yet.
 *
 * @param presetCwd - where the copy lands, when the caller already knows.
 * @returns the state that shows the link field.
 */
export function beginLinkEntry(presetCwd?: string): ShareState {
  return { kind: 'enter-link', ...presetCwd === undefined ? {} : { presetCwd } }
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
      if (state.kind !== 'fetching') return state
      // The preset travels with the package: the preview is the state that
      // decides whether to ask for a directory, so it is the state that has to
      // know one was already named.
      return {
        kind: 'preview',
        session: event.session,
        ...state.presetCwd === undefined ? {} : { presetCwd: state.presetCwd },
      }

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
      // The two states `flowOf` leaves undefined are exactly the two this
      // branch does not reach, so the answer is always one of the flows. The
      // fallback stays explicit rather than asserted: a cast here would keep
      // compiling if a new state were added with no flow.
      const flow = state.kind === 'closed' || state.kind === 'failed' ? undefined : flowOf(state)
      return flow === undefined ? state : { kind: 'failed', stage: flow, reason: event.reason }
    }
  }
}

/** The two flows the one dialog serves. */
export type Flow = 'share' | 'import'

/**
 * Which flow a state belongs to.
 *
 * The dialog is one surface with one button row, so the copy that names it —
 * the card's title — has to come from the state rather than from whichever
 * entry point opened it. A reader who asked to import should not be looking at
 * a card headed "Share session".
 *
 * A failure belongs to the flow it happened in, not to the one the reader might
 * have expected, so `failed` answers with its own `stage`.
 *
 * Every open state answers. `undefined` is `closed` alone: nothing is showing,
 * so there is no flow to name.
 *
 * @param state - the state to classify.
 * @returns the flow, or undefined while nothing is open.
 */
export function flowOf(state: ShareState): Flow | undefined {
  switch (state.kind) {
    case 'closed': return undefined
    case 'failed': return state.stage
    case 'confirm-share':
    case 'sharing':
    case 'shared': return 'share'
    case 'enter-link':
    case 'fetching':
    case 'preview':
    case 'choose-workspace':
    case 'importing': return 'import'
  }
}