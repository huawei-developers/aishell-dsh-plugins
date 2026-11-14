/**
 * The share dialog.
 *
 * One entry in `shell.overlay`: it renders a centered card for whichever state
 * the machine is in, and nothing while it is closed. `Modal` portals it to the
 * body, so it sits above every panel regardless of which seat rendered the
 * entry.
 *
 * ## One content box, one height
 *
 * Every state paints the same region above the button row: a sentence, the
 * dial, the link, or the conversation. The region has a fixed minimum and
 * scrolls inside itself, so the card does not change height as a flow advances
 * and the buttons never move out from under the pointer.
 *
 * The region's rules live in `./styles.ts`, because a scroll container and a
 * hover state have no inline form.
 *
 * ## What the card does not do
 *
 * It does not report a copy on itself. Copying raises the shell's `Toast` and
 * leaves the card exactly as it was — the link stays where the reader was
 * looking, and the buttons do not change under them.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/SharePreview
 */

import {
  Button,
  IconCopyOutlineRegular,
  IconFolderCloseRegular,
  IconLinkOutlineRegular,
  Modal,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useState, type ReactElement, type ReactNode } from 'react'
import type { PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the workspace plugin's GlobalStandardProps merge
// (`useWorkspaces`).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

import { DIAL_CLASS, DIAL_DOT_CLASS, DIAL_DOT_COUNT, DIAL_LABEL_CLASS, DIAL_RING_CLASS } from './dial.ts'
import type { AishellShareLocaleKey } from './locales.ts'
import type { ShareMachine } from './machine.ts'
import type { SharePackage } from '../package.ts'
import type { ServiceFailure } from '../service.ts'
import { previewLines, type PreviewLine } from './preview.ts'
import { isOpen, type ShareState, type WorkspaceChoice } from './state.ts'
import {
  BUBBLE_MINE_CLASS,
  BUBBLE_REPLY_CLASS,
  CONTENT_CLASS,
  LINK_CLASS,
  LINK_COPY_CLASS,
  LINK_TEXT_CLASS,
  TOOL_CHIP_CLASS,
  TRANSCRIPT_CLASS,
  WORKSPACE_HINT_CLASS,
  WORKSPACE_ICON_CLASS,
  WORKSPACE_LIST_CLASS,
  WORKSPACE_PATH_CLASS,
  WORKSPACE_ROW_CLASS,
  WORKSPACE_TEXT_CLASS,
  WORKSPACE_TITLE_CLASS,
} from './styles.ts'

/** What this entry receives from its registrar. */
export interface SharePreviewInjected {
  readonly hooks: {
    /** The dialog's state; the renderer binds this into a `useShare` selector. */
    readonly share: ShareMachine
  }
  readonly actions: ShareMachine
}

/** Props of the overlay entry. */
export type SharePreviewProps = PropsRuntime<'shell.overlay'> & PropsLocale<'aishell-share'> & PropsHooks<SharePreviewInjected['hooks']> & Omit<SharePreviewInjected, 'hooks'>

export function SharePreview({ useShare, actions, t }: SharePreviewProps): ReactElement | null {
  const state = useShare((value: ShareState) => value)
  // The card is the only thing this entry renders; everything transient about
  // one showing of it lives in `OpenCard`, which mounts with the card and goes
  // with it. That is what keeps the copy banner from outliving the link it was
  // raised for.
  if (!isOpen(state)) return null
  return <OpenCard state={state} actions={actions} t={t} />
}

/**
 * The card, while it is open.
 *
 * ## Why the transient state is here
 *
 * This component exists once per showing of the card, so state declared in it
 * dies with the card. That is the property the copy banner needs: a `Toast`
 * whose owner unmounts before it finishes does not call its `onDone` — it only
 * clears its timer — so a flag held above this component would stay raised
 * after the card closed, and the next card would open already showing "copied"
 * for a link nobody had pressed.
 *
 * Cleaning up after the toast instead of relying on its callback would work
 * too, and would be a rule to remember. Letting the state's lifetime be the
 * card's lifetime makes it structural.
 *
 * @param props - the open state, the machine, and the translator.
 */
function OpenCard({ state, actions, t }: {
  readonly state: ShareState
  readonly actions: ShareMachine
  readonly t: SharePreviewProps['t']
}): ReactElement {
  // A sequence, not a boolean: `Toast` restarts its cycle when the owner mounts
  // a new one, so two presses in a row must be two mounts.
  const [bannerSeq, setBannerSeq] = useState(0)
  const [bannerShown, setBannerShown] = useState(false)

  const raiseBanner = (): void => {
    setBannerSeq((seq) => seq + 1)
    setBannerShown(true)
  }

  const copy = copyHandler(actions, raiseBanner)

  return (
    <>
      <Modal
        open
        onClose={actions.close}
        title={t('dialog.title')}
        closeLabel={t('dialog.close')}
        footer={footerFor(state, actions, t, copy)}
      >
        <div className={CONTENT_CLASS}>
          {bodyFor(state, actions, t, copy)}
        </div>
      </Modal>
      {bannerShown && (
        <Toast
          key={bannerSeq}
          text={t('share.copied')}
          tone="success"
          onDone={() => { setBannerShown(false) }}
        />
      )}
    </>
  )
}

/**
 * The dial: a ring of dots with a label held still in the middle.
 *
 * @param label - what is running, e.g. `t('share.generating')`.
 * @returns the ring and its label.
 */
function Dial({ label }: { readonly label: string }): ReactElement {
  return (
    <div className={DIAL_CLASS} role="status" aria-label={label}>
      <div className={DIAL_RING_CLASS} aria-hidden>
        {Array.from({ length: DIAL_DOT_COUNT }, (_, index) => (
          <span
            key={index}
            className={DIAL_DOT_CLASS}
            // Read by the stylesheet to place and grade this dot; the ring
            // holds no styling decision of its own.
            style={{ '--i': index } as React.CSSProperties}
          />
        ))}
      </div>
      <span className={DIAL_LABEL_CLASS}>{label}</span>
    </div>
  )
}

/**
 * The copy command, as one function both controls share.
 *
 * @param actions - the machine.
 * @param onCopied - raises the banner.
 * @returns the click handler.
 */
function copyHandler(actions: ShareMachine, onCopied: () => void): () => void {
  return () => {
    // The banner is raised only on an accepted write: a refused clipboard
    // leaves the link on screen to be selected by hand, and saying "copied"
    // over it would take away the reader's only cue.
    void actions.copyLink().then((accepted) => { if (accepted) onCopied() })
  }
}

/** The dialog's buttons, per state. */
function footerFor(
  state: ShareState,
  actions: ShareMachine,
  t: SharePreviewProps['t'],
  copy: () => void,
): ReactNode {
  switch (state.kind) {
    case 'confirm-share':
      return (
        <>
          <Button onClick={actions.close}>{t('dialog.cancel')}</Button>
          <Button variant="primary" onClick={actions.confirmShare}>{t('dialog.shareConfirm')}</Button>
        </>
      )
    case 'sharing':
      // Both seats stay in the row so the card does not resize when the upload
      // starts; the primary one is disabled rather than removed.
      return (
        <>
          <Button onClick={actions.close}>{t('dialog.cancel')}</Button>
          <Button variant="primary" disabled>{t('dialog.shareConfirm')}</Button>
        </>
      )
    case 'shared':
      return (
        <>
          <Button onClick={actions.close}>{t('dialog.close')}</Button>
          <Button variant="primary" icon={<IconCopyOutlineRegular size={16} />} onClick={copy}>
            {t('dialog.copy')}
          </Button>
        </>
      )
    case 'preview':
      return (
        <>
          <Button onClick={actions.close}>{t('dialog.cancel')}</Button>
          <Button variant="primary" onClick={actions.importPreview}>{t('dialog.import')}</Button>
        </>
      )
    case 'choose-workspace':
      return (
        <>
          <Button onClick={actions.close}>{t('dialog.cancel')}</Button>
          <Button onClick={() => { void actions.browseForWorkspace() }}>{t('import.browse')}</Button>
        </>
      )
    case 'failed':
      return <Button onClick={actions.close}>{t('dialog.close')}</Button>
    default:
      // Every state offers a way out, including the ones where waiting is the
      // only thing to do. `Modal`'s header X already closes the card, but it is
      // the secondary affordance; a reader whose button row went empty under
      // them would reasonably wonder whether this dialog can still be left.
      //
      // **Closing is not cancelling.** The upload or download keeps running to
      // completion on the Host; only the dialog goes away. That is why the
      // label is the plain "取消": there is nothing to abort, and a button
      // promising to stop the work would be lying. What the request made is
      // still there when the next link arrives — see `machine.ts` for why no
      // state change is allowed to depend on the dialog being open.
      return <Button onClick={actions.close}>{t('dialog.cancel')}</Button>
  }
}

/** The dialog's content, per state. */
function bodyFor(
  state: ShareState,
  actions: ShareMachine,
  t: SharePreviewProps['t'],
  copy: () => void,
): ReactNode {
  switch (state.kind) {
    case 'confirm-share':
      return <p style={paragraph}>{t('share.disclosure')}</p>
    case 'sharing':
      return <Dial label={t('share.generating')} />
    case 'shared':
      return <LinkBox url={state.url} onCopy={copy} label={t('share.linkLabel')} copyLabel={t('dialog.copy')} />
    case 'fetching':
      return <Dial label={t('import.loading')} />
    case 'preview':
      return <Conversation session={state.session} emptyLabel={t('import.empty')} />
    case 'choose-workspace':
      return (
        <Workspaces
          workspaces={state.workspaces}
          hint={t('import.chooseWorkspace')}
          onPick={(cwd) => { actions.importInto(cwd) }}
        />
      )
    case 'importing':
      return <Dial label={t('import.importing')} />
    case 'failed':
      return <p style={paragraph}>{t(failureKey(state))}</p>
  }
}

/**
 * The copy key for a failure, chosen by the flow that hit it.
 *
 * A reason does not always mean the same thing to both flows: a `rejected`
 * share means the service refused the package, while a `rejected` import means
 * the link's contents could not be read. A single key would have to address a
 * link the sharing reader does not yet hold.
 *
 * The stage-specific keys are listed rather than probed by prefix, because `t`
 * is a plain lookup and asking it whether a key exists would only tell us how
 * the shell renders a miss. A reason that reads the same either way — an
 * unavailable link, an unavailable service — keeps one unprefixed key, so a new
 * reason needs two keys only when the two flows really do say different things.
 *
 * @param state - the failed state, with the stage it failed in.
 * @returns the dictionary key.
 */
function failureKey(state: { readonly stage: 'share' | 'import', readonly reason: ServiceFailure }): AishellShareLocaleKey {
  switch (`${state.stage}.${state.reason}`) {
    case 'share.rejected': return 'failure.share.rejected'
    case 'share.too-large': return 'failure.share.too-large'
    case 'share.bad-request': return 'failure.share.bad-request'
    case 'import.rejected': return 'failure.import.rejected'
    case 'import.too-large': return 'failure.import.too-large'
    case 'import.bad-request': return 'failure.import.bad-request'
    // An unavailable link is unavailable to either flow, and a service that is
    // down is down for both.
    case 'share.unavailable':
    case 'import.unavailable': return 'failure.unavailable'
    default: return 'failure.unavailable-service'
  }
}

/**
 * The generated link, with its copy control on the box's top-right corner.
 *
 * The icon is there because copying is the one thing a reader does with a link,
 * and putting it on the link makes that obvious before the button row is read.
 * The footer keeps its own copy button as well — the two are the same command,
 * so a reader who looks at the buttons instead is not left hunting.
 *
 * @param url - the link, verbatim.
 * @param onCopy - the shared copy handler.
 * @param label - what the box holds, set above the link.
 * @param copyLabel - accessible name for the icon.
 * @returns the box.
 */
function LinkBox(
  {
    url,
    onCopy,
    label,
    copyLabel,
  }: {
    readonly url: string
    readonly onCopy: () => void
    readonly label: string
    readonly copyLabel: string
  },
): ReactElement {
  return (
    <div className={LINK_CLASS}>
      <div style={linkLead}>
        <IconLinkOutlineRegular size={14} />
        <span style={linkLeadText}>{label}</span>
      </div>
      <code className={LINK_TEXT_CLASS}>{url}</code>
      <button
        type="button"
        className={LINK_COPY_CLASS}
        onClick={onCopy}
        aria-label={copyLabel}
        title={copyLabel}
      >
        <IconCopyOutlineRegular size={14} />
      </button>
    </div>
  )
}

/**
 * The conversation, as a reader sees it.
 *
 * The reader's own turns sit right and filled; the assistant's sit left as plain
 * text. Tool calls are one folded line each, on the left with the assistant:
 * they are what the assistant did.
 *
 * @param session - the package being previewed.
 * @param emptyLabel - copy for a package with no readable messages.
 * @returns the conversation.
 */
function Conversation(
  { session, emptyLabel }: { readonly session: SharePackage, readonly emptyLabel: string },
): ReactElement {
  const lines = previewLines(session)
  return (
    <div style={conversationColumn}>
      <p style={conversationTitle}>{session.title}</p>
      <div className={TRANSCRIPT_CLASS}>
        {lines.length === 0
          ? <p style={paragraph}>{emptyLabel}</p>
          : lines.map((line) => <Bubble key={line.at} line={line} />)}
      </div>
    </div>
  )
}

/**
 * One line of the preview, drawn for the side it came from.
 *
 * @param line - the line to draw.
 * @returns the bubble or the tool chip.
 */
function Bubble({ line }: { readonly line: PreviewLine }): ReactElement {
  if (line.role === 'tool') return <span className={TOOL_CHIP_CLASS}>{line.text}</span>
  return (
    <div className={line.role === 'user' ? BUBBLE_MINE_CLASS : BUBBLE_REPLY_CLASS}>
      {line.text}
    </div>
  )
}

/**
 * The workspaces an import can land in.
 *
 * Each row is the workspace it names: title, then the directory, because two
 * workspaces may carry the same title and the path is what tells them apart.
 * The folder glyph matches the one the shell uses for the same object, so the
 * row is recognised before it is read.
 *
 * @param workspaces - the directories the shell currently lists.
 * @param hint - the sentence above the list.
 * @param onPick - adopts one directory.
 * @returns the list.
 */
function Workspaces(
  {
    workspaces,
    hint,
    onPick,
  }: {
    readonly workspaces: readonly WorkspaceChoice[]
    readonly hint: string
    readonly onPick: (cwd: string) => void
  },
): ReactElement {
  return (
    <div style={workspaceColumn}>
      <p className={WORKSPACE_HINT_CLASS}>{hint}</p>
      <div className={WORKSPACE_LIST_CLASS}>
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            className={WORKSPACE_ROW_CLASS}
            onClick={() => { onPick(workspace.path) }}
          >
            <span className={WORKSPACE_ICON_CLASS} aria-hidden>
              <IconFolderCloseRegular size={16} />
            </span>
            <span className={WORKSPACE_TEXT_CLASS}>
              <span className={WORKSPACE_TITLE_CLASS}>{workspace.title}</span>
              <span className={WORKSPACE_PATH_CLASS}>{workspace.path}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** One paragraph of supporting copy. */
const paragraph: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-secondary)',
}

/** The label above the link, naming what the box holds. */
const linkLead: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginBottom: 8,
  color: 'var(--dsw-alias-label-tertiary)',
}

/** The words beside the link glyph. */
const linkLeadText: React.CSSProperties = {
  fontSize: 12,
  lineHeight: '16px',
  fontWeight: 500,
}

/** The preview's column: a title over the transcript. */
const conversationColumn: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  width: '100%',
  // The transcript scrolls; the box must be free to grow into it rather than
  // centring the whole column and clipping both ends.
  flex: 1,
  minHeight: 0,
  justifyContent: 'flex-start',
}

/** The conversation's name. */
const conversationTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: '22px',
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** The workspace column, left-aligned rather than centred. */
const workspaceColumn: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  justifyContent: 'flex-start',
}