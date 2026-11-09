/**
 * The model-facing tools.
 *
 * Each one is a thin projection of an E2B SDK call: the tool's parameters are
 * the SDK's own options, and its result is the SDK's own return value in a
 * shape that survives JSON. That correspondence is the point — an operator who
 * reads the E2B documentation should find nothing surprising here, and the
 * next plugin in this family can keep the same contract.
 *
 * Three conventions are load-bearing and are repeated in the descriptions the
 * model reads:
 *
 *   - **One conversation, one sandbox.** No tool but `aishell__sandbox_create` takes a
 *     `sandboxId`. There is nothing to choose between, so there is no parameter
 *     to get wrong, and no way for a call to land in a different sandbox than
 *     the model meant.
 *   - **`timeoutMs` is milliseconds.** The TypeScript SDK counts milliseconds
 *     where the Python one counts seconds; a model that learned the Python
 *     spelling would ask for a five-second sandbox and get five thousand.
 *   - **A non-zero exit is a result, not a failure.** `aishell__sandbox_commands_run`
 *     reports the code and both streams, so a failing command reads as an
 *     outcome to reason about rather than a broken tool.
 *
 * @module @huaweidevtools/aishell-dsh-e2b/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Sandbox } from 'e2b'

import type { SandboxClient } from './client.ts'
import { SandboxToolError, describeSandboxError, isCommandExitError, errorName } from './errors.ts'
import {
  NO_SANDBOX_MESSAGE,
  SANDBOX_GONE_MESSAGE,
  sessionMetadata,
  type SandboxRegistry,
} from './sandbox-registry.ts'

/** What every tool needs to act. */
export interface ToolDeps {
  /** The sandbox gateway connection. */
  readonly client: SandboxClient
  /** The sandbox this conversation is bound to. */
  readonly registry: SandboxRegistry
  /** The filesystem the local workspace is reached through, when one is mounted. */
  readonly resolveFs: () => Context['fs'] | undefined
  /**
   * The session working-directory service, when one is mounted.
   *
   * A thunk like {@link resolveFs}, and optional for the same reason: a
   * deployment without it loses one behaviour (where a relative destination
   * lands) rather than failing to mount.
   */
  readonly resolveWorkingDirectory: () => SessionDirectories | undefined
}

/**
 * The sandbox this call acts on, or a failure naming the way forward.
 *
 * Recovery is attempted on every call, not only in `aishell__sandbox_create`: a plugin
 * restart between two calls would otherwise strand a running sandbox, and the
 * model would create a second one while the first kept billing.
 *
 * @param deps - the tool dependencies.
 * @param sessionId - the calling conversation, from the execution context.
 * @param signal - caller cancellation, forwarded to the recovery lookup.
 * @returns the bound sandbox id.
 */
async function requireSandboxId(
  deps: ToolDeps,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const id = await deps.registry.resolve(sessionId, signal)
  if (id === undefined) throw new SandboxToolError(NO_SANDBOX_MESSAGE)
  return id
}

/**
 * Translate a failure about the sandbox itself into the message that fits.
 *
 * A sandbox that has expired is not the same situation as a conversation that
 * never had one, and the distinction is worth the trouble: the first means the
 * work in it is gone and a replacement starts empty, which the model has to
 * know before it decides to continue.
 *
 * @param error - the thrown value.
 * @param context - what the call was doing.
 * @returns the message to fail with.
 */
function describeBoundError(error: unknown, context: string): string {
  return errorName(error) === 'SandboxNotFoundError'
    ? SANDBOX_GONE_MESSAGE
    : describeSandboxError(error, context)
}

/** One sandbox's identity, resources, and lifetime, as the tools report them. */
interface SandboxDescription {
  readonly sandboxId: string
  readonly templateId: string
  readonly state: string
  readonly startedAt: string
  readonly endAt: string
  readonly cpuCount: number
  readonly memoryMB: number
  readonly envdVersion: string
  readonly metadata?: Record<string, string>
}

/** Project one sandbox's identity and lifetime into a JSON-safe object. */
function describeInfo(info: Awaited<ReturnType<Sandbox['getInfo']>>): SandboxDescription {
  return {
    sandboxId: info.sandboxId,
    templateId: info.templateId,
    state: info.state,
    startedAt: info.startedAt.toISOString(),
    endAt: info.endAt.toISOString(),
    cpuCount: info.cpuCount,
    memoryMB: info.memoryMB,
    envdVersion: info.envdVersion,
    ...(info.metadata === undefined ? {} : { metadata: info.metadata }),
  }
}

