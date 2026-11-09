/**
 * Running the terraform binary: the one place a subprocess is spawned.
 *
 * ## Why this is its own module
 *
 * `terraform_plan`, `terraform_validate`, `terraform_show` and the tools that
 * only READ what terraform produced all need to run it. Hosting the runner
 * beside the tool registrations would make every such module import the tool
 * module — a dependency from a reader to a registrar, which is backwards and
 * makes the import graph look cyclic even when it is not.
 *
 * ## The read-only funnel
 *
 * Every invocation passes through {@link denyTerraformMutation}. The tool-level
 * gate names `terraform_apply` explicitly, which covers today's call sites;
 * deciding here means a future call site cannot introduce a mutation that the
 * read-only switch silently fails to see.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/terraform-run
 */

import { spawn } from 'node:child_process'

import { writesAllowed } from './permission/mode.ts'
import { resolveTerraformEnv } from './gates/terraform_env.ts'
import { loadAccount } from './credentials.ts'
import { backfillAccount } from './deployment-state.ts'

/**
 * Refuse a cloud-mutating `terraform apply` in read-only mode, at the funnel.
 *
 * The tool-level gate in `guard` names `terraform_apply` explicitly, which
 * covers today's call sites. This check covers tomorrow's: every terraform
 * invocation in this module goes through `runTerraform`, so deciding here
 * means a future call site cannot introduce a mutation that the read-only
 * switch silently fails to see.
 *
 * The subject is the `apply` subcommand specifically. `terraform_apply` runs
 * `apply -auto-approve`; `terraform_refresh` runs
 * `apply -refresh-only -auto-approve`, which reconciles local state against
 * the cloud and changes nothing in the account — the same "reads are fine"
 * rule the HTTP gate applies to GET. Testing for `-refresh-only` rather than
 * allowing a fixed set of argument vectors keeps that distinction exact: drop
 * the flag from the refresh path and this refuses it, which is precisely the
 * edit that would otherwise turn a read into a write unnoticed.
 *
 * @param args - argv passed to the terraform binary.
 * @returns a refusal message, or `undefined` to proceed.
 */
function denyTerraformMutation(args: readonly string[]): string | undefined {
  if (writesAllowed()) return undefined;
  const subcommand = args[0];
  if (subcommand !== "apply" && subcommand !== "destroy") return undefined;
  if (args.includes("-refresh-only")) return undefined;
  return (
    `Refused: \`terraform ${subcommand}\` changes HuaweiCloud resources, and this ` +
    `session is in read-only mode. Ask the user to switch the session to ` +
    `read-write mode. Read-only alternatives: terraform_plan, terraform_state, ` +
    `terraform_refresh.`
  );
}

/** Shared terraform runner: resolve env, then spawn. */
export interface TerraformResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if stdout was truncated at MAX_OUTPUT_BYTES (output incomplete). */
  stdoutTruncated?: boolean;
  /** True if stderr was truncated at MAX_OUTPUT_BYTES. */
  stderrTruncated?: boolean;
}

/** Max stdout/stderr size per subprocess — 50MB. Prevents OOM on huge plans. */
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/** Default timeout for terraform commands (30 min — apply can be long). */
const TERRAFORM_TIMEOUT_MS = 30 * 60 * 1000;

export async function runTerraform(cwd: string, args: string[], extraEnv: string[] = []): Promise<TerraformResult> {
  // Funnel gate — see denyTerraformMutation. Thrown, then turned into a failed
  // tool result by the same `guard` wrapper that handles every other failure.
  const refusal = denyTerraformMutation(args);
  if (refusal !== undefined) throw new Error(refusal);

  const { binary, env } = await resolveTerraformEnv(cwd, extraEnv);
  if (env["HW_ACCESS_KEY"]) {
    // Best effort: this records which account a deployment belongs to for
    // later display. `loadAccount` throws when IAM cannot be reached, and a
    // reporting call failing must not fail the terraform run that is about to
    // happen — the run is the work, the backfill is bookkeeping.
    //
    // A rejected credential also passes through here without comment: the run
    // itself will fail with IAM's own reason, which is more useful than this
    // call site's.
    const account = await loadAccount().catch(() => undefined);
    if (account) {
      await backfillAccount(cwd, { name: account.account_name, account_id: account.account_id }).catch(() => {});
    }
  }
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    /** Why this process was killed by this module, when it was. */
    let killedBy = "";
    child.stdout.on("data", (d) => {
      if (!stdoutTruncated && stdout.length + d.length > MAX_OUTPUT_BYTES) {
        stdout += d.toString().slice(0, MAX_OUTPUT_BYTES - stdout.length);
        stdoutTruncated = true;
        killedBy = `output reached ${MAX_OUTPUT_BYTES} bytes`;
        child.kill("SIGTERM");
      } else if (!stdoutTruncated) {
        stdout += d.toString();
      }
    });
    child.stderr.on("data", (d) => {
      if (!stderrTruncated && stderr.length + d.length > MAX_OUTPUT_BYTES) {
        stderr += d.toString().slice(0, MAX_OUTPUT_BYTES - stderr.length);
        stderrTruncated = true;
      } else if (!stderrTruncated) {
        stderr += d.toString();
      }
    });
    // Timeout — kill if terraform hangs (network stall, interactive prompt).
    const timer = setTimeout(() => {
      killedBy = `the ${TERRAFORM_TIMEOUT_MS / 60_000} minute timeout elapsed`;
      child.kill("SIGTERM");
      // Give it 5s to clean up, then force kill.
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, TERRAFORM_TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // A process killed by a signal has no exit code — `code` is null. Mapping
      // that to 0 reports success: a `terraform apply` stopped by the timeout
      // would stamp the cost record and tell the user the deployment is up,
      // which is the one message that must never be wrong. So a death by signal
      // is a failure, and why it died is stated where the caller will show it.
      const killed = signal !== null;
      resolve({
        exitCode: code ?? (killed ? -1 : 0),
        stdout,
        stderr: killed && stderr === ""
          ? `terraform was terminated by ${signal}${killedBy === "" ? "" : `: ${killedBy}`}`
          : stderr,
        stdoutTruncated,
        stderrTruncated,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: err.message, stdoutTruncated, stderrTruncated });
    });
  });
}

