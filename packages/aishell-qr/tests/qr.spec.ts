/**
 * The QR tool: what it encodes, where it writes, and what it refuses.
 *
 * The encoding itself is a library's job; what belongs to this package is the
 * decisions around it — which paths are allowed, when an existing file is
 * replaced, and whether the text reaches the image intact. A `#` fragment
 * silently dropped would produce a working QR code pointing at the wrong page,
 * which is the failure a scanner test would not catch if the scanner were run
 * on the same broken implementation.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FsTarget } from '@deepseek-ai/dsh-fs'

import { encodeQrPng } from '../src/qr-encode.ts'
import { QR_PARAMETERS, QR_OUTPUT_SCHEMA, renderQrResult, runQr, type QrToolContext } from '../src/qr.ts'

/** A working directory of its own per test, removed afterwards. */
let directory = ''
let context: QrToolContext

/**
 * A stand-in for the host's filesystem service.
 *
 * Its job here is the same as the real backend's: turn a path into a target and
 * answer containment in canonical terms. `node:path` is the right tool for this
 * fake because it models the platform the test runs on, which is the behaviour
 * the real backend also has to get right.
 */
function fakeFs(root: string): Pick<QrToolContext, 'resolve' | 'resolveDirectory' | 'processPath' | 'contains'> {
  const target = (path: string): FsTarget => ({ targetKey: path as never, displayPath: path })
  return {
    // A model-supplied path is relative to the root. Absolute input is passed
    // through so the containment test — not the fake — is what refuses it.
    resolve: async (path) => target(isAbsolute(path) ? path : join(root, path)),
    resolveDirectory: async () => target(root),
    processPath: (candidate) => candidate.displayPath,
    contains: (parent, child) => {
      const inside = relative(parent.displayPath, child.displayPath)
      return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
    },
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'aishell-qr-'))
  context = { ...fakeFs(directory), signal: undefined }
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** The recharge URL, whose `#` fragment is the part worth pinning. */
const URL_WITH_FRAGMENT = 'https://account.huaweicloud.com/usercenter/?region=cn-north-4#/userindex/balanceRecharge'

/** Assert a call was refused with a message naming the argument. */
async function refusal(args: unknown, expected: RegExp): Promise<void> {
  await expect(runQr(args, context)).rejects.toThrow(expected)
}

describe('encodeQrPng', () => {
  it('produces a PNG whose bytes begin with the PNG signature', () => {
    const result = encodeQrPng('hello')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    // IHDR is always the first chunk, and it spells the dimensions.
    expect(result.png.subarray(12, 16).toString('ascii')).toBe('IHDR')
  })

  it('grows the symbol rather than failing when the text grows', () => {
    const short = encodeQrPng('a')
    const long = encodeQrPng(URL_WITH_FRAGMENT)
    expect(short.ok && long.ok).toBe(true)
    if (!short.ok || !long.ok) return
    expect(long.modules).toBeGreaterThanOrEqual(short.modules)
    expect(long.png.length).toBeGreaterThan(0)
  })

  it('refuses empty text', () => {
    expect(encodeQrPng('')).toEqual({ ok: false, reason: 'There is no text to encode.' })
  })
})

describe('runQr — where it writes', () => {
  it('writes the file at the relative path asked for', async () => {
    const result = await runQr({ text: URL_WITH_FRAGMENT, relativePath: 'recharge.png' }, context)
    expect(result.relativePath).toBe('recharge.png')
    expect(result.absolutePath).toBe(join(directory, 'recharge.png'))
    expect((await readdir(directory))).toContain('recharge.png')
  })

  it('creates a subdirectory the caller named', async () => {
    // A group of codes in `qr/` is the ordinary way to keep them apart, so a
    // missing directory is a path to create rather than a reason to fail.
    const result = await runQr({ text: URL_WITH_FRAGMENT, relativePath: 'qr/wifi.png' }, context)
    expect(result.relativePath).toBe('qr/wifi.png')
    expect(await readdir(join(directory, 'qr'))).toEqual(['wifi.png'])
  })

  it('normalises a Windows-style separator', async () => {
    const result = await runQr({ text: 'x', relativePath: 'qr\\laptop.png' }, context)
    expect(result.relativePath).toBe('qr/laptop.png')
  })
})

