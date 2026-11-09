/**
 * Request-image preparation for the aishell gateway adapter.
 *
 * The harness hands an adapter durable *references*, never bytes: an
 * {@link ImageBlock} carries an opaque `attachmentId` that is explicitly
 * "never a filesystem path or bearer URL". Turning one into the base64 payload
 * an OpenAI `image_url` part needs is therefore an asynchronous read against
 * the mounted attachment service — which is why this runs as a step ahead of
 * serialization rather than inside it.
 *
 * Mirrors the official adapters' shape (`dsh-llm-pi-ai`'s `collectImageRefs` /
 * `prepareRequestImages`, `dsh-llm-deepseek`'s `prepareImages`): collect the
 * retained references, ask the attachment service for one deterministic
 * request version each, and let the route's budget decide whether the request
 * fits.
 *
 * @module @huaweidevtools/aishell-dsh-llm/images
 */

import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  contentHasImage,
  offloadedImageText,
  projectOffloadedImages,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentAccessResolver, RequestMessage } from '@deepseek-ai/dsh-llm'

/** Key under which one durable image's request version is held. */
export type ImageKey = ImageAttachmentRef['attachmentId']

/** Request versions by durable attachment id, as {@link prepareRequestImages} returns them. */
export type RequestImages = ReadonlyMap<ImageKey, RequestImageAttachment>

/**
 * The route's per-image projection policy: the total-pixel cap one image is
 * scaled into, and the encoded-byte target the encoder aims for. Both are
 * config fields on this plugin's Config, sharing the pi-ai defaults.
 */
export interface ImageRequestBudget {
  /** Positive width-times-height cap one request image is projected into. */
  readonly maxPixels: number
  /** Encoded-byte target per request image; the smallest ladder output wins when none fits. */
  readonly maxBytes: number
}

/**
 * Execution-world path resolver, re-exported under this module's vocabulary.
 * The official type rather than a local restatement: it is what
 * `requestImageHandleText` / `offloadedImageText` accept, so an ad-hoc copy
 * could drift from the contract it is passed into.
 */
export type ImageAccessResolver = ImageAttachmentAccessResolver

/**
 * True when any message carries an image block — the guard that decides
 * whether this adapter needs the attachment service at all.
 *
 * @param messages - complete request history.
 * @returns whether any message content holds an image.
 */
export function historyHasImage(messages: readonly RequestMessage[]): boolean {
  return messages.some(message => contentHasImage(message.content))
}

/**
 * Reject image blocks in roles the wire format cannot carry them in.
 *
 * A user or tool-result message maps onto content parts, so an image there is
 * representable. Every other role serializes to a plain string (assistant
 * text plus tool calls, system/developer prose), where an image would be
 * silently dropped — the exact failure this module exists to remove, so it
 * fails loud instead.
 *
 * @param messages - complete request history.
 * @throws LlmError `UNSUPPORTED_CONTENT` naming the offending role.
 */
export function assertImageRoles(messages: readonly RequestMessage[]): void {
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'tool') continue
    if (contentHasImage(message.content)) {
      throw new LlmError(
        `aishell-llm cannot represent an image in a ${message.role} message`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/**
 * Resolve one request version per retained image, keyed by durable attachment
 * id so a reference shared by several occurrences is read once.
 *
 * Occurrences already marked `offloaded` are skipped: their bytes are not sent
 * (serialization replaces them with placeholder text), so reading them would
 * be work whose result nothing consumes.
 *
 * @param messages - complete request history.
 * @param attachments - mounted attachment service.
 * @param budget - projection policy for this route.
 * @param signal - request cancellation, honoured by the attachment read.
 * @returns request versions by durable attachment id.
 */
export async function prepareRequestImages(
  messages: readonly RequestMessage[],
  attachments: AttachmentStore,
  budget: ImageRequestBudget,
  signal?: AbortSignal,
): Promise<RequestImages> {
  const refs = new Map<ImageKey, ImageAttachmentRef>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'image' || block.offloaded === true) continue
      refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
  const ordered = [...refs.values()]
  const versions = await Promise.all(ordered.map(ref => attachments.readImageRequest(
    ref,
    { ...requestImageDimensions(ref.width, ref.height, budget.maxPixels), maxBytes: budget.maxBytes },
    signal,
  )))
  return new Map(ordered.map((ref, index) => [ref.attachmentId, versions[index]!]))
}

/**
 * Request version for one retained occurrence, or a loud failure.
 *
 * Every image block reaching serialization must have been prepared, so a
 * miss is a bug in this adapter rather than bad input — but the alternative
 * (letting the lookup produce `undefined` and reading `.bytes` off it) turns
 * it into a `TypeError` from deep inside the request body, so it is named.
 *
 * @param images - prepared request versions.
 * @param ref - durable reference of one retained occurrence.
 * @returns the request version carrying that image's bytes.
 * @throws LlmError `INVALID_REQUEST` when the reference was never prepared.
 */
export function requireRequestImage(images: RequestImages, ref: ImageAttachmentRef): RequestImageAttachment {
  const version = images.get(ref.attachmentId)
  if (version === undefined) {
    throw new LlmError(
      `aishell-llm request image ${String(ref.attachmentId)} was not prepared`,
      'INVALID_REQUEST',
    )
  }
  return version
}

/**
 * Replace every offloaded occurrence with its placeholder text.
 *
 * The durable `offloaded` mark is a surface fact shared by all routes; only
 * the placeholder wording is route-owned. Request assembly leaves this to the
 * adapter, so skipping it would send an image whose bytes this route
 * deliberately never loaded — an empty `image_url` rather than the text that
 * explains where it went.
 *
 * @param messages - complete request history.
 * @param resolveAccess - execution-world path resolver, when one is available.
 * @returns the history with offloaded occurrences projected to text.
 */
export function projectOffloaded(
  messages: readonly RequestMessage[],
  resolveAccess?: ImageAccessResolver,
): readonly RequestMessage[] {
  return projectOffloadedImages(messages, (ref) => offloadedImageText(ref, resolveAccess?.(ref)))
}

/**
 * Fail the request when its retained images exceed the route's byte budget.
 *
 * This adapter does not offload on its own: the durable decision belongs to
 * the surface, and `dsh-compaction-image-offload` (mounted by `dsh-base`) is
 * the component that records it and retries the step. Throwing the canonical
 * code with the required count is what hands it that decision.
 *
 * @param messages - complete request history, carrying the surface's offload marks.
 * @param images - prepared request versions.
 * @param maxBytes - accumulated represented base64 bytes this route accepts.
 * @throws LlmError `IMAGE_OFFLOAD_REQUIRED` carrying how many more occurrences must be offloaded.
 */
export function assertRequestImageBudget(
  messages: readonly RequestMessage[],
  images: RequestImages,
  maxBytes: number,
): void {
  const offloadImages = requiredImageOffload(
    messages,
    { representation: 'base64', maxBytes },
    block => requireRequestImage(images, block.attachment).bytes,
  )
  if (offloadImages > 0) {
    throw new LlmError(
      `aishell-llm request images exceed the ${maxBytes}-byte base64 bound; `
      + `${offloadImages} more oldest occurrence(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages },
    )
  }
}
