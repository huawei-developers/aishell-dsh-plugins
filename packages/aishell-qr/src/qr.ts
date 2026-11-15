/**
 * The `qr` tool — render text as a scannable QR code in the conversation.
 *
 * ## A tool, not an instruction
 *
 * A model told to "write a QR code" improvises the encoder: run a system binary
 * that may not exist, hand-roll a matrix, or copy a base64 blob it cannot
 * check. Each fails quietly — the reply still renders, the image is simply
 * unscannable, and neither the model nor the reader finds out until the phone
 * refuses it.
 *
 * The tool encodes once, by one implementation, and places the result where the
 * conversation can show it. The model asks for a QR code; it does not become an
 * encoder.
 *
 * ## The image is a file
 *
 * The conversation renders an image by path — `![alt](path.png)` — and strips
 * `data:` destinations. A file in the working directory is the shape that
 * displays, and it is also what lets the reader open, drag out or print the
 * code.
 *
 * @module @huaweidevtools/aishell-dsh-qr/qr
 */

import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools'

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { encodeQrPng } from './qr-encode.ts'


/** Model-facing name, prefixed so it cannot collide with another plugin's. */
export const QR_TOOL_NAME = 'aishell__qr'

/**
 * Whether a path is absolute under either separator convention.
 *
 * A host running on one platform can still be handed a path written for the
 * other — the conversation carries whatever the model typed. Recognising both
 * keeps such a path a refusal rather than a file written relative to the
 * working directory under a name that merely looks like a drive letter.
 *
 * @param path - the path as the model wrote it.
 * @returns whether it names an absolute location.
 */
export function isAbsoluteAnywhere(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(path) || path.startsWith('\\\\')
}

/**
 * Where the tool may write, and whether the call is still wanted.
 *
 * The filesystem is the host's: the mounted backend owns path resolution, the
 * sandbox fence and the canonical containment test, and it knows the separator
 * conventions of the world it runs in. Joining strings here would re-derive all
 * three, and disagree with the backend on at least one of them.
 *
 * The write itself still goes through `node:fs::writeFile`, because the backend
 * exposes text writes only and a PNG is binary. The path handed to it is the
 * backend's `processPath`, not its `displayPath`: the latter is what the model
 * and UI are shown, and a backend may answer with a remote URI there.
 */
export interface QrToolContext {
  /**
   * Resolve a model-supplied path against the session directory.
   *
   * @param path - the path the model asked for, relative or absolute.
   * @returns the resolved target, or undefined when no filesystem is mounted.
   */
  readonly resolve: (path: string) => Promise<FsTarget | undefined>
  /**
   * Resolve the working directory itself.
   *
   * @returns its target, or undefined when no filesystem is mounted.
   */
  readonly resolveDirectory: () => Promise<FsTarget | undefined>
  /**
   * The path this process can open for a resolved target.
   *
   * @param target - a target from the same backend.
   * @returns an absolute path in the backend's execution world.
   */
  readonly processPath: (target: FsTarget) => string
  /**
   * Whether one target is the other or lies beneath it.
   *
   * @param parent - the directory target.
   * @param child - the candidate target.
   * @returns true when the child is inside the parent.
   */
  readonly contains: (parent: FsTarget, child: FsTarget) => boolean
  /** The call's cancellation, observed before the write commits. */
  readonly signal: AbortSignal | undefined
}

/** The value the tool answers with. */
export interface QrOutput {
  /** The path as the reply references it, relative to the working directory. */
  readonly relativePath: string
  /** Absolute path, for a caller that needs to open it directly. */
  readonly absolutePath: string
}

/**
 * Arguments the model passes.
 *
 * The name is the path the reply references, and it is the caller's to choose.
 * A subdirectory is a path the renderer resolves, so `qr/recharge.png` displays
 * as `recharge.png` does and a directory keeps several codes apart. The name
 * says "relative" because an absolute path is refused, and a parameter called
 * `path` invites one.
 *
 * Required, because the path is what the reply writes in `![alt](path.png)`;
 * a name the tool picked is one the model would have to guess.
 */
export const QR_PARAMETERS = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'The exact text to encode — a URL, Wi-Fi credentials, or a short code.',
    },
    relativePath: {
      type: 'string',
      description:
        'File to write, relative to the working directory — the same string the reply '
        + 'references. A subdirectory is allowed and needs no pre-creation, e.g. '
        + 'qr/recharge.png.',
    },
    overwrite: {
      type: 'boolean',
      description:
        'Replace an existing file at that path. Defaults to false, in which case an existing '
        + 'file makes the call fail — replacing it would leave every earlier reply that '
        + 'referenced that path showing the new code instead of the old one.',
    },
  },
  required: ['text', 'relativePath'],
  additionalProperties: false,
}

