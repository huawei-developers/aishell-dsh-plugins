/**
 * Turning SDK failures into messages the model can act on.
 *
 * Two properties decide the shape here.
 *
 * **A non-zero exit is not an error.** The SDK's foreground `commands.run`
 * rejects with `CommandExitError` when a command exits non-zero, carrying the
 * exit code and both streams. Reporting that as a tool failure tells the model
 * "the tool broke" when the truth is "the command ran and returned 1" — which
 * for a build, a test run, or a `grep` with no match is the ordinary outcome.
 * Callers convert it to a normal result instead; see `tools.ts`.
 *
 * **The error hierarchy does not share a root.** `AuthenticationError`,
 * `BuildError` and `VolumeError` do not extend `SandboxError`, so matching on
 * `SandboxError` alone would let exactly the failures with remedies fall
 * through to a generic message. Matching is therefore by constructor name,
 * which is stable across the SDK's own re-bundling and needs no import of a
 * class the package may rename.
 *
 * @module @huaweidevtools/aishell-dsh-e2b/errors
 */

/** A failure whose text is already the message the model should see. */
export class SandboxToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxToolError'
  }
}

/** The remedy each SDK failure carries, keyed by its constructor name. */
const REMEDIES: Readonly<Record<string, string>> = {
  AuthenticationError:
    'the sandbox gateway rejected the API key. Re-authenticate with Huawei Cloud, '
    + 'then retry.',
  SandboxNotFoundError:
    'no such sandbox. It may have expired. Call aishell__sandbox_list to see the sandboxes '
    + 'this account currently has, or aishell__sandbox_create to make a new one.',
  FileNotFoundError:
    'no such file in the sandbox. Call aishell__sandbox_files_list to see what is there.',
  RateLimitError: 'the sandbox service is rate limiting; retry shortly.',
  NotEnoughSpaceError: 'the sandbox is out of disk space.',
  InvalidArgumentError: 'the sandbox service rejected an argument.',
  TemplateError:
    'the sandbox template does not support this operation. This usually means the '
    + 'sandbox\'s envd is older than the feature requires.',
  TimeoutError: 'the request timed out. A sandbox that has expired reports this too.',
  GitAuthError: 'git authentication failed inside the sandbox.',
  GitUpstreamError: 'the git remote rejected the operation inside the sandbox.',
  BuildError: 'a template build failed.',
  VolumeError: 'a volume operation failed.',
  SandboxError: 'the sandbox service reported an error.',
}

/**
 * Render one thrown value as the message a tool should fail with.
 *
 * @param error - whatever was thrown.
 * @param context - what the call was doing, prefixed for orientation.
 * @returns the message to surface.
 */
export function describeSandboxError(error: unknown, context: string): string {
  if (error instanceof SandboxToolError) return error.message

  const name = errorName(error)
  const remedy = REMEDIES[name]
  const detail = error instanceof Error ? error.message : String(error)
  // The SDK's own message is the specific part ("404: sandbox not found"), the
  // remedy is the general one. Keep both, specific first.
  const body = detail === '' ? '' : `: ${detail}`
  return remedy === undefined
    ? `aishell-e2b: ${context} failed${body}`
    : `aishell-e2b: ${context} failed — ${remedy}${body}`
}

/** The constructor name of a thrown value, or `''` for a non-object. */
export function errorName(error: unknown): string {
  if (error === null || typeof error !== 'object') return ''
  return error.constructor?.name ?? ''
}

/**
 * Whether a thrown value is a command that ran and exited non-zero.
 *
 * Kept separate from {@link describeSandboxError} because it is not a failure:
 * see the module comment.
 */
export function isCommandExitError(error: unknown): error is {
  exitCode: number
  stdout: string
  stderr: string
} {
  return errorName(error) === 'CommandExitError'
}