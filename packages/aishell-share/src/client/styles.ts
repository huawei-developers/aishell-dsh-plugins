/**
 * The dialog's stylesheet: everything a state needs that inline styles cannot
 * express.
 *
 * ## Why a stylesheet and not inline styles
 *
 * Three things have no inline form: `:hover` and `:focus-visible` on the
 * controls the dialog draws itself, a scroll container that must not scroll its
 * own scrollbar into the layout, and `@media (prefers-reduced-motion)`. The
 * rest of the card stays inline, next to the markup it belongs to; only these
 * live here.
 *
 * ## Why a tag rather than a CSS module
 *
 * A client bundle is a closure factory the loader hands a module table to, so
 * this package cannot import another plugin's stylesheet — and its own CSS is
 * not part of the bundle `tsdown` emits for the Page. A tag stamped with the
 * plugin id is what the loader's `removeOwnedStyles` sweeps on reload, which is
 * the same mechanism `./dial.ts` uses for the ring.
 *
 * ## Colours
 *
 * Every rule reads a `--dsw-*` alias token, so light and dark come from the
 * theme rather than from a literal here. The two fills that carry meaning are
 * both translucent: a bubble and a hover state sit *on* a surface, and an
 * opaque fill would look cut out of it in one theme or the other.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/styles
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Plugin id stamped on the tag, so the loader can sweep it on teardown. */
const PLUGIN_ID = '@huaweidevtools/aishell-dsh-share'

/** Dedupe key, as `shared/tsdown.client.ts` spells it for generated modules. */
const STYLE_KEY = 'dialog.css'

/**
 * The fixed-height region every state paints.
 *
 * One box for all of them: a sentence, a dial, a link, the conversation — the
 * card keeps one height, so it does not jump as the flow advances and the
 * buttons never move out from under the pointer.
 *
 * The height is fixed rather than a minimum: a state with more to show (a long
 * conversation, a long workspace list) scrolls inside this box instead of
 * growing the card. Every other state centres in the same space, which is what
 * makes the dial land in the same place each time.
 */
export const CONTENT_CLASS = 'aishell-share-content'

/** The link and its copy control. */
export const LINK_CLASS = 'aishell-share-link'

/** The link text itself. */
export const LINK_TEXT_CLASS = 'aishell-share-link-text'

/** The copy icon on the link box's corner. */
export const LINK_COPY_CLASS = 'aishell-share-link-copy'

/** The scrolling transcript. */
export const TRANSCRIPT_CLASS = 'aishell-share-transcript'

/** One bubble the reader sent. */
export const BUBBLE_MINE_CLASS = 'aishell-share-bubble-mine'

/** One message the conversation returned. */
export const BUBBLE_REPLY_CLASS = 'aishell-share-bubble-reply'

/** One Turn's work, folded. */
export const TURN_CLASS = 'aishell-share-turn'

/**
 * The fold's header: a chevron and a one-line label.
 *
 * No border and no background. This sits inside the transcript, and a card
 * around it would compete with the conversation it is part of; the shell's own
 * process rows are drawn the same way.
 */
export const TURN_HEADER_CLASS = 'aishell-share-turn-header'

/** The chevron that turns when the fold opens. */
export const TURN_CHEVRON_CLASS = 'aishell-share-turn-chevron'

/** The Turn's answer, below the fold. */
export const TURN_ANSWER_CLASS = 'aishell-share-turn-answer'

/**
 * The expanded steps.
 *
 * A bordered region, unlike the header: what it holds is commands and their
 * output, which is a different kind of text from the prose above and needs its
 * own ground to be readable as one block.
 */
export const TURN_BODY_CLASS = 'aishell-share-turn-body'

/** A model message inside a Turn. */
export const STEP_MESSAGE_CLASS = 'aishell-share-step-message'

/** One step's invocation and outcome. */
export const STEP_TOOL_CLASS = 'aishell-share-step-tool'

/** The call: the tool's name and the arguments it was given. */
export const STEP_CALL_CLASS = 'aishell-share-step-call'

