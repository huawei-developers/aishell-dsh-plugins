/**
 * The QR-code tool: renders text as a PNG the conversation can show.
 *
 * ## One package per general-purpose tool
 *
 * A capability belongs to the package that owns it. Rendering text as a
 * scannable image touches no credential, no cloud service, and no meaning of
 * the text itself — so it is a package of its own, and mounting it mounts
 * exactly that capability. A harness ships its twenty-odd general tools the
 * same way: one package each, none of them a container.
 *
 * ## No `deferLoading`
 *
 * One tool is one schema in the prompt. `deferLoading: true` would save that
 * schema and add the machinery that activates the declaration later, which is a
 * trade worth making when a package carries several tools. This one carries
 * one.
 *
 * @module @huaweidevtools/aishell-dsh-qr
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
// Type-only: pulls the ctx.tools merge, which is where a tool is registered.
import type {} from '@deepseek-ai/dsh-tools'

import { QR_OUTPUT_SCHEMA, QR_PARAMETERS, renderQrResult, runQr } from './qr.ts'

export { encodeQrPng, DEFAULT_MARGIN, DEFAULT_SCALE, type EncodeResult } from './qr-encode.ts'
export { QR_TOOL_NAME } from './qr.ts'

export const name = 'aishell-qr'

/**
 * No required services.
 *
 * `tools` is taken through `ctx.inject` inside {@link apply}, so a deployment
 * without a tool registry loses the tool rather than failing to mount an entry
 * whose whole purpose is optional.
 */
export const inject: readonly string[] = []

export function apply(ctx: Context): void {
  ctx.inject(['tools'], (scope) => {
    return scope.tools.register({
      name: 'aishell__qr',
      description:
        'Render text as a QR code and write it into the working directory as a PNG. '
        + 'Returns the relative path to reference with ![alt](path.png) in a reply. '
        + 'Use it when the text has to be handed to another device by scanning — a link, '
        + 'a Wi-Fi credential, a short code — rather than read on this screen.',
      parameters: QR_PARAMETERS,
      output: {
        schema: QR_OUTPUT_SCHEMA,
        render: renderQrResult,
      },
      async execute(args: unknown, exec: unknown) {
        const fs = ctx.get('fs') as FileSystemService | undefined
        return await runQr(args, {
          // The mounted backend owns resolution and containment; without one
          // there is nowhere to write that the conversation could render.
          resolve: async (path) => fs === undefined ? undefined : await fs.resolve(path, await resolveOptions(ctx, exec)),
          resolveDirectory: async () => fs === undefined ? undefined : await resolveDirectory(ctx, fs, exec),
          processPath: (target) => fs === undefined ? target.displayPath : fs.processPath(target),
          contains: (parent, child) => fs === undefined ? false : fs.contains(parent, child),
          signal: (exec as { signal?: AbortSignal } | undefined)?.signal,
        })
      },
    })
  })
}

/** The filesystem service, as this plugin needs it. */
interface FileSystemService {
  readonly resolve: (path: string, opts?: { cwd?: string, signal?: AbortSignal }) => Promise<FsTarget>
  readonly processPath: (target: FsTarget) => string
  readonly contains: (parent: FsTarget, child: FsTarget) => boolean
}

/** The session directory service, as this plugin needs it. */
interface WorkingDirectoryService {
  readonly ensure: (agent: object, signal?: AbortSignal) => Promise<string>
}

/**
 * Resolution options for one call, as the filesystem service takes them.
 *
 * The working directory is asked per call rather than captured: the service can
 * be mounted after this plugin activates, and a subagent's directory can differ
 * from its parent's, so the answer belongs to the call. A host that offers no
 * directory yields options without a `cwd`, and `resolve` then applies whatever
 * default its own backend defines.
 *
 * @param ctx - host context.
 * @param exec - the execution context, carrying the agent and cancellation.
 * @returns the options for a filesystem call in this session.
 */
async function resolveOptions(
  ctx: Context,
  exec: unknown,
): Promise<{ cwd?: string, signal?: AbortSignal }> {
  const agent = (exec as { agent?: object } | undefined)?.agent
  const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
  const service = ctx.get('workingDirectory') as WorkingDirectoryService | undefined
  if (service === undefined || agent === undefined) return signal === undefined ? {} : { signal }
  try {
    return { cwd: await service.ensure(agent, signal), ...signal === undefined ? {} : { signal } }
  } catch {
    // A directory the host could not resolve leaves resolution to the backend's
    // own default, which is the same situation as a host that offers none.
    return signal === undefined ? {} : { signal }
  }
}

/**
 * The working directory as a target, for the containment test.
 *
 * @param ctx - host context.
 * @param fs - the filesystem service.
 * @param exec - the execution context.
 * @returns the directory target, or undefined when none can be established.
 */
async function resolveDirectory(
  ctx: Context,
  fs: FileSystemService,
  exec: unknown,
): Promise<FsTarget | undefined> {
  const options = await resolveOptions(ctx, exec)
  if (options.cwd === undefined) return undefined
  return await fs.resolve(options.cwd, options)
}
