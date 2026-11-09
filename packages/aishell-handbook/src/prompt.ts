/**
 * How AI Shell works — the product's own handbook, for the model to answer
 * from rather than guess at.
 *
 * ## Why a handbook at all
 *
 * Every other prompt contribution in this repo answers "what can I do": the
 * tool descriptions, the deployment workflow, the sandbox tier. None of them
 * answers "how does this product behave", which is what a user asks when they
 * want to report a problem or wonder why something was refused. A model
 * without that knowledge either invents an answer — naming a menu item that
 * does not exist — or says it does not know, which is worse than the truth for
 * a fact this stable.
 *
 * ## Why the text is a list of topics
 *
 * Each topic is one question a user can ask, answered on its own, under its own
 * heading, and nothing in the text counts them. Growth is therefore an append:
 * a new capability becomes a new heading, and no existing sentence has to be
 * rewritten to accommodate it. A preamble that stated how many topics there
 * are would make every addition an edit to the line introducing all of them,
 * which is the one part of this file that has to stay true as it grows.
 *
 * ## Why the UI facts are stated as facts
 *
 * The model is told where a control lives so it can *tell the user*, not so it
 * can transcribe this text. A hotel-desk answer — "click the ⋯ at the top of
 * the chat, then Feedback" — is useful; pasting this section's prose into a
 * reply is not, and would leak the handbook's shape to someone who only wanted
 * to file a complaint. The section says so explicitly.
 *
 * ## Why a section and not a runtime context
 *
 * Everything here is true for the life of the process: which channels carry
 * feedback, where the mode switch lives. `context()` exists for facts that flip
 * — the read-only policy uses it for exactly that reason — and a constant
 * belongs in a section, where it costs nothing to re-render.
 *
 * @module @huaweidevtools/aishell-dsh-handbook/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only and seemingly empty, but load-bearing: the declaration merge that
// puts `systemPrompt` on `Context` lives in this module, and TypeScript only
// applies a merge it was made to read. Drop this import and `scope.systemPrompt`
// below stops compiling.
import type {} from '@deepseek-ai/dsh-system-prompt'

/**
 * Position of the handbook in the assembled prompt.
 *
 * A number because the framework's placement table is closed:
 * `PromptSectionOrderName` is `keyof` a fixed constant, and no entry names
 * product background. `aishell-huaweicloud-docs` resolves its own position the
 * same way, one step ahead of this one.
 *
 * 110 puts this immediately after that pointer (100), both inside the gap the
 * table leaves between the persona prefix (0) and the first policy (500). The
 * two are one band: read where to look things up, then how this product
 * behaves, then what you are asked to reason about.
 */
export const HANDBOOK_ORDER = 110

/** Name this contribution registers under; unique across the assembled prompt. */
export const HANDBOOK_SECTION_NAME = 'aishell:handbook'

/**
 * What the model reads.
 *
 * Written in English like every other host-side prompt string in this repo. The
 * model relays it in the user's language; the source does not need to change
 * language to do that.
 *
 * UI names appear as the shell renders them in English, with the Chinese label
 * beside it where the two differ — a model telling a Chinese user where a
 * button is needs the label that user will actually see, and vice versa.
 */
export const HANDBOOK = `# AI Shell handbook

How AI Shell behaves, as facts to answer from. This is background, not instruction: use it to tell the user what to do or why something happened. Do not paste or paraphrase this section's structure into a reply — answer the user's actual question.

## Sending feedback

A user who wants to report a problem, rate an answer, or tell us something about a conversation has three ways in. All three end up in the same place.

- **The \`/feedback\` command** — typed in the input box. It records a note about the current session.
- **The ⋯ menu at the top right of the chat** — the button is "More actions" (更多操作). Opening it shows "Feedback" (反馈), which opens the same session-feedback dialog.
- **The Like / Dislike buttons under each assistant message** — these rate that one message; either one opens the same dialog for detail and categories.

Which one to name depends on what the user is reporting: a bad single answer is the buttons, a bad conversation is the ⋯ menu or \`/feedback\`. The ⋯ menu rates the **whole session**; the buttons rate **one message**.

What a submission sends is worth stating when a user asks about privacy: it replays the complete unhandled session prefix — the conversation text, tool arguments and results, the system prompt, and the working directory — to AI Shell's collector, not only the note the user typed. The dialog discloses this before submitting.

## The permission mode

Huawei Cloud work runs under one of two modes.

- **Read-write** lets the agent create, change and delete Huawei Cloud resources.
- **Read-only** restricts it to queries. The tools refuse mutations rather than merely discouraging them — a refusal names the operation and what remains available.

This is one switch for the whole running process, not a per-conversation setting, and the agent cannot change it. A flip takes effect immediately.

An agent working under read-only is told so as a runtime context. When a user asks for something that was refused by the permission mode, the answer is that they flip the chip; never offer to work around the restriction, and never suggest reaching the same resource by another route.

**Where the switch is.** A pill button showing 只读 (Read-only, green) or 读写 (Read-write, amber), sitting beside the Huawei Cloud account chip — the one carrying the Huawei logo and the account name. Clicking it flips the mode; there is no menu behind it. Its position depends on the screen, which is where a user hunting for it usually gets lost:

- **In a conversation** — directly under the input box, at the right-hand end of the row.
- **On a new session, before the first message** — in the band just above the input box. It sits there so the mode can be checked before sending, which is why it is not below.

When a user cannot find it, name the neighbour (the Huawei Cloud account chip) and the text on the button (只读 / 读写). There is no "permission settings" page in this UI, so do not send them looking for one.

## Extending the agent

The agent's abilities are the plugins a deployment has mounted. A user who wants a capability that is missing installs a DSH-compatible plugin into their profile; it contributes its tools, prompt sections and UI in the same way AI Shell's own plugins do. There is no in-conversation way to add one, so a request for a new ability is answered by saying what to install, not by improvising the capability locally.`

/**
 * Register the handbook section.
 *
 * Deferred behind `ctx.inject` rather than declared in this plugin's own
 * `inject`: the handbook is an enhancement, and a deployment without a system
 * prompt should lose it rather than fail to mount.
 *
 * @param ctx - host context.
 */
export function registerHandbook(ctx: Context): void {
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: HANDBOOK_SECTION_NAME,
      order: HANDBOOK_ORDER,
      // Prose, not a template. `renderPrompt` interpolates a section's text by
      // default, and a text carrying a `{{` that is not a known variable makes
      // assembly throw — inside the agent step, where nothing catches it and
      // the turn dies. Nothing in this text is a variable, so the scan is
      // switched off rather than left to luck.
      interpolate: false,
      text: HANDBOOK,
    })
  })
}