/**
 * The share dialog's state machine, and what moves it.
 *
 * Pure transitions, held in a store the component reads. The two flows share
 * one machine because they share one surface: a reader never has two dialogs
 * open, and a second link arriving replaces whatever was showing.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/machine
 */

import type { SharePackage } from '../package.ts'
import { readShareId } from '../route.ts'
import type { ServiceFailure } from '../service.ts'
import {
  advance,
  beginImport,
  beginLinkEntry,
  beginShare,
  CLOSED,
  type ShareState,
  type WorkspaceChoice,
} from './state.ts'

/**
 * What the machine needs from outside itself.
 *
 * The three calls are the Host route's three operations; keeping them behind an
 * interface is what lets the transitions be driven in a test.
 *
 * Every call takes a `signal` the machine aborts when the reader closes the
 * dialog. It is the caller's job to forward it to `fetch`: an aborted request
 * is how the Host learns to stop, so a driver that drops the signal turns
 * cancel back into "stop watching".
 */
export interface ShareDriver {
  /**
   * Upload one session and answer its link.
   *
   * `messageId` is passed when the share started from a message's action row;
   * the Host then carries the conversation only through that message's Turn.
   */
  readonly share: (sessionId: string, messageId: string | undefined, signal: AbortSignal) => Promise<{ ok: true, url: string } | { ok: false, reason: ServiceFailure }>
  /** Fetch one package. */
  readonly fetch: (id: string, signal: AbortSignal) => Promise<{ ok: true, session: SharePackage } | { ok: false, reason: ServiceFailure }>
  /**
   * Create the local copy under the given workspace directory.
   *
   * The package is the one already shown, not an id to fetch again: the reader
   * agreed to what was on screen.
   *
   * `cwd` is the **workspace directory** the copy is filed under — the path
   * the sidebar groups by. Not this application's own directory, and not the
   * sender's.
   */
  readonly import: (session: SharePackage, cwd: string, signal: AbortSignal) => Promise<{ ok: true, sessionId: string } | { ok: false, reason: ServiceFailure }>
  /**
   * Show one session, once its copy exists.
   *
   * The import writes a stored log; nothing opens it. Without this the reader
   * is left on the sidebar looking for a row they just created.
   *
   * @param sessionId - the session to display.
   */
  readonly open: (sessionId: string) => void
  /**
   * The directories an import can land in, as the shell currently lists them.
   *
   * Read when the reader asks to import, not earlier: a workspace can be
   * added while the preview is up.
   */
  readonly workspaces: () => readonly WorkspaceChoice[]
  /**
   * Ask the shell for a directory, adopting it as a workspace.
   *
   * The same picker a new conversation uses. A directory that is not yet a
   * workspace is registered before it is used, because a session is grouped
   * by a directory the shell knows about.
   *
   * @returns the chosen directory, or undefined when the reader cancelled.
   */
  readonly pickWorkspace: () => Promise<string | undefined>
  /**
   * Write the link to the clipboard.
   *
   * Reported rather than assumed: a refused clipboard leaves the dialog
   * showing the link itself, which the reader can still select.
   *
   * @returns whether the write was accepted.
   */
  readonly copy: (text: string) => Promise<boolean>
}

/** The observable the dialog reads, plus the actions that drive it. */
export interface ShareMachine {
  readonly getSnapshot: () => ShareState