/**
 * What the tool returned.
 *
 * Rendered as a `pre` so the line breaks the tool wrote survive; a tool's
 * output is formatted text, and reflowing it would destroy the thing a reader
 * is trying to read.
 */
export const STEP_RESULT_CLASS = 'aishell-share-step-result'

/** The variant on a result the tool reported as an error. */
export const STEP_RESULT_ERROR_CLASS = 'aishell-share-step-result-error'

/** The placeholder for a call whose result the package does not carry. */
export const STEP_NO_RESULT_CLASS = 'aishell-share-step-no-result'

/** The workspace list the import asks into. */
export const WORKSPACE_LIST_CLASS = 'aishell-share-workspaces'

/** One workspace the copy can land in. */
export const WORKSPACE_ROW_CLASS = 'aishell-share-workspace'

/** The folder glyph in a workspace row. */
export const WORKSPACE_ICON_CLASS = 'aishell-share-workspace-icon'

/** The title and path stacked in a workspace row. */
export const WORKSPACE_TEXT_CLASS = 'aishell-share-workspace-text'

/** A workspace's title. */
export const WORKSPACE_TITLE_CLASS = 'aishell-share-workspace-title'

/** A workspace's directory. */
export const WORKSPACE_PATH_CLASS = 'aishell-share-workspace-path'

/** The sentence that introduces the workspace list. */
export const WORKSPACE_HINT_CLASS = 'aishell-share-workspace-hint'

/** The share button in a Turn's action row. */
export const ACTION_CLASS = 'aishell-share-turn-action'

/** The glyph inside that button. */
export const ACTION_ICON_CLASS = 'aishell-share-turn-action-icon'

