/**
 * The seam between the tool handlers and DSH's tool registry.
 *
 * ## What this module is
 *
 * The tool modules in `tools/` register themselves through `registerTool(name,
 * declaration, handler)` and return `{ content, isError? }`. This module plays
 * that registrar's role — collecting the declarations — and converts each one
 * into a DSH `ToolDefinition`.
 *
 * ## Why the handler contract is kept as it is
 *
 * Their result shape is a good internal contract: success and failure are
 * explicit, and every diagnostic is somewhere the model reads. Flattening 5000
 * lines of handlers into canonical values would be a mechanical diff across
 * every file, and a mechanical diff is where a misplaced return hides until a
 * tool runs. So the handlers speak their own vocabulary, and this module is the
 * only place that knows both.
 *
 * ## What this module adds to reach DSH
 *
 *   - **A canonical output value.** DSH tools return a lossless-JSON value and
 *     render it. That value is the result itself, so `structuredContent`
 *     survives for programmatic callers and `render` alone decides what the
 *     model reads.
 *   - **A failure that is really a failure.** `isError` becomes a rejection:
 *     DSH records rejection as a failed call, and an error payload returned as
 *     a value reads to the model as success.
 *   - **JSON Schema, not a zod object.** `parameters` is a JSON Schema, and the
 *     tools declare zod. The conversion happens once, at registration.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/bridge
 */

import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock as DshContentBlock } from '@deepseek-ai/dsh-llm'

import type {
  CallToolResult,
  ContentBlock,
  ToolContext,
  ToolRegistrar,
  ToolRegistrationConfig,
} from './types.ts'

/** One captured registration. */
interface CapturedTool {
  readonly name: string
  readonly config: ToolRegistrationConfig
  readonly handler: (args: unknown, ctx: ToolContext) => Promise<CallToolResult>
}

/**
 * Collect the tools the `register*()` functions register.
 *
 * @returns the registrar the tool modules write into, and the list it fills.
 */
export function createRegistrar(): {
  readonly registrar: ToolRegistrar
  readonly captured: CapturedTool[]
} {
  const captured: CapturedTool[] = []
  const registrar: ToolRegistrar = {
    registerTool(
      name: string,
      config: ToolRegistrationConfig,
      handler: (args: never, ctx: ToolContext) => Promise<CallToolResult>,
    ): void {
      captured.push({ name, config, handler: handler as CapturedTool['handler'] })
    },
  }
  return { registrar, captured }
}

/**
 * The model-facing name for one tool.
 *
 * Registered as `aishell__<name>`. The prefix exists because this plugin is not
 * the only source of cloud tools in a deployment, and a bare `terraform_apply`
 * in a shared namespace is one collision away from calling someone else's tool.
 *
 * @param rawName - the tool's own name.
 */
export function publicToolName(rawName: string): string {
  return `aishell__${rawName}`
}

/**
 * Convert one registration into a DSH tool definition.
 *
 * @param tool - the captured registration.
 * @param timeoutMs - per-call budget handed to the harness.
 * @param workingDirectory - the host's session-directory service, when mounted.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function toToolDefinition(
  tool: CapturedTool,
  timeoutMs: number,
  workingDirectory?: SessionDirectories,
): ToolDefinition {
  const name = publicToolName(tool.name)
  const description = tool.config.description ?? ''
  const parameters = toJsonSchema(tool.config.inputSchema, tool.name)
  const validate = argumentValidator(tool.config.inputSchema)

  return {
    name,
    description,
    parameters,
    output: {
      // The canonical value is the structured one: a handler that produced a
      // JSON value returns it as `structuredContent`, and that object is what
      // DSH renders and what a programmatic caller reads. The text form stays
      // in the result for readers that only consume text.
      //
      // A handler that produced plain text (a diagnostic, a short status) has
      // no structured form, and its output is `{ content }` — hence the schema
      // admitting either shape rather than claiming an object that may not be
      // there.
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array' },
          structuredContent: { type: 'object' },
          isError: { type: 'boolean' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      render: (_args, value) => renderResult(value as unknown as CallToolResult),
    },
    timeoutMs,
    async execute(args, exec) {
      // Validated here rather than assumed of the handler. DSH's `register()`
      // checks the definition's shape and validates the OUTPUT schema, but it
      // does not validate a raw registration's arguments — only `defineTool()`
      // wrappers do. Without this check a call missing `deployment` reaches the
      // handler as `undefined` and fails deep inside Node (`path.join` of
      // undefined), which names neither the tool nor the argument.
      const violations = validate(args)
      if (violations.length > 0) {
        throw new Error(`aishell-deploy: ${name}: ${violations.join('; ')}`)
      }
      const result = await tool.handler(args, await contextFor(exec, workingDirectory))
      return unwrapOrThrow(result)
    },
  }
}

/**
 * A function that checks one call's arguments against the declared schema.
 *
 * The zod schema is the declaration, so it is also the check: `safeParse` runs
 * the same rules the JSON Schema was generated from, including the refinements
 * JSON Schema cannot express. The result is a list of readable violations,
 * empty when the arguments are acceptable.
 *
 * @param schema - the tool's declared input schema.
 * @returns the validator.
 */
function argumentValidator(schema: unknown): (args: unknown) => string[] {
  if (!isZodType(schema)) return () => []
  return (args) => {
    const parsed = schema.safeParse(args)
    if (parsed.success) return []
    return parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
  }
}

/**
 * The working-directory service, as this plugin needs it.
 *
 * Structural rather than imported, for the reason `aishell-e2b` states: importing
 * the framework package for one method would add a dependency whose own
 * `schemastery` pin differs from this package's, and the duplicate copy leaks
 * into the emitted `.d.ts` through a `.pnpm/…` path nobody installing this
 * package has. One method is all that is used, so one method is all that is
 * declared.
 */
