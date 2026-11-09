/**
 * The absolute directory a caller's directory argument names.
 *
 * ## The problem this exists for
 *
 * Every tool in this plugin takes a directory. A model supplies it, and a model
 * supplies what it just said: after `create_deployment({deployment:
 * "huawei-topology"})` the next call passes `"huawei-topology"` again, because
 * that is the name it has been using. A relative path is not wrong — it is how
 * people talk about directories.
 *
 * What is wrong is leaving its meaning to Node. A relative path passed to
 * `readFile` or `spawn` resolves against `process.cwd()`: the directory the
 * host was launched from. That has nothing to do with the working directory the
 * person chose for this session. Two tools then disagree — `write` saving to
 * the session directory and `terraform_init` reading from the launch directory
 * — and the symptom is a workspace nobody can find, which reads like a bug in
 * whichever tool reported it first.
 *
 * So the anchor is explicit: the session's working directory, which is what
 * every filesystem tool in the product uses and what a person means by "here".
 *
 * The rule is stated once here rather than per argument name, because it is a
 * fact about directories, not about `deployment` in particular: `dest` is the
 * same kind of value and had the same defect.
 *
 * ## Why there is no fallback
 *
 * When the host offers no session directory, a relative path has no correct
 * meaning. Falling back to `process.cwd()` would restore the exact
 * disagreement above, silently, for every call. The tools therefore ask for an
 * absolute path in that case and say why — a caller can comply, and nobody
 * writes somewhere unintended.
 *
 * An absolute path needs none of this: it already means one thing.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/paths
 */

import { isAbsolute, resolve } from 'node:path'

import type { ToolContext } from './types.ts'

/**
 * The absolute directory a directory argument names.
 *
 * @param given - the path the caller gave, relative or absolute.
 * @param context - the call's context, carrying the session directory when the
 *   host provides one.
 * @returns the absolute path.
 * @throws when the path is relative and there is no session directory to anchor
 *   it — the caller gets a remedy, not a directory chosen for them.
 */
export function anchorPath(
  given: string,
  context: ToolContext | undefined,
): string {
  if (isAbsolute(given)) return given
  const base = context?.sessionDirectory
  if (base === undefined) {
    throw new Error(
      `"${given}" is a relative path, and this call has no session working directory to `
      + 'resolve it against — so it names no directory in particular. Pass an absolute path '
      + 'instead. (Resolving it against the host process\'s own directory would put the '
      + 'workspace somewhere the session is not.)',
    )
  }
  return resolve(base, given)
}