/**
 * How much of a command's output a result carries before it is elided.
 *
 * Counted in code points, which is what a reader means by "characters" and what
 * the context budget is actually spent in. A UTF-16 code unit is a third of the
 * cost for a three-byte character, so measuring in units would let 30 000 CJK
 * characters through as 90 KB of text.
 */
const OUTPUT_LIMIT = 30_000

/**
 * Keep a stream useful without letting one command flood the context.
 *
 * Truncation walks code points rather than slicing at a unit index: a slice at
 * an odd offset inside a surrogate pair leaves a lone surrogate, which is not
 * valid text and renders as a replacement character at the cut.
 *
 * @param text - the stream as received.
 * @returns the text, and whether any of it was dropped.
 */
function clip(text: string): { readonly text: string, readonly truncated: boolean } {
  // A string can only exceed the limit in code points if it exceeds it in code
  // units, so the cheap check settles the common case.
  if (text.length <= OUTPUT_LIMIT) return { text, truncated: false }
  // Surrogate pairs make the two counts differ, and only the code-point count
  // decides. Iterating the string yields code points, so it is the count a
  // person would give — and slicing that array cannot split a pair.
  const points = [...text]
  if (points.length <= OUTPUT_LIMIT) return { text, truncated: false }
  return { text: points.slice(0, OUTPUT_LIMIT).join(''), truncated: true }
}

/**
 * Reject a map whose values are not strings.
 *
 * The tool's schema can only say "an object" — the harness schema DSL has no
 * way to constrain the value type of a free-form map — while both the sandbox
 * service and the SDK require string values. Without this check a number or a
 * nested object would be stringified somewhere downstream and surface as a
 * command that behaves oddly, far from the call that caused it.
 */
function stringMap(value: Record<string, unknown>, field: string): Record<string, string> {
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new SandboxToolError(
        `aishell-e2b: ${field}.${key} must be a string, got ${typeof entry}.`,
      )
    }
  }
  return value as Record<string, string>
}

/** The session id a tool call runs under, from its execution context. */
function sessionOf(exec: { agent?: { session?: { id?: string } } }): string | undefined {
  return exec.agent?.session?.id
}

/**
 * The working-directory service, as this plugin needs it.
 *
 * Structural rather than imported, for the same reason {@link sessionOf} is:
 * importing `@deepseek-ai/dsh-working-directory` for the type would add a
 * framework dependency whose own `schemastery` pin differs from this package's,
 * and the resulting duplicate copy leaks into the emitted `.d.ts` through a
 * `.pnpm/…` path nobody installing this package has. One method is all that is
 * used, so one method is all that is declared.
 */
export interface SessionDirectories {
  /**
   * The session's effective absolute directory, validated.
   *
   * @param agent - the agent owning the session.
   * @param signal - cancellation for the filesystem inspection.
   */
  readonly ensure: (agent: object, signal?: AbortSignal) => Promise<string>
}

/**
 * Path-resolution options for a call, anchored at the session's directory.
 *
 * Without this a relative path resolves against the filesystem backend's own
 * default — `process.cwd()`, the directory the host was launched from — which
 * has nothing to do with the working directory the person picked for this
 * session. Every other filesystem tool in the product anchors at the session,
 * so a relative `localPath` means the same thing here as it does in a shell
 * running in that session.
 *
 * `ensure` rather than `get`: it returns an absolute directory and validates
 * that it still exists, restoring the original project when it has been
 * removed. `get` is cheaper but is a pure read, so a deleted directory would be
 * handed back and every write under it would fail.
 *
 * Both the service and the agent are optional, and their absence is not an
 * error: a call outside an agent, or a deployment without the service, falls
 * back to the backend's own default rather than refusing to write.
 *
 * @param deps - the tool dependencies, for the working-directory service.
 * @param exec - the call, for its owning agent and cancellation.
 */
async function sessionResolveOptions(
  deps: ToolDeps,
  exec: { agent?: object, signal: AbortSignal },
): Promise<{ cwd?: string, signal: AbortSignal }> {
  const service = deps.resolveWorkingDirectory()
  const agent = exec.agent
  const cwd = service === undefined || agent === undefined
    ? undefined
    : await service.ensure(agent, exec.signal)
  return { ...cwd === undefined ? {} : { cwd }, signal: exec.signal }
}