interface SessionDirectories {
  /** The session's effective absolute directory, validated and restored. */
  readonly ensure: (agent: object, signal?: AbortSignal) => Promise<string>
}

/**
 * The handler context for one execution.
 *
 * ## Why this resolves a directory
 *
 * The tools take a `deployment` path that the model may give relatively, and a
 * relative path means nothing until something anchors it. Node would anchor it
 * at `process.cwd()` — the directory the host was launched from, which has
 * nothing to do with the session a person is working in. Every filesystem tool
 * in the product anchors at the session, so a relative path means the same
 * thing here as it does there.
 *
 * `ensure` rather than `get`: it returns an absolute directory and validates
 * that it still exists. `get` is cheaper but is a pure read, so a deleted
 * directory would be handed back and every operation under it would fail with
 * the wrong reason.
 *
 * The service may be absent — a deployment without it, or a call outside an
 * agent. That is not permission to fall back to `process.cwd()`: the context
 * then carries no directory, and a tool that needs one to resolve a relative
 * path says so rather than writing somewhere nobody chose.
 *
 * @param exec - the harness execution context.
 * @param workingDirectory - the host's service, when mounted.
 * @returns the handler context.
 */
async function contextFor(
  exec: unknown,
  workingDirectory: SessionDirectories | undefined,
): Promise<ToolContext> {
  const call = exec as { agent?: object, signal?: AbortSignal } | undefined
  const agent = call?.agent
  if (workingDirectory === undefined || agent === undefined) return {}
  try {
    return { sessionDirectory: await workingDirectory.ensure(agent, call?.signal) }
  } catch {
    // A directory the host could not resolve is the same situation as a host
    // that offers none: the tools report it when they need it, and a tool that
    // does not need it still runs.
    return {}
  }
}

/**
 * Turn a handler's return into the canonical value, or throw on failure.
 *
 * @param result - what the handler returned.
 * @returns the canonical value (the result itself).
 * @throws when the handler reported an error, with the diagnostic as the message.
 */
function unwrapOrThrow(result: CallToolResult): CallToolResult {
  if (result.isError === true) throw new Error(textOf(result.content))
  return result
}

/**
 * Project a canonical value into the blocks the model reads.
 *
 * ## One value, one serialization
 *
 * A handler that produced a JSON value carries it as `structuredContent`, and
 * this is the place it becomes text. The handler does not also serialize it:
 * the same bytes in `content[]` would never be read, since this branch decides
 * what the model sees, and the harness snapshots the returned result — so a
 * second copy costs memory and shows nobody anything.
 *
 * A handler with no structured value produced text directly — a diagnostic, a
 * short status — and that text is the answer.
 *
 * ## Why a non-text block is reported rather than dropped
 *
 * DSH's content vocabulary is text/reasoning/image-with-attachment; these
 * handlers only ever produce text. Dropping an unexpected block would render a
 * successful call as empty, which reads like a broken tool — so anything that is
 * not text is reported instead of silently discarded.
 *
 * @param value - the tool result.
 * @returns its content blocks.
 */
function renderResult(value: CallToolResult): DshContentBlock[] {
  if (value.structuredContent !== undefined) {
    return [{ type: 'text', text: JSON.stringify(value.structuredContent) }]
  }
  const blocks: DshContentBlock[] = []
  for (const block of value.content) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
    else {
      blocks.push({
        type: 'text',
        text: '[content unavailable: this tool produced a block type this deployment cannot '
          + 'render]',
      })
    }
  }
  return blocks.length === 0 ? [{ type: 'text', text: '(no output)' }] : blocks
}

/** Concatenate a result's text blocks, for use as an error message. */
function textOf(content: readonly ContentBlock[]): string {
  const text = content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  return text === '' ? 'the tool reported an error without a message' : text
}

/**
 * Convert a tool's declared `inputSchema` into JSON Schema.
 *
 * The tools declare zod objects. `z.toJSONSchema` is exact for every shape they
 * use (objects, arrays, enums, optional fields, `describe`) and drops only the
 * runtime refinements — `superRefine` cannot be expressed in JSON Schema at
 * all. That is not a gap: {@link argumentValidator} runs the zod schema itself
 * before the handler, so the refinements still apply where they matter.
 *
 * @param schema - whatever the tool declared.
 * @param toolName - for the failure message.
 * @returns a JSON Schema object DSH can hand the model.
 */
function toJsonSchema(schema: unknown, toolName: string): Record<string, unknown> {
  if (!isZodType(schema)) {
    throw new Error(
      `aishell-deploy: tool "${toolName}" declared an input schema that is not a zod type`,
    )
  }
  const json = z.toJSONSchema(schema, {
    // `io: 'input'` describes what the caller may send, which is what a tool's
    // parameters are. Without it, defaults and transforms leak the output shape.
    io: 'input',
    // DSH does not dereference external `$ref`s; inline everything.
    reused: 'inline',
  }) as Record<string, unknown>
  // `$schema` is metadata for validators; the registry does not want it.
  delete json.$schema
  return json
}

/**
 * Whether a value is a zod type.
 *
 * Structural rather than `instanceof`: there is exactly one zod copy in this
 * package's tree, but a structural check keeps this module independent of that
 * fact — and `instanceof` across two copies fails in the least legible way. The
 * `_zod` brand is what zod 4 puts on every schema.
 */
function isZodType(value: unknown): value is z.ZodType {
  return typeof value === 'object'
    && value !== null
    && '_zod' in value
    && (value as { _zod?: { def?: unknown } })._zod?.def !== undefined
}