/**
 * The value schema the tool answers with.
 *
 * Annotated because the registry types this slot as `JsonSchemaNode`, a
 * discriminated union whose `type` is a literal. Without the annotation the
 * object literal widens `type` to `string` and stops being assignable.
 */
export const QR_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    relativePath: { type: 'string' },
    absolutePath: { type: 'string' },
  },
  required: ['relativePath', 'absolutePath'],
}

/**
 * Run the QR tool.
 *
 * @param args - the model's arguments, unvalidated beyond the schema above.
 * @param context - where to write, and the call's cancellation.
 * @returns the relative path to reference, and the absolute path it resolved to.
 * @throws when the text cannot be encoded or the image cannot be placed.
 */
export async function runQr(args: unknown, context: QrToolContext): Promise<QrOutput> {
  const input = args as {
    readonly text?: unknown
    readonly relativePath?: unknown
    readonly overwrite?: unknown
  }
  const text = typeof input.text === 'string' ? input.text : ''
  if (text.length === 0) throw new Error('text is required.')

  const relative = typeof input.relativePath === 'string' ? input.relativePath.trim() : ''
  if (relative.length === 0) {
    throw new Error(
      'relativePath is required: it is the string the reply references, so the tool cannot '
      + 'choose one for you. Pass the path you will write in ![alt](path).',
    )
  }
  // One spelling for both the lookup and the reply. A markdown destination is a
  // URL path, so it is `/`-joined; resolving that same string keeps the file
  // that gets written and the reference that gets shown the same file.
  const relativePosix = relative.replace(/\\/gu, '/')

  // Absolute is refused before anything is resolved. The rule matches both
  // conventions on every platform — a leading `/`, or a Windows drive or UNC
  // prefix — because the model may name a Windows path on a host that is not
  // Windows, and the backend would then resolve it as a relative one.
  if (isAbsoluteAnywhere(relativePosix)) {
    throw new Error('relativePath must be relative to the working directory, not absolute.')
  }

  const directory = await context.resolveDirectory()
  if (directory === undefined) {
    throw new Error(
      'No working directory is available for this call, so the image cannot be placed where the '
      + 'conversation can show it. Ask the user to open a workspace, then call again.',
    )
  }

  // Resolution and containment belong to the mounted backend, which knows the
  // separator conventions, symlink behaviour and sandbox fence of the world it
  // runs in. `contains` answers in canonical terms, so no string prefix — and
  // no separator — enters the decision.
  const target = await context.resolve(relativePosix)
  if (target === undefined || !context.contains(directory, target)) {
    throw new Error('relativePath must stay inside the working directory.')
  }

  const encoded = encodeQrPng(text)
  if (!encoded.ok) throw new Error(encoded.reason)

  // Before the write, so a cancelled call leaves no file behind for a reply
  // nobody is waiting for.
  context.signal?.throwIfAborted()

  // `displayPath` is for the model and the UI, and a backend may answer with a
  // remote URI. `processPath` is the path this process can open.
  const absolutePath = context.processPath(target)
  // A subdirectory the caller named is created: the path is the reply's
  // reference, so grouping codes under `qr/` needs no separate step.
  await mkdir(dirname(absolutePath), { recursive: true })

  const overwrite = input.overwrite === true
  // `wx` refuses an existing path atomically; `w` replaces it. A check followed
  // by a write would leave a window in which two calls both pass the check.
  try {
    await writeFile(absolutePath, encoded.png, { flag: overwrite ? 'w' : 'wx' })
  } catch (error) {
    if (!overwrite && (error as { code?: string }).code === 'EEXIST') {
      throw new Error(
        `${relativePosix} already exists, and replacing it would make every earlier reply that `
        + 'referenced that path show this code instead of the one it described. Pass a '
        + 'different relativePath, or overwrite: true if the old code is meant to be replaced.',
      )
    }
    throw error
  }
  return { relativePath: relativePosix, absolutePath }
}

/**
 * The text the model reads.
 *
 * Carries the reference and the instruction to show the code beside the text it
 * encodes. The text itself is not repeated: it is the argument this call was
 * given, so the model already holds it.
 *
 * @param value - the tool's answer, as validated against `QR_OUTPUT_SCHEMA`.
 */
export function renderQrResult(value: unknown): Array<{ readonly type: 'text', readonly text: string }> {
  const output = value as QrOutput
  return [{
    type: 'text',
    text:
      `QR code written to ${output.relativePath}.\n\n`
      + `Show it inline as ![QR code](${output.relativePath}), and put the text you encoded `
      + 'underneath it — a code the user cannot scan has no fallback unless the exact text is '
      + 'beside it.',
  }]
}