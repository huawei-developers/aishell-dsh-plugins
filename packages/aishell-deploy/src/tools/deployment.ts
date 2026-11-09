import type { CallToolResult, ToolRegistrar } from "../types.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";

import { LOCAL_DESTRUCTIVE, LOCAL_WRITE } from "./annotations.js";
import { fail, guard, okJson } from "./errors.js";
import { deploymentParam } from "./index.js";
import {
  DEPLOYMENT_STATE_FILE,
  ensureDeployment,
  isDeploymentDir,
  removeDeploymentDir,
  stateRecordedResourceCount,
  type DeploymentSnapshot,
} from "../deployment-state.js";
import { runTerraform } from "../terraform-run.js";

/**
 * create_deployment + delete_deployment.
 *
 * create: create or reuse a deployment workspace directory, writing
 * .deployment.json (state snapshot). If the dir exists and is a deployment,
 * return existing info + status. If it exists but is non-empty and not a
 * deployment, refuse.
 *
 * delete: refuse if the deployment still has live cloud resources (checks
 * the configured terraform backend); if clean, remove the directory.
 */
export function registerDeploymentTools(registrar: ToolRegistrar): void {
  registrar.registerTool(
    "create_deployment",
    {
      title: "Create deployment",
      description:
        "Create or reuse a deployment workspace directory. The only file it writes is " +
        ".deployment.json, the state snapshot the gates later read — no .tf, no plan. If " +
        "the directory already holds a deployment, it returns that snapshot instead of " +
        "touching it. If the directory is non-empty and is not a deployment, it refuses " +
        "rather than writing into someone else's files.",
      annotations: LOCAL_WRITE,
      inputSchema: z.object({ deployment: deploymentParam }),
    },
    guard(async (args) => handleCreate(args.deployment)),
  );

  registrar.registerTool(
    "delete_deployment",
    {
      title: "Delete deployment",
      description:
        "Delete a deployment workspace directory. Refuses if the deployment still " +
        "manages cloud resources — asks the configured terraform backend; if there are none, " +
        "removes the directory. Deleting the workspace does not delete the resources.",
      annotations: LOCAL_DESTRUCTIVE,
      inputSchema: z.object({ deployment: deploymentParam }),
    },
    guard(async (args) => handleDelete(args.deployment)),
  );
}

async function handleCreate(dir: string): Promise<CallToolResult> {
  if (await isDeploymentDir(dir)) {
    // Existing deployment — return current status snapshot.
    const statePath = `${dir}/${DEPLOYMENT_STATE_FILE}`;
    try {
      const raw = await readFile(statePath, "utf8");
      const snapshot = JSON.parse(raw) as DeploymentSnapshot;
      return okJson({ deployment: dir, status: "existing", snapshot });
    } catch {
      return fail(`failed to read ${statePath}`);
    }
  }
  try {
    const snapshot = await ensureDeployment(dir);
    return okJson({ deployment: dir, status: "created", snapshot });
  } catch (err) {
    // `ensureDeployment` states the condition and the remedy; re-wordsmithing
    // it here would be a second copy that drifts from the guard it describes.
    return fail(`create_deployment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleDelete(dir: string): Promise<CallToolResult> {
  if (!(await isDeploymentDir(dir))) {
    return fail("not a deployment directory (no .deployment.json)");
  }
  const recordedCount = await stateRecordedResourceCount(dir, runTerraform);
  if (recordedCount > 0) {
    return fail(
      `deployment has ${recordedCount} resources recorded in tfstate — run terraform_destroy first`,
    );
  }
  try {
    await removeDeploymentDir(dir);
    return okJson({ deployment: dir, status: "deleted" });
  } catch (err) {
    return fail(`delete_deployment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
