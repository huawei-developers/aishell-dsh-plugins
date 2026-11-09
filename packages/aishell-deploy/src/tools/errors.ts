import type { CallToolResult, ToolContext } from "../types.js";

import { denyTool } from "../permission/gate.js";
import { anchorPath } from "../paths.ts";

/**
 * Tool handler context — the harness adapter's, re-exported here because every
 * tool module already imports it from this file.
 *
 * Empty today; see `../types.ts` for why it is kept.
 */
export type ToolCtx = ToolContext;

/** What a tool handler may return. */
export type ToolResult = CallToolResult;

/**
 * A successful tool result carrying a JSON value.
 *
 * ## Where the text goes
 *
 * Only `structuredContent` is set here. The model reads what `bridge.ts`
 * renders, and that renderer serializes this value — so writing the same JSON
 * into `content[0].text` as well would put one copy in the result that nothing
 * ever reads, and pay for it twice: once in the handler, once in the harness's
 * snapshot of the returned value.
 *
 * `content` is therefore empty on this path. It stays a required field because
 * `fail()` fills it — a diagnostic has no structure to carry and is read
 * straight from the text — and because the type is the harness's shape, not
 * this module's.
 *
 * The parameter is `object` rather than `Record<string, unknown>` so a typed
 * result — a contract interface, a summary — passes without a cast to an index
 * signature it does not have. Every such value is JSON-serializable, which is
 * the only property this needs.
 *
 * @param value - the tool's output, already structured.
 * @returns the result that carries it.
 */
export function okJson(value: object): CallToolResult {
  return {
    content: [],
    structuredContent: value as Record<string, unknown>,
  };
}

/**
 * A failed tool result: `isError: true` + text content.
 *
 * All tool failures return this shape. The model
 * checks `isError`, reads `content[0].text` for the diagnostic.
 */
export function fail(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Wrap an async tool handler so thrown errors become `fail()` results
 * instead of propagating as JSON-RPC internal errors.
 *
 * Tool handlers throw for unexpected failures (network, filesystem, bugs).
 * The message belongs in `content[0].text`, where the model reads and acts on
 * it — a thrown stack trace that never reaches the result tells the model
 * nothing it can use.
 *
 * The read-only gate runs first, before the handler body: a refused call must
 * not reach any part of its implementation, including argument validation that
 * might touch the filesystem. A tool declared in `CLOUD_MUTATING_TOOLS` is
 * refused here in read-only mode and never starts.
 */
export function guard<TArgs extends Record<string, unknown> | undefined>(
  fn: (args: TArgs, ctx: ToolCtx) => Promise<ToolResult>,
  toolName?: string,
): (args: TArgs, ctx: ToolCtx) => Promise<ToolResult> {
  return async (args, ctx) => {
    if (toolName !== undefined) {
      const refusal = denyTool(toolName);
      if (refusal !== undefined) return fail(refusal);
    }
    try {
      // Directory arguments are made absolute here rather than at each call
      // site. A handler that forgot would silently fall back to
      // `process.cwd()` — the disagreement `paths.ts` exists to prevent — and
      // it is the same answer for every handler, so one place cannot forget.
      return await fn(withAnchoredPaths(args, ctx), ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(msg);
    }
  };
}

/**
 * The directory-valued arguments every tool declares.
 *
 * Both are the same kind of value and were both relative-path bugs: `deployment`
 * is the workspace, `dest` is where reference data is exported. Handling only
 * `deployment` left `terraform_examples_export` resolving its target against the
 * host's launch directory, which is the same defect one tool over.
 */
const DIRECTORY_ARGUMENTS = ['deployment', 'dest'] as const;

/**
 * The arguments with every directory argument made absolute.
 *
 * A handler that takes neither passes through untouched, so this is not a
 * parameter every tool has to declare. A relative path with no session
 * directory throws here, inside the guard's `try`, which turns it into the
 * failure a caller can act on.
 *
 * @param args - the call's arguments.
 * @param ctx - the call's context.
 * @returns the same arguments, with directory arguments resolved.
 */
function withAnchoredPaths<TArgs>(args: TArgs, ctx: ToolCtx): TArgs {
  if (args === undefined || args === null || typeof args !== 'object') return args;
  const candidate = args as Record<string, unknown>;
  let resolved: Record<string, unknown> | undefined;
  for (const key of DIRECTORY_ARGUMENTS) {
    const value = candidate[key];
    if (typeof value !== 'string' || value === '') continue;
    resolved ??= { ...candidate };
    resolved[key] = anchorPath(value, ctx);
  }
  return (resolved ?? candidate) as TArgs;
}
