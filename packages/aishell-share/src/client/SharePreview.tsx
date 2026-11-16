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
import { isOpen, flowOf, type ShareState, type WorkspaceChoice } from './state.ts'
import {
  BUBBLE_MINE_CLASS,
  BUBBLE_REPLY_CLASS,
  CONTENT_CLASS,
  LINK_CLASS,
  LINK_COPY_CLASS,
  LINK_TEXT_CLASS,
  TOOL_CHIP_CLASS,
  TOOL_CHIP_ERROR_CLASS,
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

  // What the reader has typed into the link field. It lives here rather than in
  // `LinkEntry` because the submit button is in the footer: the two are siblings
  // under the card, and the field cannot tell the button whether it is ready.
  // The value is not a step of the import — the machine learns it only when the
  // form is submitted — so it stays out of the state machine.
  //
  // `submitLink` closes over this render's `state`, so it always carries the
  // `presetCwd` the field was opened with; the form is only reachable while that
  // state is showing.
  const [link, setLink] = useState('')
  const trimmed = link.trim()
  const presetCwd = state.kind === 'enter-link' ? state.presetCwd : undefined
  const submitLink = (): void => {
    // Nothing to fetch with an empty field. The button is disabled in that
    // state, so this is the guard Enter reaches rather than a press.
    if (trimmed.length === 0) return
    actions.openLink(trimmed, presetCwd)
  }

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
        // The card's heading names the flow the reader is in, not the one they
        // might have expected: sharing and importing are the same surface, and a
        // reader who asked to import should not be looking at a card titled
        // "Share session". `flowOf` is `undefined` only while closed, which this
        // component never renders.
        title={flowOf(state) === 'share' ? t('dialog.title') : t('dialog.titleImport')}
        closeLabel={t('dialog.close')}
        footer={footerFor(state, actions, t, { copy, ready: trimmed.length > 0 })}
      >
        <div className={CONTENT_CLASS}>
          {bodyFor(state, actions, t, { copy, link, setLink, submitLink })}
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

/** What the footer's buttons need beyond the state. */
interface FooterCommands {
  /** Copy the generated link, and raise the banner when the write lands. */
  readonly copy: () => void
  /**
   * Whether there is anything to fetch.
   *
   * The footer does not submit — its button is a `type="submit"` associated
   * with the field's form, so the form's handler runs. This only decides
   * whether that button is offered as ready.
   */
  readonly ready: boolean
}

/**
 * The dialog's buttons, per state.
 *
 * Every state puts its buttons here, and every one of them is where a reader of
 * this card already looks for one: the content box shows a thing, the row below
 * acts on it. `enter-link` follows that rather than putting its action beside
 * the field, so the row does not appear and disappear as the flow advances.
 *
 * @param state - what the card is showing.
 * @param actions - the machine.
 * @param t - the translator.
 * @param commands - the card's own commands, which the footer shares.
 * @returns the row.
 */
function footerFor(
  state: ShareState,
  actions: ShareMachine,
  t: SharePreviewProps['t'],
  commands: FooterCommands,
): ReactNode {
  const { copy, ready } = commands
  switch (state.kind) {
    case 'enter-link':
      return (
        <>
          <Button onClick={actions.close}>{t('dialog.cancel')}</Button>
          {/* Associated with the field's form by id rather than nested in it, so
              the button row stays where every other state puts it. `type="submit"`
              is what makes `disabled` mean anything for Enter: with the button
              outside the form, a `disabled` submit button suppresses the key
              there, which is what an empty field needs. A `type="button"` here
              submits regardless of its own disabled state — measured in Chrome,
              with the field empty and with it filled. */}
          <Button type="submit" form={LINK_FORM_ID} variant="primary" disabled={!ready}>
            {t('import.preview')}
          </Button>
        </>
      )
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

/**
 * The link field, for a reader who has a link to paste.
 *
 * The value is lifted to the card: the submit button lives in the footer, the
 * field lives in the content box, and the two have to agree about what is
 * typed. `form` is what connects them — the button names the form's id rather
 * than sitting inside it, which is the one arrangement where the button row
 * stays where every other state puts it and Enter still works.
 *
 * The button keeps `type="submit"` for that reason alone: it is what makes the
 * button's `disabled` stop Enter. A `type="button"` would submit the form
 * through the implicit path whatever state it was in, so an empty field would
 * reach `openLink` and fail on an empty URL instead of doing nothing. Measured
 * both ways, empty and filled.
 *
 * Only the field is in the content box. What the box holds is a link, and the
 * placeholder already says so; a label above it would be a sentence telling the
 * reader what they can see.
 *
 * @param props - the current value, its setter, the submit, and the translator.
 * @returns the field and its owning form.
 */
function LinkEntry({ link, onChange, onSubmit, t }: {
  readonly link: string
  readonly onChange: (value: string) => void
  readonly onSubmit: () => void
  readonly t: SharePreviewProps['t']
}): ReactElement {
  return (
    // No style: a form is a block, so it fills the content box's width on its
    // own, and the field is the only child. Measured — the field lands at the
    // same width and x-position with no form rule at all.
    <form
      id={LINK_FORM_ID}
      onSubmit={(event) => { event.preventDefault(); onSubmit() }}
    >
      <input
        type="text"
        value={link}
        onChange={(event) => { onChange(event.target.value) }}
        // The field has no visible label, so this is its accessible name; the
        // same words are what the reader would have seen above it.
        aria-label={t('import.linkLabel')}
        placeholder={t('import.linkPlaceholder')}
        autoComplete="off"
        spellCheck={false}
        // The dialog's initial focus lands here: this is the one control the
        // reader came to use, so the card opens ready to paste rather than with
        // focus on the close button.
        data-modal-autofocus
        style={linkInput}
      />
    </form>
  )
}

/** The form the footer's submit button is associated with. */
const LINK_FORM_ID = 'aishell-share-link-form'

/** The field itself. */
const linkInput: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  height: 34,
  padding: '0 10px',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: 8,
  font: 'inherit',
  fontSize: 13,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
}

/** What the content box needs beyond the state. */
interface BodyCommands {
  /** Copy the generated link, and raise the banner when the write lands. */
  readonly copy: () => void
  /** What the link field currently holds. */
  readonly link: string
  /** Record a keystroke in the link field. */
  readonly setLink: (value: string) => void
  /** Start the fetch for whatever the field holds. */
  readonly submitLink: () => void
}

/**
 * The dialog's content, per state.
 *
 * @param state - what the card is showing.
 * @param actions - the machine.
 * @param t - the translator.
 * @param commands - the card's own commands, which the box shares.
 * @returns the content.
 */
function bodyFor(
  state: ShareState,
  actions: ShareMachine,
  t: SharePreviewProps['t'],
  commands: BodyCommands,
): ReactNode {
  const { copy, link, setLink, submitLink } = commands
  switch (state.kind) {
    case 'enter-link':
      return <LinkEntry link={link} onChange={setLink} onSubmit={submitLink} t={t} />
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
 * text. A tool call and its result are one folded chip each, on the left with
 * the assistant: they are what the assistant did.
 *
 * @param session - the package being previewed.
 * @param emptyLabel - copy for a package with no readable messages.
 * @param t - the translator.
 * @returns the conversation.
 */
function Conversation(
  { session, emptyLabel }: {
    readonly session: SharePackage
    readonly emptyLabel: string
  },
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
 * A tool call and its result share one chip. They are the two halves of a
 * single invocation, and giving them different furniture would say the
 * conversation changed rather than the outcome did; the error colour is what
 * marks a result the tool reported as a failure.
 *
 * @param line - the line to draw.
 * @returns the bubble or the tool chip.
 */
function Bubble({ line }: { readonly line: PreviewLine }): ReactElement {
  if (line.role === 'tool-call' || line.role === 'tool-result') {
    return (
      <span className={line.isError === true ? `${TOOL_CHIP_CLASS} ${TOOL_CHIP_ERROR_CLASS}` : TOOL_CHIP_CLASS}>
        {line.text}
      </span>
    )
  }
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