/**
 * The share action in one Turn's action row.
 *
 * Registered into `conversation.chat.assistant-actions`, the same slot the
 * shipped Like/Dislike pair uses, so it lands beside copy and branch rather
 * than in a bar of its own.
 *
 * ## What this row is, and why it is not per message
 *
 * The slot names an assistant message, but it is rendered by `TurnTailNodeView`
 * — a Turn's tail, which the chat package documents as "independent of
 * Assistant placement". So this row appears once per completed Turn, and the
 * message id it receives is the Turn's closing message. The share therefore
 * stops at **that Turn's end**, which is also the only cut a log can survive
 * (§5.7): a turn's messages are interleaved with its steps, and a cut anywhere
 * else leaves a `step/start` with no end and a dangling `callId`.
 *
 * A reader who clicks the third message's row and a reader who clicks the
 * first's get the same package, because both rows are the same Turn's tail.
 * That is the shape of the interface, not a shortcut here.
 *
 * ## The icon
 *
 * `IconRightUpOutlineRegular`, the same glyph the sidebar row uses, so one
 * concept has one mark. `IconShareOutlineRegular` is a paper plane and reads as
 * "send" beside a conversation.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/ShareMessageAction
 */

import { IconRightUpOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: declares the `conversation.chat.assistant-actions` slot and its
// owner props. Without it the slot name is not in the ledger and the row cannot
// be typed — the runtime would still register it, which is the failure mode
// worth avoiding.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: `MessageId` is a branded string declared by the LLM package, and
// the slot contract takes it from there.
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'

import { ACTION_CLASS, ACTION_ICON_CLASS } from './styles.ts'

/** What this row receives from its registrar. */
export interface ShareMessageActionInjected {
  /**
   * Open the share dialog for the Turn this message closes.
   *
   * The message id travels so the Host cuts the package at the right Turn; the
   * dialog itself is the Session's, because a reader never has two open.
   *
   * @param messageId - the durable id of the Turn's closing message.
   */
  readonly shareTurn: (messageId: MessageId) => void
}

/** Props of the action row. */
export type ShareMessageActionProps = PropsRuntime<'conversation.chat.assistant-actions'> & PropsLocale<'aishell-share'> & ShareMessageActionInjected

export function ShareMessageAction({ messageId, shareTurn, t }: ShareMessageActionProps): React.ReactElement {
  const label = t('action.share')
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        className={ACTION_CLASS}
        aria-label={label}
        onClick={() => { shareTurn(messageId) }}
      >
        <span className={ACTION_ICON_CLASS} aria-hidden>
          <IconRightUpOutlineRegular />
        </span>
      </button>
    </Tooltip>
  )
}