  readonly subscribe: (listener: () => void) => () => void
  /**
   * Ask to share one session; the dialog opens on the confirmation.
   *
   * @param sessionId - the conversation to share.
   * @param messageId - the message the reader acted on, when the share started
   *   from a message's action row; the package then stops at that message's
   *   Turn. Omitted, the whole conversation is shared.
   */
  readonly shareSession: (sessionId: string, messageId?: string) => void
  /**
   * Open the link field, for a reader who has a link to paste.
   *
   * @param presetCwd - the directory the copy lands in, when the caller is a
   *   Workspace's own menu and has already named one. Omitted, the import asks.
   */
  readonly requestImport: (presetCwd?: string) => void
  /**
   * Open on an incoming link and start fetching.
   *
   * @param link - the URL the shell delivered.
   * @param presetCwd - where the copy lands, when the caller already knows.
   */
  readonly openLink: (link: string, presetCwd?: string) => void
  /** The reader confirmed the upload. */
  readonly confirmShare: () => void
  /**
   * The reader asked to import what is previewed.
   *
   * Asks where the copy should land unless one was named before the fetch —
   * a Workspace menu already answered that question, and asking again would be
   * asking the reader to repeat themselves. Without a preset it always asks,
   * even with a single workspace listed: the copy is a durable addition to
   * someone's machine, and the directory it joins is their decision rather than
   * a default this code picks.
   */
  readonly importPreview: () => void
  /** The reader picked one of the offered directories. */
  readonly importInto: (cwd: string) => void
  /** The reader asked to browse for a directory. */
  readonly browseForWorkspace: () => Promise<void>
  /** The reader closed the dialog. */
  readonly close: () => void
  /**
   * The link was copied.
   *
   * Async: the clipboard write is what decides, and a refused write must not
   * be reported as a copy.
   *
   * @returns whether the write was accepted, so the caller can raise the
   *   banner. The machine does not hold the banner: it is transient and lives
   *   outside the card, and a state in here would have to be cleared by a
   *   timer — a second kind of state with its own clock.
   */
  readonly copyLink: () => Promise<boolean>
}

/**
 * Create the machine.
 *
 * @param driver - the Host calls; each is assumed to answer, never throw.
 * @returns the machine, seeded closed.
 */