const CSS = `
.${CONTENT_CLASS} {
  display: flex;
  flex-direction: column;
  /* Centred by default: a sentence, a dial and a failure are all single
     elements that read best in the middle of the box. States that fill the box
     (the conversation, the workspace list) opt out with \`justify-content:
     flex-start\` of their own. */
  justify-content: center;
  /* One height for every state. A state with more to show scrolls inside this
     box, so advancing the flow never resizes the card and never moves the
     buttons. */
  height: 200px;
  overflow: hidden;
}

/* ── The generated link ─────────────────────────────────────────────────── */

.${LINK_CLASS} {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  padding: 14px 40px 14px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-settings-card-fill);
}

.${LINK_TEXT_CLASS} {
  display: block;
  font: 12px/1.6 "SF Mono", "JetBrains Mono", Consolas, monospace;
  color: var(--dsw-alias-label-primary);
  /* A URL has no spaces; without this it widens the card instead of wrapping
     inside its own box. */
  overflow-wrap: anywhere;
  /* Selectable, and it reads as text rather than as something to click: the
     dialog is showing a link to copy, not offering to open it here. */
  user-select: text;
  cursor: text;
}

.${LINK_COPY_CLASS} {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

.${LINK_COPY_CLASS}:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

.${LINK_COPY_CLASS}:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}

/* ── The preview ────────────────────────────────────────────────────────── */

.${TRANSCRIPT_CLASS} {
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* Fills the box and scrolls inside it, so a long conversation cannot grow the
     card past the viewport. */
  flex: 1;
  min-height: 0;
  max-height: 300px;
  overflow-y: auto;
  /* Room for the scrollbar, so a message never ends up underneath it. */
  padding-right: 6px;
}

.${BUBBLE_MINE_CLASS},
.${BUBBLE_REPLY_CLASS} {
  max-width: 84%;
  border-radius: var(--dsw-radius-lg);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* The reader's own words: right, filled. The fill is translucent so it reads as
   a tint over the card rather than as a second card inside it. */
.${BUBBLE_MINE_CLASS} {
  align-self: flex-end;
  padding: 8px 12px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  /* The corner nearest the speaker is squared off, which is what makes the
     side someone is on legible before a word is read. */
  border-bottom-right-radius: var(--dsw-radius-xs);
}

/* The reply: left, no bubble. A transcript is mostly the assistant, and a
   column of filled shapes would read as a wall; plain text lets the reader's
   own turns carry the visual weight. */
.${BUBBLE_REPLY_CLASS} {
  align-self: flex-start;
  color: var(--dsw-alias-label-primary);
  border-bottom-left-radius: var(--dsw-radius-xs);
}

/* ── A Turn's work ──────────────────────────────────────────────────────── */

.${TURN_CLASS} {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.${TURN_HEADER_CLASS} {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 13px;
  line-height: 24px;
  /* Secondary, not tertiary: 13px at 3.71:1 misses AA, and this is the only
     line telling a reader there is work to open. Hover lifts it to primary. */
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  text-align: left;
}

/* The row states come from the token layer, so the fold reads as a control
   without needing a box to look like one. */
@media (hover: hover) {
  .${TURN_HEADER_CLASS}:hover {
    color: var(--dsw-alias-label-primary);
  }
}

.${TURN_HEADER_CLASS}:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
  border-radius: var(--dsw-radius-xs);
}

.${TURN_CHEVRON_CLASS} {
  display: inline-flex;
  align-items: center;
  flex: none;
}

/* The answer, drawn where a reply belongs. It reuses the reply's type but not
   its align-self: inside the Turn's column that property is the horizontal
   axis, so flex-start would leave the answer centred under the fold instead of
   flush with every other reply. */
.${TURN_ANSWER_CLASS} {
  align-self: stretch;
  max-width: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}

.${TURN_BODY_CLASS} {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-settings-card-fill);
  /* Its own scroll when a tool returned screens of output: the transcript
     keeps scrolling as a whole, and one step cannot push the rest off it. */
  max-height: 220px;
  overflow-y: auto;
}

.${STEP_MESSAGE_CLASS} {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
}

.${STEP_TOOL_CLASS} {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.${STEP_CALL_CLASS} {
  font: 12px/1.6 "SF Mono", "JetBrains Mono", Consolas, monospace;
  /* Secondary rather than tertiary: this is the line a reader scans to know
     what the Turn did, so it has to clear AA at 12px on the card's ground. */
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.${STEP_RESULT_CLASS} {
  margin: 0;
  font: 12px/1.6 "SF Mono", "JetBrains Mono", Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
}

.${STEP_RESULT_ERROR_CLASS} {
  color: var(--dsw-alias-state-error-primary);
}

.${STEP_NO_RESULT_CLASS} {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-style: italic;
}

/* ── Choosing a workspace ───────────────────────────────────────────────── */

.${WORKSPACE_HINT_CLASS} {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

.${WORKSPACE_LIST_CLASS} {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.${WORKSPACE_ROW_CLASS} {
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.${WORKSPACE_ROW_CLASS}:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.${WORKSPACE_ROW_CLASS}:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}

.${WORKSPACE_ICON_CLASS} {
  display: inline-flex;
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}

.${WORKSPACE_TEXT_CLASS} {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.${WORKSPACE_TITLE_CLASS} {
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  /* One long directory name must not push the row wider than the card. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.${WORKSPACE_PATH_CLASS} {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── The Turn action row ────────────────────────────────────────────────── */

/* A 16px glyph in the row beside copy and branch. Measured against the shipped
   Like/Dislike buttons, which are the same 24px box with the same hover fill, so
   this row is the same height and the same rhythm as the ones next to it. */
.${ACTION_CLASS} {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

.${ACTION_CLASS}:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}

.${ACTION_CLASS}:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-alias-state-business-primary);
  outline-offset: -2px;
}

.${ACTION_ICON_CLASS} {
  display: inline-flex;
  pointer-events: none;
}

.${ACTION_ICON_CLASS} svg {
  width: 16px;
  height: 16px;
}

/* Decorative motion only — every moving part has a label that says what is
   happening, so the media query stops the motion rather than the information. */
@media (prefers-reduced-motion: reduce) {
  .${LINK_COPY_CLASS}, .${WORKSPACE_ROW_CLASS}, .${ACTION_CLASS} {
    transition: none;
  }
}
`

/**
 * Install the stylesheet, once per plugin fiber.
 *
 * @param ctx - client context, for the effect that owns the tag.
 */
export function installDialogStyles(ctx: ClientContext): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = STYLE_KEY
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'aishell-share: dialog styles')
}