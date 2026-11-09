/**
 * Request-image pipeline behavior.
 *
 * What these pin: an adapter that advertises `image` in `inputModalities` must
 * actually carry image bytes onto the wire, and must fail loudly for every case
 * it cannot carry. The failure mode being guarded against is silence — the
 * previous adapter declared image input and then dropped the blocks, so the
 * model received an empty turn. Every `expect(...).toThrow` here is a case that
 * used to degrade into nothing.
 */

import { describe, it, expect, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import {
  assertImageRoles,
  assertRequestImageBudget,
  historyHasImage,
  prepareRequestImages,
  projectOffloaded,
  requireRequestImage,
  type ImageRequestBudget,
} from '../src/images.ts'

// ── fixtures ──

function imageRef(id: string, width = 100, height = 50): ImageAttachmentRef {
  return { attachmentId: id, mediaType: 'image/png', bytes: 10, width, height } as ImageAttachmentRef
}

const image = (ref: ImageAttachmentRef, offloaded = false): ContentBlock =>
  ({ type: 'image', attachment: ref, ...(offloaded ? { offloaded: true as const } : {}) })

const text = (t: string): ContentBlock => ({ type: 'text', text: t })

/** One message; `role` is widened to build the unsupported-role cases. */
function message(role: string, content: ContentBlock[]): RequestMessage {
  return { role, content } as unknown as RequestMessage
}

const BUDGET: ImageRequestBudget = { maxPixels: 4_194_304, maxBytes: 1_048_576 }

/** Stub attachment service recording every read, returning fixed bytes per id. */
function makeAttachments(byteLengths: Record<string, number> = {}): {
  store: AttachmentStore
  reads: Array<{ id: string; target: { width: number; height: number; maxBytes: number } }>
} {
  const reads: Array<{ id: string; target: { width: number; height: number; maxBytes: number } }> = []
  const store = {
    readImageRequest: vi.fn(async (ref: ImageAttachmentRef, target: { width: number; height: number; maxBytes: number }) => {
      reads.push({ id: ref.attachmentId, target })
      const bytes = byteLengths[ref.attachmentId] ?? 4
      return {
        variantId: `v-${ref.attachmentId}`,
        attachment: ref,
        data: new Uint8Array(bytes),
        mediaType: 'image/png',
        bytes,
        width: target.width,
        height: target.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      } as unknown as RequestImageAttachment
    }),
  } as unknown as AttachmentStore
  return { store, reads }
}

// ── detection ──

describe('historyHasImage', () => {
  it('is false for text-only history', () => {
    expect(historyHasImage([message('user', [text('hi')])])).toBe(false)
  })

  it('is true when any message carries an image', () => {
    expect(historyHasImage([
      message('user', [text('hi')]),
      message('user', [image(imageRef('a'))]),
    ])).toBe(true)
  })
})

// ── role guard ──

describe('assertImageRoles', () => {
  it('accepts images in user and tool messages', () => {
    expect(() => assertImageRoles([
      message('user', [image(imageRef('a'))]),
      message('tool', [image(imageRef('b'))]),
    ])).not.toThrow()
  })

  it.each(['assistant', 'system', 'developer'])('rejects an image in a %s message', (role) => {
    // Those roles serialize to a plain string, so an image there can only be
    // dropped — the exact failure this guard exists to convert into an error.
    // The role is matched explicitly, so an implementation that rejected every
    // role (or the wrong one) could not pass.
    expect(() => assertImageRoles([message(role, [image(imageRef('a'))])]))
      .toThrow(new RegExp(`cannot represent an image in a ${role} message`))
  })
})

// ── preparation ──

describe('prepareRequestImages', () => {
  it('reads one version per distinct attachment', async () => {
    const { store, reads } = makeAttachments()
    const shared = imageRef('shared')
    const versions = await prepareRequestImages([
      message('user', [image(shared), text('and again')]),
      message('user', [image(shared)]),
    ], store, BUDGET)
    expect(versions.size).toBe(1)
    expect(reads).toHaveLength(1)
  })

  it('passes the projected dimensions and byte target from the budget', async () => {
    const { store, reads } = makeAttachments()
    // A 4000x1000 source under a 1M-pixel cap keeps its aspect ratio.
    await prepareRequestImages([message('user', [image(imageRef('big', 4000, 1000))])], store, {
      maxPixels: 1_000_000,
      maxBytes: 512,
    })
    expect(reads[0]!.target).toEqual({ width: 2000, height: 500, maxBytes: 512 })
  })

  it('skips offloaded occurrences, whose bytes are never sent', async () => {
    const { store, reads } = makeAttachments()
    const versions = await prepareRequestImages(
      [message('user', [image(imageRef('gone'), true)])],
      store,
      BUDGET,
    )
    expect(versions.size).toBe(0)
    expect(reads).toHaveLength(0)
  })

  it('returns an empty map for text-only history', async () => {
    const { store } = makeAttachments()
    const versions = await prepareRequestImages([message('user', [text('hi')])], store, BUDGET)
    expect(versions.size).toBe(0)
  })
})

describe('requireRequestImage', () => {
  it('returns the prepared version', async () => {
    const ref = imageRef('a')
    const { store } = makeAttachments()
    const versions = await prepareRequestImages([message('user', [image(ref)])], store, BUDGET)
    expect(requireRequestImage(versions, ref).attachment.attachmentId).toBe('a')
  })

  it('fails loudly for an unprepared reference', () => {
    expect(() => requireRequestImage(new Map(), imageRef('missing')))
      .toThrow(/was not prepared/)
  })
})

// ── offload projection ──

describe('projectOffloaded', () => {
  it('replaces an offloaded occurrence with placeholder text', async () => {
    const ref = imageRef('gone')
    const projected = projectOffloaded([message('user', [image(ref, true)])])
    const content = projected[0]!.content
    expect(content.some(block => block.type === 'image')).toBe(false)
    expect(content.some(block => block.type === 'text' && block.text.includes('omitted'))).toBe(true)
  })

  it('leaves retained occurrences untouched', () => {
    const ref = imageRef('kept')
    const projected = projectOffloaded([message('user', [image(ref)])])
    expect(projected[0]!.content.some(block => block.type === 'image')).toBe(true)
  })
})

// ── budget ──

describe('assertRequestImageBudget', () => {
  it('passes a request within the byte bound', async () => {
    const ref = imageRef('small')
    const { store } = makeAttachments({ small: 4 })
    const versions = await prepareRequestImages([message('user', [image(ref)])], store, BUDGET)
    expect(() => assertRequestImageBudget([message('user', [image(ref)])], versions, 1_000_000)).not.toThrow()
  })

  it('throws IMAGE_OFFLOAD_REQUIRED carrying how many occurrences to offload', async () => {
    // Two 6-byte images represent as 8 base64 bytes each (ceil(6/3)*4). A
    // 10-byte bound therefore needs one occurrence offloaded, not both.
    const a = imageRef('a')
    const b = imageRef('b')
    const { store } = makeAttachments({ a: 6, b: 6 })
    const messages = [message('user', [image(a), image(b)])]
    const versions = await prepareRequestImages(messages, store, BUDGET)
    let caught: unknown
    try {
      assertRequestImageBudget(messages, versions, 10)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('IMAGE_OFFLOAD_REQUIRED')
    expect((caught as LlmError).failure.offloadImages).toBe(1)
  })

  it('ignores already-offloaded occurrences when accounting', async () => {
    const kept = imageRef('kept')
    const gone = imageRef('gone')
    const { store } = makeAttachments({ kept: 6 })
    const messages = [message('user', [image(gone, true), image(kept)])]
    const versions = await prepareRequestImages(messages, store, BUDGET)
    expect(() => assertRequestImageBudget(messages, versions, 10)).not.toThrow()
  })
})