export function createShareMachine(driver: ShareDriver): ShareMachine {
  const listeners = new Set<() => void>()
  let state: ShareState = CLOSED

  /**
   * The request behind the state currently on screen, if one is running.
   *
   * Closing aborts it. The Page's `fetch` abort reaches the Host as
   * `request.signal`, which the route hands to the service call and to the
   * storage write — so "cancel" stops the work rather than merely stopping the
   * watching. Replaced on every new request, and cleared when one settles.
   */
  let inflight: AbortController | undefined

  /**
   * Bumped every time the dialog opens or closes.
   *
   * An aborted request can still answer — a service that ignores its signal, a
   * write already past its last check — and an answer that comes back has to
   * prove the dialog it was started for is still the one on screen before it
   * publishes. Otherwise a finished upload would reopen a card the reader had
   * dismissed, and a finished import would navigate away from whatever they had
   * moved on to.
   */
  let generation = 0

  const publish = (next: ShareState): void => {
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
  }

  /**
   * Publish an answer, but only if the dialog it belongs to is still open.
   *
   * @param started - the generation the request was started in.
   * @param next - the state the answer moves to.
   */
  const publishFrom = (started: number, next: ShareState): void => {
    if (started !== generation) return
    publish(next)
  }

  /**
   * Open one request, aborting whatever it replaces.
   *
   * @returns the controller and the generation the request runs in. The caller
   *   hands `controller.signal` to the driver and calls {@link settleRequest}
   *   when it answers, so a later close does not abort a request that is already
   *   over.
   */
  const beginRequest = (): { readonly controller: AbortController, readonly started: number } => {
    inflight?.abort()
    const controller = new AbortController()
    inflight = controller
    return { controller, started: generation }
  }

  /**
   * Release a settled request, leaving a newer one alone.
   *
   * @param controller - the request that settled.
   */
  const settleRequest = (controller: AbortController): void => {
    if (inflight === controller) inflight = undefined
  }

  const fetchInto = async (link: string): Promise<void> => {
    const { controller, started } = beginRequest()
    // `readShareId` is the whole admission — family and kind — and it is shared
    // with the claim, so the two cannot disagree about what a link means. A
    // second split here is how a machine that accepts `share/session/a/b` ends
    // up fetching `a` instead of `a/b`.
    //
    // Admission rather than parsing is what this needs: the claim has already
    // filtered by family, but a link the reader pasted into the import field has
    // not, and a foreign path that happens to have two segments would otherwise
    // be read as an id and looked up.
    const id = readShareId(link)
    if (id === undefined) {
      settleRequest(controller)
      publishFrom(started, advance(state, { type: 'failed', reason: 'rejected' }))
      return
    }
    const result = await driver.fetch(id, controller.signal)
      .finally(() => { settleRequest(controller) })
    publishFrom(started, result.ok
      ? advance(state, { type: 'fetched', session: result.session })
      : advance(state, { type: 'failed', reason: result.reason }))
  }

  const uploadFrom = async (sessionId: string, messageId?: string): Promise<void> => {
    const { controller, started } = beginRequest()
    const result = await driver.share(sessionId, messageId, controller.signal)
      .finally(() => { settleRequest(controller) })
    publishFrom(started, result.ok
      ? advance(state, { type: 'shared', url: result.url })
      : advance(state, { type: 'failed', reason: result.reason }))
  }

  const importFrom = async (session: SharePackage, cwd: string): Promise<void> => {
    const { controller, started } = beginRequest()
    const result = await driver.import(session, cwd, controller.signal)
      .finally(() => { settleRequest(controller) })
    // A failure is published even to a dialog the reader has since dismissed:
    // it changes nothing on their machine, so there is nothing to withhold, and
    // the state machine's `failed` only applies while the dialog is still in an
    // import posture. Success is different — see below.
    if (!result.ok) {
      publish(advance(state, { type: 'failed', reason: result.reason }))
      return
    }
    // The copy exists — the Host wrote it, and closing the dialog does not
    // unwrite it. What the generation decides is only whether this dialog gets
    // to announce it: navigating a reader who has dismissed the card would take
    // them somewhere they did not ask to go.
    if (started !== generation) return
    publish(advance(state, { type: 'imported' }))
    driver.open(result.sessionId)
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    shareSession(sessionId: string, messageId?: string): void {
      // A new dialog supersedes whatever was in flight for the old one.
      inflight?.abort()
      inflight = undefined
      generation += 1
      publish(beginShare(sessionId, messageId))
    },

    requestImport(presetCwd?: string): void {
      inflight?.abort()
      inflight = undefined
      generation += 1
      publish(beginLinkEntry(presetCwd))
    },

    openLink(link: string, presetCwd?: string): void {
      inflight?.abort()
      inflight = undefined
      generation += 1
      publish(beginImport(link, presetCwd))
      void fetchInto(link)
    },

    confirmShare(): void {
      const current = state
      publish(advance(state, { type: 'confirm-share' }))
      if (current.kind === 'confirm-share') void uploadFrom(current.sessionId, current.messageId)
    },

    importPreview(): void {
      if (state.kind !== 'preview') return
      // Captured before `publish`: it replaces `state`, so reading the fields
      // afterwards would read the state the import just moved to.
      const { session, presetCwd } = state
      if (presetCwd !== undefined) {
        // The caller named the directory before the fetch, so the question has
        // already been answered. Navigating the same path `importInto` takes
        // keeps one way in to the write.
        publish(advance(state, { type: 'import' }))
        void importFrom(session, presetCwd)
        return
      }
      // Always asked, even with one workspace listed: the reader is choosing
      // where a copy of someone else's conversation lands, which is a
      // decision rather than a default.
      publish(advance(state, { type: 'choose', workspaces: driver.workspaces() }))
    },

    importInto(cwd: string): void {
      const current = state
      publish(advance(state, { type: 'import' }))
      if (current.kind === 'preview' || current.kind === 'choose-workspace') {
        void importFrom(current.session, cwd)
      }
    },

    async browseForWorkspace(): Promise<void> {
      if (state.kind !== 'choose-workspace') return
      const session = state.session
      const cwd = await driver.pickWorkspace()
      if (cwd === undefined) return
      publish(advance(state, { type: 'import' }))
      await importFrom(session, cwd)
    },

    async copyLink(): Promise<boolean> {
      if (state.kind !== 'shared') return false
      // The card does not change either way. A refused write gets no banner:
      // the link is still on screen to be selected by hand, and a banner
      // saying "copied" over a refused write would be the one lie that costs
      // the reader their cue.
      return driver.copy(state.url)
    },

    close(): void {
      // Closing cancels. The abort reaches the Host as `request.signal`, which
      // the route forwards to the service call (stopping the transfer) and to
      // the storage write (leaving no half-written session).
      //
      // The generation bump covers what an abort cannot: a request already past
      // its last check still answers, and that answer must not reopen this card
      // or navigate a reader who has moved on.
      inflight?.abort()
      inflight = undefined
      generation += 1
      publish(CLOSED)
    },
  }
}