/**
 * Register every sandbox tool.
 *
 * @param ctx - the plugin context, providing the tool registry.
 * @param deps - the shared dependencies.
 * @returns disposers for the registrations.
 */
export function registerSandboxTools(ctx: Context, deps: ToolDeps): Array<() => void> {
  const definitions: ToolDefinition[] = [
    createSandboxTool(deps),
    listSandboxesTool(deps),
    sandboxInfoTool(deps),
    killSandboxTool(deps),
    setSandboxTimeoutTool(deps),
    runCommandTool(deps),
    killCommandTool(deps),
    writeFileTool(deps),
    readFileTool(deps),
    downloadFileTool(deps, ctx),
    listFilesTool(deps),
    getPortUrlTool(deps),
  ]
  return definitions.map(definition => ctx.tools.register(definition))
}

/** The output schema every sandbox-describing tool shares. */
const SANDBOX_DESCRIPTION_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    sandboxId: { type: 'string' as const, required: true as const },
    templateId: { type: 'string' as const, required: true as const },
    state: { type: 'string' as const, required: true as const },
    startedAt: { type: 'string' as const, required: true as const },
    endAt: { type: 'string' as const, required: true as const },
    cpuCount: { type: 'integer' as const, required: true as const },
    memoryMB: { type: 'integer' as const, required: true as const },
    envdVersion: { type: 'string' as const, required: true as const },
    metadata: { type: 'object' as const, additionalProperties: true as const },
  },
}

/** The one-line rendering every sandbox-describing tool shares. */
function renderSandboxDescription(value: {
  sandboxId: string
  state: string
  endAt: string
}): [{ type: 'text', text: string }] {
  return [{
    type: 'text',
    text: `Sandbox ${value.sandboxId} is ${value.state}, expires at ${value.endAt}.`,
  }]
}

function createSandboxTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_create',
    description:
      'Create a sandbox for this conversation: a disposable Linux environment that runs '
      + 'for a bounded time and is then deleted along with everything in it. This binds '
      + 'the sandbox to the conversation — the other sandbox tools act on it without '
      + 'being told which one. Creating a second one replaces the binding; the first '
      + 'keeps running until its lifetime expires, so delete it with aishell__sandbox_kill when '
      + 'it is no longer needed.',
    parameters: {
      template: {
        type: 'string',
        description:
          "Template name or id to start from. Defaults to the service's base template.",
      },
      timeoutMs: {
        type: 'number',
        description:
          'Lifetime in MILLISECONDS (the TypeScript SDK counts milliseconds; the Python '
          + 'SDK counts seconds). The sandbox and everything in it are deleted when this '
          + 'expires. Default 300000 (5 minutes). Choose it from what the work needs: a '
          + 'page to look at once needs minutes, a working session longer.',
      },
      envs: {
        type: 'object',
        additionalProperties: true,
        description: 'Environment variables every command in the sandbox starts with.',
      },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description:
          'Extra key/value labels for finding this sandbox later with aishell__sandbox_list. The '
          + 'conversation tag is added automatically.',
      },
    },
    output: {
      schema: SANDBOX_DESCRIPTION_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `Sandbox ${value.sandboxId} is ${value.state} `
          + `(${String(value.cpuCount)} vCPU, ${String(value.memoryMB)} MB), `
          + `expires at ${value.endAt}.`,
      }],
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const input = args as {
        template?: string
        timeoutMs?: number
        envs?: Record<string, unknown>
        metadata?: Record<string, unknown>
      }
      const sessionId = sessionOf(exec)
      try {
        const metadata = sessionMetadata(
          sessionId,
          input.metadata === undefined ? undefined : stringMap(input.metadata, 'metadata'),
        )
        const sandbox = await deps.client.create(input.template, {
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(input.envs === undefined ? {} : { envs: stringMap(input.envs, 'envs') }),
          ...(metadata === undefined ? {} : { metadata }),
          signal: exec.signal,
        })
        deps.registry.bind(sessionId, sandbox.sandboxId)
        return describeInfo(await sandbox.getInfo({ signal: exec.signal }))
      } catch (error) {
        throw new SandboxToolError(describeSandboxError(error, 'aishell__sandbox_create'))
      }
    },
  })
}

function listSandboxesTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_list',
    description:
      'List the sandboxes this account currently has. Reports sandboxes from every '
      + 'conversation, not just this one.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sandboxes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sandboxId: { type: 'string', required: true },
                templateId: { type: 'string', required: true },
                state: { type: 'string', required: true },
                startedAt: { type: 'string', required: true },
                endAt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const rows = value.sandboxes
        if (rows.length === 0) return [{ type: 'text', text: 'No sandboxes.' }]
        const lines = rows.map(row => (
          `${row.sandboxId}  ${row.state}  expires ${row.endAt}  (${row.templateId})`
        ))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 60_000,
    async execute(_args, exec) {
      try {
        return { sandboxes: await deps.client.list(exec.signal) }
      } catch (error) {
        throw new SandboxToolError(describeSandboxError(error, 'aishell__sandbox_list'))
      }
    },
  })
}

function sandboxInfoTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_info',
    description: 'Report this conversation\'s sandbox: its state, resources, and expiry time.',
    parameters: {},
    output: {
      schema: SANDBOX_DESCRIPTION_SCHEMA,
      render: (_args, value) => renderSandboxDescription(value),
    },
    timeoutMs: 60_000,
    async execute(_args, exec) {
      const sandboxId = await requireSandboxId(deps, sessionOf(exec), exec.signal)
      try {
        const handle = await deps.client.handle(sandboxId)
        return describeInfo(await handle.getInfo({ signal: exec.signal }))
      } catch (error) {
        throw new SandboxToolError(describeBoundError(error, 'aishell__sandbox_info'))
      }
    },
  })
}

function killSandboxTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_kill',
    description:
      'Delete this conversation\'s sandbox immediately, discarding everything in it, and '
      + 'release the conversation\'s binding to it. Do this when the work is done rather '
      + 'than waiting for the lifetime to expire.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sandboxId: { type: 'string', required: true },
          killed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.killed
          ? `Sandbox ${value.sandboxId} deleted.`
          : `Sandbox ${value.sandboxId} was already gone.`,
      }],
    },
    timeoutMs: 60_000,
    async execute(_args, exec) {
      const sessionId = sessionOf(exec)
      const sandboxId = await requireSandboxId(deps, sessionId, exec.signal)
      try {
        const handle = await deps.client.handle(sandboxId)
        await handle.kill({ signal: exec.signal })
        // The handle addresses an endpoint that no longer exists, and the
        // conversation should not keep pointing at it.
        deps.client.forget(sandboxId)
        deps.registry.forget(sandboxId)
        return { sandboxId, killed: true }
      } catch (error) {
        // A sandbox that is already gone is the outcome the caller wanted, so
        // the binding is dropped either way rather than left stale.
        if (errorName(error) === 'SandboxNotFoundError') {
          deps.client.forget(sandboxId)
          deps.registry.forget(sandboxId)
          return { sandboxId, killed: false }
        }
        throw new SandboxToolError(describeSandboxError(error, 'aishell__sandbox_kill'))
      }
    },
  })
}

function setSandboxTimeoutTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_set_timeout',
    description:
      'Change how long this conversation\'s sandbox stays alive, measured from now. Use '
      + 'it to extend a sandbox that is still needed, or to shorten one that is not.',
    parameters: {
      timeoutMs: {
        type: 'number',
        required: true,
        description:
          'New lifetime in MILLISECONDS from now. The service caps this at 24 hours for '
          + 'a pro account and 1 hour for a hobby account.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sandboxId: { type: 'string', required: true },
          endAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Sandbox ${value.sandboxId} now expires at ${value.endAt}.`,
      }],
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const input = args as { timeoutMs: number }
      const sandboxId = await requireSandboxId(deps, sessionOf(exec), exec.signal)
      try {
        const handle = await deps.client.handle(sandboxId)
        await handle.setTimeout(input.timeoutMs, { signal: exec.signal })
        const info = await handle.getInfo({ signal: exec.signal })
        return { sandboxId, endAt: info.endAt.toISOString() }
      } catch (error) {
        throw new SandboxToolError(describeBoundError(error, 'aishell__sandbox_set_timeout'))
      }
    },
  })
}

function runCommandTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_commands_run',
    description:
      'Run a shell command in this conversation\'s sandbox. A command that exits non-zero '
      + 'is reported with its exit code and output rather than failing the tool, so a '
      + 'build error or a test failure reads as a result. Set background to start a '
      + 'long-running process (a server, for example) and get its pid back immediately.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'Shell command to run, executed by bash inside the sandbox.',
      },
      cwd: { type: 'string', description: 'Working directory inside the sandbox.' },
      envs: {
        type: 'object',
        additionalProperties: true,
        description: 'Environment variables for this command, added to the sandbox\'s own.',
      },
      timeoutMs: {
        type: 'number',
        description: 'How long to let the command run, in MILLISECONDS. Default 60000.',
      },
      background: {
        type: 'boolean',
        description:
          'Start the command and return its pid without waiting. Use it for a server '
          + 'that should keep running, and stop it later with aishell__sandbox_commands_kill.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          outputTruncated: { type: 'boolean' },
          pid: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        if (value.pid !== undefined) {
          return [{
            type: 'text',
            text: `Started in the background with pid ${String(value.pid)}.`,
          }]
        }
        const parts = [`exit ${String(value.exitCode ?? '?')}`]
        if (value.stdout) parts.push(`stdout:\n${value.stdout}`)
        if (value.stderr) parts.push(`stderr:\n${value.stderr}`)
        if (value.outputTruncated) parts.push('(output truncated)')
        return [{ type: 'text', text: parts.join('\n') }]
      },
    },
    timeoutMs: 300_000,
    async execute(args, exec) {
      const input = args as {
        command: string
        cwd?: string
        envs?: Record<string, unknown>
        timeoutMs?: number
        background?: boolean
      }
      const sandboxId = await requireSandboxId(deps, sessionOf(exec), exec.signal)
      try {
        const handle = await deps.client.handle(sandboxId)
        const options = {
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.envs === undefined ? {} : { envs: stringMap(input.envs, 'envs') }),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          signal: exec.signal,
        }

        if (input.background === true) {
          const process = await handle.commands.run(input.command, { ...options, background: true })
          return { pid: process.pid }
        }

        try {
          const result = await handle.commands.run(input.command, options)
          const out = clip(result.stdout)
          const err = clip(result.stderr)
          return {
            exitCode: result.exitCode,
            stdout: out.text,
            stderr: err.text,
            outputTruncated: out.truncated || err.truncated,
          }
        } catch (error) {
          // A non-zero exit arrives as a rejection carrying the same fields a
          // success would. It is an outcome, not a tool failure.
          if (isCommandExitError(error)) {
            const out = clip(String(error.stdout))
            const err = clip(String(error.stderr))
            return {
              exitCode: error.exitCode,
              stdout: out.text,
              stderr: err.text,
              outputTruncated: out.truncated || err.truncated,
            }
          }
          throw error
        }
      } catch (error) {
        throw new SandboxToolError(describeBoundError(error, 'aishell__sandbox_commands_run'))
      }
    },
  })
}

function killCommandTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_commands_kill',
    description:
      'Stop a process running in this conversation\'s sandbox, by the pid aishell__sandbox_commands_run '
      + 'returned for a background command. Use it to stop a server started earlier — for '
      + 'example to free its port or to restart it with different settings — without '
      + 'deleting the whole sandbox and everything in it.',
    parameters: {
      pid: {
        type: 'integer',
        required: true,
        description: 'Process id, as returned by a background aishell__sandbox_commands_run.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pid: { type: 'integer', required: true },
          killed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.killed
          ? `Process ${String(value.pid)} stopped.`
          : `No process ${String(value.pid)} was running.`,
      }],
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const input = args as { pid: number }
      const sandboxId = await requireSandboxId(deps, sessionOf(exec), exec.signal)
      try {
        const handle = await deps.client.handle(sandboxId)
        // `false` means the pid was already gone, which is the outcome the
        // caller asked for. Reporting it as a failure would invite a retry
        // that can only fail again.
        const killed = await handle.commands.kill(input.pid, { signal: exec.signal })
        return { pid: input.pid, killed }
      } catch (error) {
        throw new SandboxToolError(describeBoundError(error, 'aishell__sandbox_commands_kill'))
      }
    },
  })
}

function writeFileTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_files_write',
    description:
      'Write a text file in this conversation\'s sandbox, creating parent directories as '
      + 'needed. Use it to put source, configuration, or a static page where a command '
      + 'can read it.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path inside the sandbox, e.g. /home/user/site/index.html.',
      },
      content: {
        type: 'string',
        required: true,
        description: 'Full file content, written as UTF-8 text.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Wrote ${String(value.bytes)} bytes to ${String(value.path)}.`,
      }],
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const input = args as { path: string, content: string }
      const sandboxId = await requireSandboxId(deps, sessionOf(exec), exec.signal)
      try {
        const handle = await deps.client.handle(sandboxId)
        await handle.files.write(input.path, input.content)
        return { path: input.path, bytes: Buffer.byteLength(input.content, 'utf8') }
      } catch (error) {
        throw new SandboxToolError(describeBoundError(error, 'aishell__sandbox_files_write'))
      }
    },
  })
}

function readFileTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_files_read',
    description:
      'Read a file from this conversation\'s sandbox and return its contents. Text is '
      + 'returned as text; ask for base64 to inspect a binary file.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path inside the sandbox.' },
      format: {
        type: 'string',
        enum: ['text', 'base64'],
        description: 'How to return the bytes. Default text.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          format: { type: 'string', required: true },
          content: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.truncated
          ? `${value.path} (first ${String(value.bytes)} bytes, truncated):\n${value.content}`
          : `${value.path}:\n${value.content}`,
      }],
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const input = args as { path: string, format?: string }
      const sandboxId = await requireSandboxId(deps, sessionOf(exec), exec.signal)
      try {
        const handle = await deps.client.handle(sandboxId)
        if (input.format === 'base64') {
          const bytes = await handle.files.read(input.path, { format: 'bytes' })
          const clipped = bytes.byteLength > OUTPUT_LIMIT ? bytes.subarray(0, OUTPUT_LIMIT) : bytes
          return {
            path: input.path,
            format: 'base64',
            content: Buffer.from(clipped).toString('base64'),
            bytes: clipped.byteLength,
            truncated: clipped.byteLength !== bytes.byteLength,
          }
        }
        const text = await handle.files.read(input.path, { format: 'text' })
        const clipped = clip(text)
        return {
          path: input.path,
          format: 'text',
          content: clipped.text,
          bytes: Buffer.byteLength(clipped.text, 'utf8'),
          truncated: clipped.truncated,
        }
      } catch (error) {
        throw new SandboxToolError(describeBoundError(error, 'aishell__sandbox_files_read'))
      }
    },
  })
}

function downloadFileTool(deps: ToolDeps, ctx: Context): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_files_download',
    description:
      'Copy a file out of this conversation\'s sandbox into the local workspace. Text is '
      + 'written as text. A binary file cannot be written to the local workspace — the '
      + 'harness filesystem accepts text only — so for one of those this returns base64 '
      + 'instead and reports that it had to; read those with aishell__sandbox_files_read and '
      + 'format base64 if that is what you wanted.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path inside the sandbox.' },
      localPath: {
        type: 'string',
        required: true,
        description:
          "Destination in the local workspace. A relative path resolves against the session's "
          + 'working directory, and missing parent directories are created. Ignored for a '
          + 'binary file, which cannot be written there.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          localPath: { type: 'string' },
          bytes: { type: 'integer', required: true },
          encoding: { type: 'string', required: true },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.encoding === 'text'
          ? `Copied ${value.path} (${String(value.bytes)} bytes) to ${String(value.localPath)}.`
          : `${value.path} is binary (${String(value.bytes)} bytes) and cannot be written to `
            + `the local workspace. Its contents are base64 above.`,
      }],
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const input = args as { path: string, localPath: string }
      const sandboxId = await requireSandboxId(deps, sessionOf(exec), exec.signal)
      try {
        const handle = await deps.client.handle(sandboxId)

        // Read as bytes, then decide. Reading as text first would throw on a
        // binary file rather than letting the tool report what it found.
        const bytes = await handle.files.read(input.path, { format: 'bytes' })
        if (isProbablyBinary(bytes)) {
          const clipped = bytes.byteLength > OUTPUT_LIMIT ? bytes.subarray(0, OUTPUT_LIMIT) : bytes
          return {
            path: input.path,
            bytes: bytes.byteLength,
            encoding: 'base64',
            content: Buffer.from(clipped).toString('base64'),
          }
        }

        const fs = deps.resolveFs() ?? ctx.get('fs')
        if (fs === undefined) {
          // No destination exists, so the bytes are returned instead of lost —
          // the same answer the binary case gives, for a different reason.
          return {
            path: input.path,
            bytes: bytes.byteLength,
            encoding: 'base64',
            content: Buffer.from(bytes).toString('base64'),
          }
        }

        const text = Buffer.from(bytes).toString('utf8')
        const target = await fs.resolve(input.localPath, await sessionResolveOptions(deps, exec))
        // Missing parents are created: `writeText` publishes through an atomic
        // write that makes its destination directory first, so a nested
        // `localPath` does not need its parent to exist. That is what makes the
        // parameter a destination rather than a place the caller prepares.
        await fs.writeText(target, text, undefined, exec.signal)
        return {
          path: input.path,
          localPath: fs.processPath(target),
          bytes: bytes.byteLength,
          encoding: 'text',
        }
      } catch (error) {
        throw new SandboxToolError(describeBoundError(error, 'aishell__sandbox_files_download'))
      }
    },
  })
}

