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

/** One folded half of a tool invocation. */
export const TOOL_CHIP_CLASS = 'aishell-share-tool-chip'

/**
 * The variant on a tool result the tool itself reported as an error.
 *
 * The chip keeps its shape and gains only the error colour: an error is the
 * same kind of thing as a success — one tool's answer — and drawing it as a
 * different piece of furniture would say the conversation had changed rather
 * than the outcome.
 */
export const TOOL_CHIP_ERROR_CLASS = 'aishell-share-tool-chip-error'

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

.${TOOL_CHIP_CLASS} {
  align-self: flex-start;
  max-width: 84%;
  padding: 2px 8px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-settings-card-fill);
  border: 1px solid var(--dsw-alias-border-l2);
  font: 11px/1.6 "SF Mono", "JetBrains Mono", Consolas, monospace;
  color: var(--dsw-alias-label-tertiary);
  overflow-wrap: anywhere;
  /* A tool can return a paragraph, and an unbounded chip would take the whole
     box. Three lines is enough to recognise the answer; the rest is history. */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.${TOOL_CHIP_ERROR_CLASS} {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
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