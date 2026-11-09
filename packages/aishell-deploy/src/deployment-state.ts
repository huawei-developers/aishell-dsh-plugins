/**
 * Deployment workspace state: the `.deployment.json` snapshot.
 *
 * A deployment directory is identified by the presence of
 * .deployment.json. The file holds a status snapshot — not an operation
 * log. The tools update it on each state change (validate_design /
 * price_resources / terraform_plan / terraform_apply / terraform_destroy). The model never writes
 * this file directly.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SERVER_VERSION } from "./version.js";
import type { DesignCheck } from "./gates/design_gate.js";
import type { DestroyRecord, PlanRecord } from "./gates/plan_gate.js";

export const DEPLOYMENT_STATE_FILE = ".deployment.json";

export interface DeploymentSnapshot {
  created_at: string;
  created_with: string;
  server_version: string;
  account?: { name: string; account_id: string };
  status: {
    /**
     * The last `validate_design` run: what it checked, and whether it passed.
     *
     * A digest rather than a boolean, because the question the apply gate asks
     * is "was THIS configuration checked" — and a design edited after it was
     * checked is not a checked one. Absent until the first run.
     */
    design_check?: DesignCheck;
    /**
     * The last `terraform_plan`: the digest of the configuration it planned,
     * and what it found. `terraform_apply` runs THAT plan file and refuses when
     * this digest no longer matches — terraform itself will apply a saved plan
     * whose configuration has changed, so the record is what ties the two.
     */
    plan_check?: PlanRecord;
    /**
     * The last `terraform_plan({ destroy: true })`: the targets it previewed and
     * the configuration it computed them from. `terraform_destroy` applies that
     * saved plan and refuses when this record does not name the same targets.
     */
    destroy_check?: DestroyRecord;
    cost_written: boolean;
    applied: boolean;
    destroyed: boolean;
    last_operation: string;
    last_operation_at: string;
  };
}

/** Check whether a directory is a deployment (has .deployment.json). */
export async function isDeploymentDir(dir: string): Promise<boolean> {
  try {
    await readFile(join(dir, DEPLOYMENT_STATE_FILE), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the deployment snapshot, when the directory has one.
 *
 * `undefined` rather than a throw: a directory that is not a deployment
 * workspace is a normal thing to point at (the user named one directly, or
 * `create_deployment` was skipped), and the tools that write into the
 * workspace work there too. Each caller decides whether a missing snapshot is
 * interesting — the design gate treats it as "never checked", `updateSnapshot`
 * as "nothing to update".
 *
 * @param dir - the directory that may hold a deployment.
 * @returns the snapshot, or `undefined`.
 */
export async function readSnapshot(dir: string): Promise<DeploymentSnapshot | undefined> {
  try {
    const raw = await readFile(join(dir, DEPLOYMENT_STATE_FILE), "utf8");
    return JSON.parse(raw) as DeploymentSnapshot;
  } catch {
    return undefined;
  }
}

/** Create a deployment directory + initial .deployment.json. Refuse if non-empty. */
export async function ensureDeployment(dir: string): Promise<DeploymentSnapshot> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    // Doesn't exist — create it.
  }
  if (entries.length > 0) {
    // A directory that already holds a deployment is not "non-empty, refuse":
    // it is a deployment, and the answer is its snapshot. Saying otherwise
    // would make the guard fire on the one case it is not guarding against —
    // re-running create_deployment on a workspace already in use — while
    // claiming the directory is something else.
    if (entries.includes(DEPLOYMENT_STATE_FILE)) {
      const existing = await readSnapshot(dir)
      if (existing !== undefined) return existing
      throw new Error(
        `${DEPLOYMENT_STATE_FILE} is present but unreadable, so this deployment's state ` +
        'cannot be loaded. Check the file, or delete the directory and create it again.',
      )
    }
    throw new Error(
      'directory is not empty and not a deployment — it holds files that are not this '
      + 'plugin\'s. Point create_deployment at an empty or non-existent directory.',
    )
  }
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const snapshot: DeploymentSnapshot = {
    created_at: now,
    created_with: "aishell-deploy",
    server_version: SERVER_VERSION,
    status: {
      cost_written: false,
      applied: false,
      destroyed: false,
      last_operation: "create_deployment",
      last_operation_at: now,
    },
  };
  await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

/** Update the status snapshot (called by other modules after state changes). */
export async function updateSnapshot(
  dir: string,
  patch: Partial<DeploymentSnapshot["status"]> & { last_operation: string },
): Promise<void> {
  const snap = (await readSnapshot(dir)) ?? emptySnapshot();
  snap.status = { ...snap.status, ...patch, last_operation_at: new Date().toISOString() };
  await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(snap, null, 2));
}

/**
 * A snapshot for a directory that is not a deployment workspace yet.
 *
 * `updateSnapshot` creates one rather than throwing when the file is absent: a
 * tool that records a fact the gates later rely on must be able to record it,
 * and a user who pointed at a directory instead of running `create_deployment`
 * should not silently lose the record. `ensureDeployment` remains the path that
 * REFUSES a non-empty directory, which is the check that protects user data;
 * this one only fills in state.
 *
 * @returns a snapshot with every status field unset.
 */
function emptySnapshot(): DeploymentSnapshot {
  const now = new Date().toISOString();
  return {
    created_at: now,
    created_with: "aishell-deploy",
    server_version: SERVER_VERSION,
    status: {
      cost_written: false,
      applied: false,
      destroyed: false,
      last_operation: "update_snapshot",
      last_operation_at: now,
    },
  };
}

/**
 * Backfill the account field in .deployment.json if it's empty and the
 * server is now authenticated, so a workspace created before the first
 * sign-in still ends up naming the account it belongs to.
 *
 * Called by runTerraform after resolveTerraformEnv succeeds. The account
 * identity was resolved at auth time (GET /v3/projects → domain_id + name)
 * and stored alongside the credentials; runTerraform reads it via
 * loadAccount() — no IAM re-query here. This is a stateless write: the
 * account is only backfilled once (idempotent — already-filled is a no-op).
 *
 * This is intentionally a no-op when:
 *   - the deployment has no .deployment.json (not a deployment dir)
 *   - account is already filled (idempotent)
 *   - loadAccount returns null (not authenticated, or payload predates
 *     IAM verification wiring)
 */
export async function backfillAccount(dir: string, account: { name: string; account_id: string }): Promise<void> {
  let snap: DeploymentSnapshot;
  try {
    const raw = await readFile(join(dir, DEPLOYMENT_STATE_FILE), "utf8");
    snap = JSON.parse(raw) as DeploymentSnapshot;
  } catch {
    return; // Not a deployment dir — silently skip.
  }
  if (snap.account) return; // Already filled — idempotent.
  snap.account = account;
  await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(snap, null, 2));
}