/**
 * Whether bytes look like something the local workspace cannot hold.
 *
 * The harness filesystem writes UTF-8 text, so the question is only whether
 * these bytes survive a round trip through it. A NUL byte settles it: no text
 * file contains one, and every common binary format does. A UTF-8 decode
 * failure settles it the other way. Everything else is treated as text, which
 * is the permissive direction — a misread text file is recoverable, a binary
 * file mangled by decoding is not.
 *
 * @param bytes - the file's contents.
 * @returns whether the bytes should be returned encoded instead of written.
 */
function isProbablyBinary(bytes: Uint8Array): boolean {
  // A UTF-8 BOM marks a text file that would otherwise carry no signal.
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return false
  if (bytes.includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return false
  } catch {
    return true
  }
}

function listFilesTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_files_list',
    description: 'List the entries in a directory of this conversation\'s sandbox.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute directory path.' },
      depth: {
        type: 'number',
        description: 'How many levels below the directory to include. Default 1.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true },
                type: { type: 'string', required: true },
                size: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const entries = value.entries
        if (entries.length === 0) {
          return [{ type: 'text', text: `${value.path} is empty.` }]
        }
        const lines = entries.map(entry => (
          `${entry.type === 'dir' ? 'd' : '-'} ${entry.name}`
          + `${entry.size === undefined ? '' : `  ${String(entry.size)} bytes`}`
        ))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const input = args as { path: string, depth?: number }
      const sandboxId = await requireSandboxId(deps, sessionOf(exec), exec.signal)
      try {
        const handle = await deps.client.handle(sandboxId)
        // Built conditionally rather than spread: `exactOptionalPropertyTypes`
        // makes `{ depth: undefined }` a different type from `{}`.
        const options = input.depth === undefined ? undefined : { depth: input.depth }
        const entries = await handle.files.list(input.path, options)
        return {
          path: input.path,
          entries: entries.map(entry => ({
            name: entry.name,
            path: entry.path,
            // The SDK types this as an enum the listing may omit; the tool's
            // own schema says `string`, so the absent case is spelled out
            // rather than left as `undefined`.
            type: entry.type === undefined ? 'unknown' : String(entry.type),
            ...(entry.type === 'file' ? { size: entry.size } : {}),
          })),
        }
      } catch (error) {
        throw new SandboxToolError(describeBoundError(error, 'aishell__sandbox_files_list'))
      }
    },
  })
}

function getPortUrlTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'aishell__sandbox_get_port_url',
    description:
      'Get the public URL for a port a process is listening on inside this conversation\'s '
      + 'sandbox — the address to open a server running there. The URL resolves to the '
      + 'sandbox and stops working when the sandbox is deleted or expires.',
    parameters: {
      port: {
        type: 'integer',
        required: true,
        description: 'Port the process listens on inside the sandbox, e.g. 3000.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          sandboxId: { type: 'string', required: true },
          port: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Port ${String(value.port)} is reachable at ${value.url}.`,
      }],
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const input = args as { port: number }
      const sandboxId = await requireSandboxId(deps, sessionOf(exec), exec.signal)
      try {
        const handle = await deps.client.handle(sandboxId)
        // `getHost` returns a bare hostname with no scheme; the gateway serves
        // TLS, so the scheme is https.
        return {
          url: `https://${handle.getHost(input.port)}`,
          sandboxId,
          port: input.port,
        }
      } catch (error) {
        throw new SandboxToolError(describeBoundError(error, 'aishell__sandbox_get_port_url'))
      }
    },
  })
}