/**
 * The contract between the tool handlers and the harness adapter.
 *
 * ## What this file is
 *
 * Every tool in `tools/` returns a text result — `{ content, isError? }` — and
 * takes one context object. That is the shape they are written against, and it
 * is a good one: success and failure are explicit, and every diagnostic is
 * somewhere the model reads.
 *
 * Flattening all of them into DSH's canonical-value form would be a mechanical
 * edit across every file, and a mechanical edit is where a misplaced return
 * hides until a tool runs. So the shape stays, and `bridge.ts` is the single
 * place that translates it.
 *
 * ## Why everything is declared here
 *
 * These are local types, not imports from any protocol package: this plugin has
 * no transport. `ToolRegistrar` is the one seam the tool modules depend on, and
 * it is exactly what `bridge.ts` implements — a name, a declaration, a handler.
 *
 * The declarations are deliberately the *subset* the handlers use. Anything a
 * handler needs that is not here fails to compile, which is what makes this
 * boundary trustworthy rather than merely convenient.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/types
 */

/** One text block of a tool result. */
export interface TextContent {
  readonly type: 'text'
  readonly text: string
}

/** Any content block a handler may produce. */
export type ContentBlock = TextContent

/** A completed tool call, success or failure. */
export interface CallToolResult {
  readonly content: ContentBlock[]
  /** Absent means success; `true` means the text is a diagnostic. */
  readonly isError?: boolean
  readonly structuredContent?: Record<string, unknown>
}

/**
 * Per-call context handed to a handler.
 *
 * ## Why the session directory is here
 *
 * Every tool in this plugin takes a `deployment` path, and a caller may give it
 * relatively — the model writes "huawei-topology" because that is the directory
 * it just made. A relative path has to resolve against *something*, and the
 * default Node and the harness differ on what:
 *
 *   - Node resolves it against `process.cwd()`, the directory the host was
 *     launched from. That has nothing to do with the working directory the
 *     person picked for this session.
 *   - Every filesystem tool in the product resolves it against the session's
 *     working directory, which is what a person means by "here".
 *
 * Two tools disagreeing about what "huawei-topology" names is exactly the
 * failure that produces a workspace nobody can find, so this plugin anchors at
 * the session like everything else does.
 *
 * The field is optional because the service may not be mounted. Its absence is
 * not permission to fall back to `process.cwd()`: a relative path then has no
 * correct meaning, and the tool says so. `undefined` is a fact to report, not a
 * default to invent.
 */
export interface ToolContext {
  /**
   * The session's absolute working directory, when the host provides one.
   *
   * Absolute and already validated by the host — it restores the original
   * directory when the one the person picked has been removed.
   */
  readonly sessionDirectory?: string
}

/** The context type the tool modules name. */
export type ToolCtx = ToolContext

/**
 * What a tool declares when it registers.
 *
 * `annotations` is carried for the tools' own documentation; the harness has no
 * equivalent field, so `bridge.ts` does not forward it.
 */
export interface ToolRegistrationConfig {
  readonly title?: string
  readonly description?: string
  readonly annotations?: ToolAnnotations
  readonly inputSchema: unknown
}

/** Risk hints a tool may declare about itself. */
export interface ToolAnnotations {
  readonly title?: string
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

/**
 * The registration surface the tool modules use.
 *
 * Implemented by `bridge.ts`. The handler's argument is `any` rather than
 * `unknown` because each registrar passes a handler typed to its own
 * zod-inferred shape; a stricter signature would force a cast at all 18
 * registration sites.
 */
export interface ToolRegistrar {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool(
    name: string,
    config: ToolRegistrationConfig,
    handler: (args: any, ctx: ToolContext) => Promise<CallToolResult>,
  ): unknown
}