/**
 * Count the resources this deployment manages, by asking terraform.
 *
 * ## Why not read `terraform.tfstate`
 *
 * A deployment may configure a backend (`backend "obs"`, `backend "s3"`), in
 * which case terraform writes state to the bucket and leaves no
 * `terraform.tfstate` in the workspace. Reading that file as a proxy for "does
 * this deployment own anything" then answers 0 for a deployment that owns
 * everything — and both callers of this function act on the answer:
 * `terraform_destroy` refuses ("nothing to destroy"), and `delete_deployment`
 * proceeds to delete the workspace while the cloud resources stay up and
 * unmanaged.
 *
 * So the count is asked of the backend that is actually configured. The
 * subprocess is injected rather than imported: this module is the snapshot
 * store, and reaching into the terraform runner would make the import graph
 * cyclic — the runner already reads this module to backfill the account.
 *
 * @param dir - the deployment workspace directory.
 * @param listState - runs `terraform state list` and returns its stdout and
 *   exit code; injected so this module stays testable without a binary.
 * @returns how many resources the configured backend holds.
 */
export async function stateRecordedResourceCount(
  dir: string,
  listState: (dir: string, args: string[]) => Promise<{ exitCode: number, stdout: string }>,
): Promise<number> {
  const listed = await listState(dir, ["state", "list"]);
  if (listed.exitCode === 0) {
    return listed.stdout.split("\n").filter((line) => line.trim() !== "").length;
  }
  // Terraform could not answer — fall back to whatever the local file says, so
  // the answer is the best evidence available rather than a hard zero.
  return localStateResourceCount(dir);
}

/**
 * Resources recorded in a local `terraform.tfstate`.
 *
 * Only consulted when `terraform state list` cannot run. Counts top-level
 * entries, which is what a local state file holds: modules contribute one entry
 * per module, not one per resource.
 *
 * @param dir - the deployment workspace directory.
 * @returns the count, or 0 when there is no local state file.
 */
async function localStateResourceCount(dir: string): Promise<number> {
  try {
    const raw = await readFile(join(dir, "terraform.tfstate"), "utf8");
    const state = JSON.parse(raw) as { resources?: unknown[] };
    return state.resources?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Forget what was planned and previewed, after the run those records authorised.
 *
 * ## Why this is not housekeeping
 *
 * A saved plan is a one-shot artifact. terraform refuses to apply the same plan
 * file twice — "the given plan file can no longer be applied because the state
 * was changed by another operation after the plan was created" (verified) —
 * while every record this module keeps still matches, because a successful
 * apply does not change the `.tf`. So a second `terraform_apply` would pass all
 * the gates, run, and fail on terraform's own error, which names neither the
 * gate nor the remedy.
 *
 * Clearing the records moves that case onto the gate that has the remedy: with
 * no `plan_check`, `assertPlanApproved` says "call terraform_plan first", which
 * is exactly what the next deployment change needs anyway.
 *
 * The destroy record goes with it for the same reason: a teardown previewed
 * before an apply describes state that no longer exists.
 *
 * @param dir - the deployment workspace directory.
 */
export async function clearPlanRecords(dir: string): Promise<void> {
  const snap = await readSnapshot(dir)
  if (snap === undefined) return
  const status = { ...snap.status }
  delete status.plan_check
  delete status.destroy_check
  status.last_operation_at = new Date().toISOString()
  snap.status = status
  await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(snap, null, 2))
}

/** Remove the deployment directory. */
export async function removeDeploymentDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