describe('runQr — overwriting', () => {
  it('refuses to replace an existing file by default', async () => {
    await runQr({ text: 'first', relativePath: 'code.png' }, context)
    // Replacing it would leave every earlier reply that referenced the path
    // showing this code instead of the one it described.
    await refusal({ text: 'second', relativePath: 'code.png' }, /already exists/)
  })

  it('replaces it when overwrite is true', async () => {
    const first = await runQr({ text: 'first', relativePath: 'code.png' }, context)
    const before = await readFile(first.absolutePath)
    const second = await runQr({ text: 'second', relativePath: 'code.png', overwrite: true }, context)
    const after = await readFile(second.absolutePath)
    expect(second.absolutePath).toBe(first.absolutePath)
    // The content changed, which is what `overwrite` was asked for. Read before
    // and after rather than comparing the two results: both name one path, so
    // reading it twice at the end would compare the new file with itself.
    expect(after.equals(before)).toBe(false)
  })
})

describe('runQr — path containment', () => {
  it('refuses an absolute path', async () => {
    await refusal({ text: 'x', relativePath: '/etc/code.png' }, /not absolute/)
  })

  it('refuses a Windows absolute path', async () => {
    await refusal({ text: 'x', relativePath: 'C:\\code.png' }, /not absolute/)
  })

  it('refuses a parent-directory escape', async () => {
    // The rendered image and the trust boundary both stop at the working
    // directory; `..` leaves it.
    await refusal({ text: 'x', relativePath: '../code.png' }, /inside the working directory/)
    await refusal({ text: 'x', relativePath: 'qr/../../code.png' }, /inside the working directory/)
  })

  it('accepts a nested path whose parent directory does not exist yet', async () => {
    // The containment test must not depend on the separator being `/`: a
    // prefix comparison written for one platform rejects every path on the
    // other. A deep path that stays inside is the case that exposes it.
    const result = await runQr({ text: 'x', relativePath: 'a/b/c/code.png' }, context)
    expect(result.relativePath).toBe('a/b/c/code.png')
    expect(await readdir(join(directory, 'a', 'b', 'c'))).toEqual(['code.png'])
  })

  it('requires the path argument', async () => {
    // No default: the path is what the reply references, so a tool-chosen name
    // is one the model would then have to guess.
    await refusal({ text: 'x' }, /relativePath is required/)
    await refusal({ text: 'x', relativePath: '   ' }, /relativePath is required/)
  })
})

describe('runQr — other refusals', () => {
  it('requires text', async () => {
    await refusal({ relativePath: 'x.png' }, /text is required/)
  })

  it('reports the encoder\'s own capacity limit as a refusal', async () => {
    // Version 40 with error correction M tops out around 2331 ASCII characters.
    // Past that the encoder throws, and the throw is turned into a message the
    // model can act on rather than an exception escaping from a library.
    await refusal({ text: 'x'.repeat(3000), relativePath: 'x.png' }, /could not be encoded/)
  })

  it('reports a host with no working directory instead of writing somewhere else', async () => {
    // No filesystem service at all: there is nowhere to resolve to, and the
    // tool says so rather than writing to the process's launch directory.
    await expect(runQr({ text: 'x', relativePath: 'x.png' }, {
      resolve: async () => undefined,
      resolveDirectory: async () => undefined,
      processPath: (target) => target.displayPath,
      contains: () => false,
      signal: undefined,
    })).rejects.toThrow(/No working directory/)
  })

  it('writes nothing when the call was aborted before the write', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runQr({ text: 'x', relativePath: 'x.png' }, {
      ...fakeFs(directory),
      signal: controller.signal,
    })).rejects.toThrow()
    expect(await readdir(directory)).toEqual([])
  })
})

describe('what the model is told', () => {
  it('requires text and the relative path, and does not default either', () => {
    expect(QR_PARAMETERS.required).toEqual(['text', 'relativePath'])
    // `overwrite` is optional and defaults to false, which is the refusal above.
    expect(QR_PARAMETERS.properties.overwrite.type).toBe('boolean')
    expect((QR_PARAMETERS.required as readonly string[])).not.toContain('overwrite')
  })

  it('answers with the path the reply must reference', () => {
    expect(QR_OUTPUT_SCHEMA.required).toEqual(['relativePath', 'absolutePath'])
  })

  it('tells the reply to show the image and repeat the text beneath it', () => {
    // A code the user cannot scan has no fallback unless the text is beside it.
    const blocks = renderQrResult({ relativePath: 'qr/recharge.png', absolutePath: '/tmp/qr/recharge.png' })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toContain('![QR code](qr/recharge.png)')
    // The instruction says to repeat the encoded text, and does not repeat it
    // itself: the argument is already in the model's hands.
    expect(blocks[0]?.text).toMatch(/text you encoded/)
    expect(blocks[0]?.text).not.toContain(URL_WITH_FRAGMENT)
  })
})