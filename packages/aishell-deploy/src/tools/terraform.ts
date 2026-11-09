import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallToolResult, ToolRegistrar } from "../types.js";
import { fail, guard, okJson } from "./errors.js";
import { CLOUD_DESTRUCTIVE, CLOUD_WRITE, READ_ONLY_CLOUD, READ_ONLY_LOCAL } from "./annotations.js";
import { deploymentParam } from "./index.js";
import { assertNoCredentials } from "../gates/credential_gate.js";
import { extractArchive } from "../utils/tar.js";
import { assertDesignChecked, computeTfHash } from "../gates/design_gate.js";
import { assertPlanApproved, assertDestroyPreviewed, DESTROY_PLAN_FILE, PLAN_FILE } from "../gates/plan_gate.js";

/** The destroy preview, kept apart from the apply plan so neither overwrites the other. */
import { summarizePlan } from "../plan.js";
import { readSnapshot } from "../deployment-state.js";
import { runCostGate } from "../gates/cost_gate.js";
import { resolveTerraformEnv, recordBinaryPath } from "../gates/terraform_env.js";
import { writeProviderMirrorConfig, HUAWEICLOUD_PROVIDER_MIRRORS } from "../gates/mirror.js";
import { extractSecurityGroups, type SecgroupRuleView } from "../security-groups.js";
import { updateSnapshot, stateRecordedResourceCount, clearPlanRecords } from "../deployment-state.js";
import { terraformBinDir } from "../data-paths.js";
import { runTerraform } from "../terraform-run.js";

/** Register all 9 terraform tools. */
export function registerTerraformTools(registrar: ToolRegistrar): void {
  registerInstall(registrar);
  registerInit(registrar);
  registerPlan(registrar);
  registerApply(registrar);
  registerDestroy(registrar);
  registerRefresh(registrar);
  registerState(registrar);
  registerImport(registrar);
}

const envParam = z.array(z.string()).optional().describe("Extra env vars for the terraform subprocess, each KEY=VALUE. e.g. [\"TF_LOG=DEBUG\", \"TF_LOG_PROVIDER=OFF\", \"TF_CLI_ARGS_plan=-refresh=false\"]");

function registerInstall(registrar: ToolRegistrar): void {
  registrar.registerTool(
    "terraform_install",
    {
      title: "Install terraform",
      description:
        "Ensure a terraform binary is available. Only installs the binary — provider " +
        "plugins are pulled by terraform_init. It looks, in order, at: the " +
        "`terraform_path` you pass, PATH, the path a previous install recorded, and " +
        "the host's own cache; failing all of those it downloads from " +
        "`binary_mirrors`. " +
        "It takes no deployment: the binary is a machine-level tool every deployment " +
        "shares, and installing it does not depend on any workspace.",
      annotations: CLOUD_WRITE,
      inputSchema: z.object({
        terraform_path: z.string().optional().describe("Explicit path to a terraform binary."),
        binary_mirrors: z.array(z.string()).optional().describe("Binary download mirror URLs, tried in order."),
        env: envParam,
      }),
    },
    guard(async (args) => handleInstall(args.terraform_path, args.binary_mirrors, args.env ?? [])),
  );
}

async function handleInstall(
  terraformPath?: string,
  binaryMirrors?: string[],
  extraEnv: string[] = [],
) {
  // 1. Explicit path.
  if (terraformPath) {
    const { stat } = await import("node:fs/promises");
    try {
      const info = await stat(terraformPath);
      if (!info.isFile()) return fail(`terraform_path is not a file: ${terraformPath}`);
    } catch {
      return fail(`terraform_path not found: ${terraformPath}`);
    }
    // Recorded so the next tool call uses this binary. Reported as `recorded`
    // because a lost record is a real difference from a successful one: the
    // next call would fall back to the search order instead.
    const recorded = await recordBinaryPath(terraformPath).then(() => true, () => false);
    return okJson({
      terraform: "(user-specified)",
      path: terraformPath,
      source: "parameter",
      cached: true,
      recorded,
      ...(recorded
        ? {}
        : { warning: "the path could not be recorded, so later tool calls will look for terraform on PATH and in the host's caches instead" }),
    });
  }

  // 2. PATH or global cache — try resolveTerraformEnv.
  try {
    const { binary } = await resolveTerraformEnv(undefined, extraEnv);
    const ver = await getTerraformVersion(binary);
    return okJson({ terraform: ver, path: binary, source: "path-or-cache", cached: true });
  } catch {
    // Not found — proceed to download.
  }

  // 3. Download — long operation, run as task.
  const mirrors = binaryMirrors ?? DEFAULT_BINARY_MIRRORS;
  const { version, arch, platform } = detectPlatform();
  const destDir = await resolveDownloadDir();
  const binPath = join(destDir, `terraform${version ? "-" + version : ""}`);

  return runOperation(
        async () => {
      const failures: Array<{ mirror: string; reason: string; kind: DownloadErrorKind }> = [];
      for (const mirror of mirrors) {
        try {
          await downloadAndExtract(mirror, version, platform, arch, destDir);
          const ver = await getTerraformVersion(binPath);
          return { exit_code: 0, outputs: { terraform: ver, path: binPath, source: "downloaded", cached: false } };
        } catch (err) {
          const kind = (err as DownloadError).kind ?? "network";
          failures.push({ mirror, reason: err instanceof Error ? err.message : String(err), kind });
        }
      }

      const detail = failures.map((f) => `  - ${f.mirror}: ${f.reason}`).join("\n");
      const kinds = new Set(failures.map((f) => f.kind));
      const actions: string[] = [];
      if (kinds.has("http_4xx")) {
        actions.push(
          `the mirror does not host terraform ${version} for ${platform}_${arch} (HTTP 4xx). ` +
          `Retrying won't help — re-invoke terraform_install with a different version, or pass ` +
          `binary_mirrors pointing at a mirror that has it.`,
        );
      }
      if (kinds.has("network")) {
        actions.push(
          `the mirror is unreachable (DNS/connection/TLS). A transient blip may clear on retry — ` +
          `re-invoke terraform_install once; if it fails again, obtain a terraform binary yourself ` +
          `(via shell: download + unzip, or a package manager) and re-invoke with terraform_path.`,
        );
      }
      if (kinds.has("http_5xx")) {
        actions.push(
          `the mirror returned a server error (HTTP 5xx) — temporarily broken. Retry terraform_install ` +
          `after a short wait, or pass a different binary_mirrors.`,
        );
      }
      if (kinds.has("extraction")) {
        actions.push(
          `the downloaded zip is corrupt or unreadable. Retry terraform_install once; if it fails again, ` +
          `the mirror may be serving a bad artifact — try a different binary_mirrors.`,
        );
      }
      actions.push(
        `If mirrors keep failing, obtain a terraform binary yourself (e.g. via shell: ` +
        `download from https://releases.hashicorp.com/terraform/<ver>/terraform_<ver>_<os>_<arch>.zip ` +
        `and unzip it, or use a package manager), then re-invoke terraform_install with ` +
        `terraform_path pointing at the executable.`,
      );
      return {
        exit_code: 1,
        outputs: {
          error: `terraform not found and download failed from all ${mirrors.length} mirror(s):\n${detail}\nNext actions:\n${actions.map((a) => `  - ${a}`).join("\n")}`,
        },
      };
    },
  );
}

function registerInit(registrar: ToolRegistrar): void {
  registrar.registerTool(
    "terraform_init",
    {
      title: "Terraform init",
      description:
        "Run `terraform init` to install the provider plugins. It writes " +
        "<deployment>/.terraformrc with the provider mirror configuration unless one is " +
        "already there or `provider_mirrors` is empty, points TF_PLUGIN_CACHE_DIR at the " +
        "shared provider cache when that directory is writable, and injects the stored " +
        "credentials into the subprocess environment so the provider can authenticate.",
      annotations: CLOUD_WRITE,
      inputSchema: z.object({
        deployment: deploymentParam,
        provider_mirrors: z.array(z.string()).optional().describe("Provider mirror URLs/paths."),
        env: envParam,
      }),
    },
    guard(async (args) => handleInit(args.deployment, args.provider_mirrors, args.env ?? [])),
  );
}

async function handleInit(deployment: string, providerMirrors?: string[], extraEnv: string[] = []) {
  try {
    await assertNoCredentials(deployment);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const mirrors = providerMirrors ?? HUAWEICLOUD_PROVIDER_MIRRORS;
  await writeProviderMirrorConfig(deployment, mirrors);

  return runOperation(
        async () => {
      const result = await runTerraform(deployment, ["init"], extraEnv);
      if (result.exitCode !== 0) {
        return { exit_code: result.exitCode, outputs: { stdout: result.stdout, stderr: result.stderr } };
      }
      return { exit_code: 0, outputs: { stdout: result.stdout, stderr: result.stderr } };
    },
  );
}

function registerPlan(registrar: ToolRegistrar): void {
  registrar.registerTool(
    "terraform_plan",
    {
      title: "Terraform plan",
      description:
        "Run `terraform plan` and save it to plan.tfplan. Returns the CHANGES, not the raw " +
        "plan document: one entry per resource with its action (create / update / replace / " +
        "destroy), the attribute names an update touches, and what forces a replacement. " +
        "Also returns the security-group rules the change would create, so they can be " +
        "reviewed without opening the plan. " +
        "terraform_apply runs this saved plan, and records the configuration it was computed " +
        "from — so any .tf edit after planning requires another call to this tool. " +
        "With destroy: true it previews the DESTRUCTION instead: the same change list, every " +
        "entry delete, written to a separate file so the apply plan is untouched. The " +
        "`target` list given here is baked into the saved teardown — terraform_destroy " +
        "applies THIS saved plan and refuses a target list that differs from it.",
      annotations: READ_ONLY_CLOUD,
      inputSchema: z.object({
        deployment: deploymentParam,
        destroy: z.boolean().optional().describe(
          'Preview what terraform_destroy would remove instead of what an apply would change. '
          + 'The plan names every resource that goes away, and terraform_destroy later applies '
          + 'this same saved plan. Writes a separate destroy.plan.tfplan and does not touch the '
          + 'apply plan.',
        ),
        target: z.array(z.string()).optional().describe(
          'With destroy: true only — the resource addresses to preview removing, e.g. '
          + '["huaweicloud_vpc.main"]. Omit to preview removing everything the deployment '
          + 'manages. terraform_destroy must be given the same list.',
        ),
        env: envParam,
      }),
    },
    guard(async (args) => handlePlan(args.deployment, args.env ?? [], args.destroy ?? false, args.target)),
  );
}

async function handlePlan(
  deployment: string,
  extraEnv: string[] = [],
  destroy = false,
  target: string[] | undefined = undefined,
) {
  const planFile = destroy ? DESTROY_PLAN_FILE : PLAN_FILE;
  // A destroy preview is a different question from an apply: it shows what would
  // be removed. It must NOT overwrite the apply plan, or the user would lose the
  // change set they had agreed to.
  //
  // The targets are part of the QUESTION, not a filter applied later: `-target`
  // at plan time is what makes the saved file describe that subset. Verified —
  // `plan -destroy -target=A -out=f` then `apply f` removes A and leaves B,
  // whereas `-target` cannot be passed to `apply` alongside a plan file.
  //
  // An apply plan never takes targets. Terraform accepts them, but they narrow
  // what is computed, and a plan that omits a resource would apply half a
  // deployment while reporting success.
  const planArgs = destroy
    ? [
        "plan", "-destroy",
        ...(target ?? []).map((address) => `-target=${address}`),
        `-out=${planFile}`, "-json",
      ]
    : ["plan", `-out=${planFile}`, "-json"];
  return runOperation(
        async () => {
      const result = await runTerraform(deployment, planArgs, extraEnv);
      if (result.exitCode !== 0) {
        // terraform plan -json emits diagnostics as JSON lines on stdout
        // ({"type":"diagnostic","level":"error","summary":"..."}), not stderr.
        // Include BOTH so the LLM can see the actual error — dropping stdout
        // here was swallowing the .tf validation messages.
        return { exit_code: result.exitCode, outputs: { stdout: result.stdout, stderr: result.stderr } };
      }
      // Get structured plan via show -json.
      //
      // This is not best-effort: the tool's whole contract is "return the
      // CHANGES", and an absent change list reported as an empty one would say
      // "nothing will happen" about a plan nobody could read. So the failure is
      // carried out, and the caller decides — it currently refuses.
      let planJson: unknown = null
      let sgRules: SecgroupRuleView[] = []
      let planTruncated = false
      let showFailure: string | undefined
      const showResult = await runTerraform(deployment, ["show", "-json", planFile], extraEnv)
      if (showResult.exitCode !== 0) {
        showFailure = (showResult.stderr || showResult.stdout).trim().slice(0, 400)
      } else {
        if (showResult.stdoutTruncated) planTruncated = true
        try {
          planJson = JSON.parse(showResult.stdout)
          sgRules = extractSecurityGroups(planJson)
        } catch (error) {
          showFailure = `terraform show produced output that is not JSON: ${
            error instanceof Error ? error.message : String(error)}`
        }
      }
      if (planJson === null) {
        return {
          exit_code: 1,
          outputs: {
            error:
              `the plan was written to ${planFile}, but its change list could not be read, so `
              + 'this tool cannot report what would change. That is not the same as "nothing '
              + 'would change". Destroy the plan with terraform_plan again, and if this repeats, '
              + `the saved file is unreadable:\n${showFailure ?? 'terraform show returned no output'}`,
          },
        }
      }
      // The change list comes from `resource_changes[].change.actions`, which is
      // stable across terraform versions; the stdout "summary" line is not
      // (1.9+ emits `change_summary` instead, and `-out` mode usually omits it
      // entirely).
      const summary = summarizePlan(planJson)
      if (summary === undefined) {
        return {
          exit_code: 1,
          outputs: {
            error:
              'the saved plan is not a plan document terraform can summarize — it carries no '
              + 'resource_changes. Applying it would run changes nobody was shown, so the gate '
              + 'is left without a record. Call terraform_plan again.',
          },
        }
      }
      const counts = summary.counts
      // Record which configuration this plan describes. `terraform apply` runs
      // this file and terraform does NOT check that the `.tf` still matches it,
      // The digest is what ties the approved changes to the configuration they were
      // computed from. If it cannot be computed, the plan is still written and
      // usable — but nothing records what it describes, so `terraform_apply`
      // will refuse it. That is a fact to report now, at plan time, rather than
      // let the user discover it after calling apply.
      let tfHash: string | undefined
      let recordFailure: string | undefined
      try {
        tfHash = await computeTfHash(deployment)
      } catch (error) {
        recordFailure =
          `the configuration digest could not be computed (${
            error instanceof Error ? error.message : String(error)}), so nothing records which `
          + 'configuration this plan describes — terraform_apply will refuse it until '
          + 'terraform_plan succeeds.'
      }
      if (tfHash !== undefined) {
        // Two separate records, because they answer two separate questions.
        // `plan_check` tells terraform_apply a plan of THIS configuration
        // exists; a destroy preview must not satisfy it, since applying the
        // previewed teardown is not what that gate authorises. `destroy_check`
        // names the targets the preview covered, which is how
        // terraform_destroy knows the saved teardown matches the request.
        const recorded = await updateSnapshot(deployment, destroy
          ? {
              last_operation: "terraform_plan_destroy",
              destroy_check: {
                tf_hash: tfHash,
                previewed_at: new Date().toISOString(),
                targets: target ?? [],
              },
            }
          : {
              last_operation: "terraform_plan",
              plan_check: {
                tf_hash: tfHash,
                planned_at: new Date().toISOString(),
                actions: counts,
              },
            }).then(() => undefined, (error: unknown) => String(error))
        if (recorded !== undefined) {
          recordFailure =
            `the plan was written, but this deployment's record of it could not be saved `
            + `(${recorded}). terraform_apply reads that record and will refuse this plan until `
            + 'terraform_plan succeeds at writing it.'
        }
      }
      return {
        exit_code: 0,
        outputs: {
          // The changes, not the plan document: a real plan runs to megabytes
          // of provider defaults, and what an approval turns on is which
          // resources change and how.
          summary: counts,
          changes: summary.resources,
          outputs: summary.outputs,
          security_group_rules: sgRules,
          plan_file: planFile,
          ...(destroy ? { destroy_preview: true } : {}),
          ...(planTruncated
            ? { warning: "plan output exceeded size limit and was truncated — the change list may be incomplete" }
            : {}),
          ...(recordFailure === undefined ? {} : { warning: recordFailure }),
        },
      };
    },
  );
}

function registerApply(registrar: ToolRegistrar): void {
  registrar.registerTool(
    "terraform_apply",
    {
      title: "Terraform apply",
      description:
        "Run `terraform apply` on the plan `terraform_plan` saved. Five gates run first: " +
        "the network design was checked by validate_design and the .tf has not changed " +
        "since, price_resources recorded a cost for a configuration that has not changed " +
        "since, terraform_plan produced the saved plan from THIS configuration, and no " +
        "plaintext credentials. " +
        "It applies that plan file rather than re-planning, so the changes executed are " +
        "exactly the ones the user was shown. Editing any .tf after planning invalidates " +
        "the plan — call terraform_plan again.",
      annotations: CLOUD_DESTRUCTIVE,
      inputSchema: z.object({ deployment: deploymentParam, env: envParam }),
    },
    // Named so the read-only gate can refuse it: this tool creates and
    // modifies cloud resources, and never calls signedHttp, so the HTTP gate
    // cannot see it (see permission/gate.ts).
    guard(async (args) => handleApply(args.deployment, args.env ?? []), "terraform_apply"),
  );
}

async function handleApply(deployment: string, extraEnv: string[] = []) {
  // Safety gates — synchronous fast-fail before launching the task.
  try {
    await assertDesignChecked(deployment, readSnapshot, computeTfHash);
    await runCostGate(deployment);
    await assertPlanApproved(deployment, readSnapshot, computeTfHash);
    await assertNoCredentials(deployment);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  return runOperation(
        async () => {
      // The saved plan, not a fresh computation: this is the change set the
      // user was shown. `-auto-approve` is not needed and not accepted with a
      // plan file — the plan IS the approval record.
      const result = await runTerraform(deployment, ["apply", PLAN_FILE], extraEnv);
      if (result.exitCode !== 0) {
        return { exit_code: result.exitCode, outputs: { stdout: result.stdout, stderr: result.stderr } };
      }
      await updateSnapshot(deployment, { applied: true, last_operation: "terraform_apply" });
      // The plan is spent. terraform will not apply the same file twice — the
      // state moved — so leaving it beside a matching `plan_check` would let a
      // second apply pass every gate and then fail on terraform's own error.
      // Clearing both sends that case to "call terraform_plan first".
      const cleanup = await spendPlan(deployment);
      return {
        exit_code: 0,
        outputs: {
          stdout: result.stdout,
          stderr: result.stderr,
          ...(cleanup === undefined ? {} : { warning: cleanup }),
        },
      };
    },
  );
}

function registerDestroy(registrar: ToolRegistrar): void {
  registrar.registerTool(
    "terraform_destroy",
    {
      title: "Terraform destroy",
      description:
        "Run `terraform apply` on the destruction `terraform_plan({ destroy: true })` saved. " +
        "Permanently deletes cloud resources managed by this deployment — irreversible. " +
        "Refuses to run without a saved teardown covering exactly these targets: a destroy " +
        "that computed its own plan would remove a set of resources nobody previewed. " +
        "Also refuses when the state is empty (nothing to destroy) or when the .tf files " +
        "hold plaintext credentials (the same scan init and apply run). " +
        "By default destroys ALL resources in the deployment. Pass `target` to destroy only " +
        "specific resources by address — use this to spare imported (reuse) resources: " +
        "destroy only the newly-created resources, leaving imported ones in state. " +
        "`target` must match the list terraform_plan was given with destroy: true, or the " +
        "gate refuses: the saved teardown is the approval record, and a different target " +
        "list is a different destruction than the one previewed.",
      annotations: CLOUD_DESTRUCTIVE,
      inputSchema: z.object({
        deployment: deploymentParam,
        target: z.array(z.string()).optional().describe(
          "Resource addresses to destroy selectively. e.g. " +
          "[\"huaweicloud_vpc.main\", \"huaweicloud_vpc_subnet.sub1\"]. " +
          "Omit to destroy ALL resources (default). " +
          "Must equal the target list given to terraform_plan with destroy: true. " +
          "Use this to spare imported resources: destroy only newly-created resources, leaving imported ones in state."
        ),
        env: envParam,
      }),
    },
    // Named so the read-only gate can refuse it: destroy deletes cloud
    // resources and never calls signedHttp (see permission/gate.ts).
    guard(async (args) => {
      // Gate 1: state must be non-empty — there must be resources to destroy.
      // Destroying an empty deployment is a no-op that masks bugs (wrong dir,
      // already-destroyed state). The count comes from the configured backend,
      // not from a local file a remote backend never writes.
      const recordedCount = await stateRecordedResourceCount(args.deployment, runTerraform);
      if (recordedCount === 0) {
        return fail("no resources recorded in tfstate — nothing to destroy (already destroyed or never applied)");
      }
      try {
        await assertNoCredentials(args.deployment);
        // Gate 2: the saved teardown must exist and cover the same targets.
        // `destroy -auto-approve` computes its own plan, so without this the
        // resources removed are a second computation of the list the user
        // approved — not the list itself.
        await assertDestroyPreviewed(
          args.deployment,
          readSnapshot,
          computeTfHash,
          args.target ?? [],
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      return runOperation(
        async () => {
          // The previewed plan, not a fresh computation: the targets were
          // resolved once, when the user was shown the list, and `-target` is
          // not accepted alongside a plan file — so applying this file is the
          // only way the destruction matches what was approved.
          const result = await runTerraform(args.deployment, ["apply", DESTROY_PLAN_FILE], args.env ?? []);
          if (result.exitCode !== 0) {
            return { exit_code: result.exitCode, outputs: { stdout: result.stdout, stderr: result.stderr } };
          }
          // A destroy is a state change like any other, and a bigger one than
          // most. Both plans are spent — the preview by being applied, the apply
          // plan by describing state that no longer exists — so both go, and so
          // do their records. Without this, `terraform_apply` would find a plan
          // file and a matching digest, pass every gate, and fail on terraform's
          // "Saved plan is stale".
          const cleanup = await spendPlan(args.deployment);
          await updateSnapshot(args.deployment, { destroyed: true, last_operation: "terraform_destroy" });
          return {
            exit_code: 0,
            outputs: {
              stdout: result.stdout,
              stderr: result.stderr,
              resources_destroyed: args.target ? args.target.length : recordedCount,
              ...(args.target ? { targeted: args.target } : {}),
              ...(cleanup === undefined ? {} : { warning: cleanup }),
            },
          };
        },
      );
    }, "terraform_destroy"),
  );
}

function registerRefresh(registrar: ToolRegistrar): void {
  registrar.registerTool(
    "terraform_refresh",
    {
      title: "Terraform refresh",
      description:
        "Reconcile tfstate with the cloud: runs `terraform apply -refresh-only`, which " +
        "records what each managed resource looks like now without changing any of them. " +
        "Use it when something changed outside terraform — edited in the console, deleted " +
        "by hand — then call terraform_plan to see the difference.",
      annotations: READ_ONLY_CLOUD,
      inputSchema: z.object({ deployment: deploymentParam, env: envParam }),
    },
    guard(async (args) => {
      return runOperation(
        async () => {
          const result = await runTerraform(args.deployment, ["apply", "-refresh-only", "-auto-approve"], args.env ?? []);
          if (result.exitCode !== 0) {
            return { exit_code: result.exitCode, outputs: { stdout: result.stdout, stderr: result.stderr } };
          }
          return { exit_code: 0, outputs: { stdout: result.stdout, stderr: result.stderr } };
        },
      );
    }),
  );
}

function registerState(registrar: ToolRegistrar): void {
  registrar.registerTool(
    "terraform_state",
    {
      title: "Read tfstate",
      description:
        "Read terraform state via `terraform show -json`. Without `address` it returns the "
        + "INVENTORY: one entry per managed resource with its address, type and module — which "
        + "is what terraform_import, terraform_destroy's `target` and -target all take. The "
        + "attributes are deliberately left out, and so is the raw state document: a deployment "
        + "of a hundred resources carries every attribute of every one, and handing that to you "
        + "spends the conversation on provider defaults. "
        + "With `address`, return that ONE resource in full — the same selector terraform's own "
        + "`-target` uses, so an address that works here works there. Call the inventory first "
        + "to find the address. "
        + "Both forms also return the security-group rules the state records, flattened.",
      annotations: READ_ONLY_LOCAL,
      inputSchema: z.object({
        deployment: deploymentParam,
        address: z.string().optional().describe(
          'Return this one resource in full, e.g. "huaweicloud_compute_instance.web" or '
          + '"module.net.huaweicloud_vpc.prod". Omit for the inventory of addresses and types.',
        ),
        env: envParam,
      }),
    },
    guard(async (args) => {
      // `terraform show -json` of the whole state is not bounded by anything
      // useful: a deployment of a hundred HuaweiCloud resources carries every
      // attribute of every one — megabytes — and handing that to the model
      // spends its context on provider defaults nobody asked about. So the
      // default answer is the INVENTORY, which is what every caller so far
      // wants, and one address can be asked for in full.
      //
      // `address` is selected HERE, from the parsed document, rather than by
      // `terraform show <address>`: that command treats its argument as a FILE
      // name ("Failed to read the given file as a state or plan file", verified
      // against terraform 1.15), and `terraform state show` has no `-json` flag.
      // Parsing once and selecting keeps the stable `show -json` interface.
      const result = await runTerraform(args.deployment, ["show", "-json"], args.env ?? []);
      if (result.exitCode !== 0) return fail(`terraform state read failed: exit ${result.exitCode}: ${result.stderr}`);
      if (result.stdoutTruncated) {
        return fail("terraform state output exceeded size limit and was truncated — state too large to parse");
      }
      let stateJson: unknown
      try {
        stateJson = JSON.parse(result.stdout)
      } catch (err) {
        return fail(`failed to parse state: ${err instanceof Error ? err.message : String(err)}`)
      }
      const sgRules = extractSecurityGroups(stateJson)

      if (args.address !== undefined) {
        const found = stateResource(stateJson, args.address)
        if (found === undefined) {
          return fail(
            `no resource at that address in the state. Call terraform_state without \`address\` `
            + `for the inventory — the addresses it lists are the ones this accepts.`,
          )
        }
        return okJson({ address: args.address, state: found, security_group_rules: sgRules })
      }
      return okJson({ resources: stateInventory(stateJson), security_group_rules: sgRules })
    }),
  );
}

/**
 * One resource's full state, by terraform address.
 *
 * The address is compared exactly, and in the form terraform writes it:
 * `module.net.huaweicloud_vpc.prod` for a module, `…web[0]` for a counted one.
 * A plain block address also answers for a resource declared with `count = 1`
 * only when the state spells it that way — nothing is guessed, because a
 * substring match would return a resource the caller did not name.
 *
 * @param stateJson - the parsed `terraform show -json` output.
 * @param address - the address to select.
 * @returns that resource's values, or `undefined` when it is not in the state.
 */
export function stateResource(stateJson: unknown, address: string): unknown {
  if (stateJson === null || typeof stateJson !== 'object') return undefined
  const root = (stateJson as { values?: { root_module?: unknown } }).values?.root_module
  let found: unknown
  const walk = (module: unknown, prefix: string): void => {
    if (found !== undefined || module === null || typeof module !== 'object') return
    const resources = (module as { resources?: unknown }).resources
    if (Array.isArray(resources)) {
      for (const raw of resources) {
        if (raw === null || typeof raw !== 'object') continue
        const entry = raw as { address?: unknown }
        if (typeof entry.address === 'string' && `${prefix}${entry.address}` === address) {
          found = entry
          return
        }
      }
    }
    const children = (module as { child_modules?: unknown }).child_modules
    if (Array.isArray(children)) {
      for (const child of children) {
        const childAddress = (child as { address?: unknown }).address
        if (typeof childAddress === 'string') walk(child, `${childAddress}.`)
      }
    }
  }
  walk(root, '')
  return found
}

/**
 * Every resource in a state document, as the pair a reader acts on.
 *
 * The address is what `terraform_import`, `-target` and `terraform_destroy`
 * all take, so it is the thing a caller needs; the type is what a reader
 * groups by. The attributes are deliberately absent — they are the bulk, and
 * `address` returns them for the one resource asked about.
 *
 * @param stateJson - the parsed `terraform show -json` output.
 * @returns one entry per resource, in state order.
 */
export function stateInventory(
  stateJson: unknown,
): { readonly address: string, readonly type: string, readonly module?: string }[] {
  if (stateJson === null || typeof stateJson !== 'object') return []
  const root = (stateJson as { values?: { root_module?: unknown } }).values?.root_module
  const entries: { address: string, type: string, module?: string }[] = []
  const walk = (module: unknown, prefix: string): void => {
    if (module === null || typeof module !== 'object') return
    const resources = (module as { resources?: unknown }).resources
    if (Array.isArray(resources)) {
      for (const raw of resources) {
        if (raw === null || typeof raw !== 'object') continue
        const entry = raw as { address?: unknown, type?: unknown }
        if (typeof entry.address !== 'string' || typeof entry.type !== 'string') continue
        entries.push({
          address: `${prefix}${entry.address}`,
          type: entry.type,
          ...(prefix === '' ? {} : { module: prefix.replace(/\.$/, '') }),
        })
      }
    }
    const children = (module as { child_modules?: unknown }).child_modules
    if (Array.isArray(children)) {
      for (const child of children) {
        const address = (child as { address?: unknown }).address
        if (typeof address === 'string') walk(child, `${address}.`)
      }
    }
  }
  walk(root, '')
  return entries
}

function registerImport(registrar: ToolRegistrar): void {
  registrar.registerTool(
    "terraform_import",
    {
      title: "Terraform import",
      description:
        "Run `terraform import` to bring an existing cloud resource into tfstate " +
        "without creating it. The resource address and ID format depend on the provider " +
        "type — check provider docs or apiexplorer for the import syntax (e.g. " +
        "huaweicloud_compute_instance.myvm <instance-id>). " +
        "IMPORT DOES NOT RECONCILE. It records what the CLOUD holds; the resource block in " +
        "the .tf may say something else, and nothing compares them here. A plan run " +
        "afterwards shows that difference as a diff — applying it would CHANGE a resource " +
        "that was meant to be left alone, possibly by replacing it.",
      annotations: READ_ONLY_CLOUD,
      inputSchema: z.object({
        deployment: deploymentParam,
        address: z.string().min(1).describe("Terraform resource address, e.g. huaweicloud_compute_instance.myvm"),
        id: z.string().min(1).describe("Cloud resource ID to import (provider-specific format)"),
        env: envParam,
      }),
    },
    guard(async (args) => handleImport(args.deployment, args.address, args.id, args.env ?? [])),
  );
}

async function handleImport(deployment: string, address: string, id: string, extraEnv: string[] = []) {
  try {
    await assertNoCredentials(deployment);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const result = await runTerraform(deployment, ["import", address, id], extraEnv);
  if (result.exitCode !== 0) {
    return fail(JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  }
  // An import writes state, which makes any saved plan stale: terraform refuses
  // to apply a plan whose state moved — "the given plan file can no longer be
  // applied because the state was changed by another operation" (verified).
  // Clearing the records turns that into "call terraform_plan first", which is
  // the next step anyway.
  const cleanup = await spendPlan(deployment);
  return okJson({
    address,
    id,
    imported: true,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(cleanup === undefined ? {} : { warning: cleanup }),
    next:
      'Run terraform_plan now — the import invalidated any saved plan, and this is the step '
      + 'that reconciles it. The import recorded what the cloud holds; the .tf block may '
      + 'describe something different, and a plan diff means applying would change a resource '
      + 'the user wanted reused. Show that diff before continuing.',
  });
}

/** Get terraform version string via `terraform version`. */
async function getTerraformVersion(binary: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("close", () => {
      const m = out.match(/Terraform v(\S+)/);
      resolve(m ? m[1]! : "unknown");
    });
    child.on("error", () => resolve("unknown"));
  });
}

/**
 * Default terraform version to download when the user doesn't pin one.
 *
 * Pinned rather than "latest" to keep installs reproducible and avoid a
 * network round-trip to probe the latest version. Bump this when a newer
 * version is vetted. Verified available:
 *   https://releases.hashicorp.com/terraform/1.9.5/terraform_1.9.5_linux_amd64.zip
 */
const DEFAULT_TERRAFORM_VERSION = "1.9.5";

/**
 * Default binary download mirrors, tried in order.
 *
 * HuaweiCloud does NOT mirror the terraform binary (verified:
 * mirrors.huaweicloud.com/terraform/ hosts only the provider registry;
 * .../hashicorp/terraform/ returns HTML, not zip). The only source is
 * HashiCorp's official releases. A continental-CDN mirror would help
 * download speed in CN, but none was found — the user can pass
 * binary_mirrors to override with a known-good mirror.
 */
const DEFAULT_BINARY_MIRRORS = ["https://releases.hashicorp.com/terraform/"];

/** Detect platform for download URL construction. */
function detectPlatform(): { version: string; arch: string; platform: string } {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return { version: DEFAULT_TERRAFORM_VERSION, arch, platform };
}

/**
 * Where a downloaded terraform binary goes.
 *
 * The host cache first, because one binary serves every deployment: a machine
 * runs `terraform_init` on several workspaces and downloading per workspace
 * would be a copy each.
 *
 * ## Why the fallback is the temp directory, not a deployment
 *
 * The cache lives under the host's data directory, and that is unwritable in
 * some environments — a container with a read-only home, a sandboxed runner. A
 * download still has to land somewhere.
 *
 * A deployment directory is the wrong place for it, in two ways. A binary is not
 * a deployment asset: putting it inside one makes it invisible to every other
 * deployment, so each workspace downloads its own copy. And it puts an
 * executable inside a directory the user treats as their own content, which is
 * not where a tool should write things it will not clean up.
 *
 * The temp directory is the standard answer to "no persistent location
 * available": shared by every deployment in this process, and rebuilt on the
 * next run if the system clears it. A cache that can be rebuilt is the right
 * loss here; a polluted workspace is not.
 *
 * @returns the directory to download into.
 * @throws when neither location exists, naming what to fix.
 */
async function resolveDownloadDir(): Promise<string> {
  const globalDir = terraformBinDir();
  const failure = await writableDirectory(globalDir);
  if (failure === undefined) return globalDir;

  const temporary = join(tmpdir(), 'aishell-terraform');
  const temporaryFailure = await writableDirectory(temporary);
  if (temporaryFailure === undefined) {
    process.stderr.write(
      `terraform_install: the host cache at ${globalDir} is not writable (${failure}); `
      + `using ${temporary}, which will not survive a reboot.\n`,
    );
    return temporary;
  }

  throw new Error(
    `terraform has nowhere to be installed: the host cache at ${globalDir} is not writable `
    + `(${failure}), and neither is ${temporary} (${temporaryFailure}). `
    + 'Grant write access to one of them, or install terraform yourself and pass '
    + '`terraform_path`.',
  );
}

/**
 * Create a directory and confirm it accepts a write.
 *
 * A directory that exists is not the same as one this process can write into:
 * a root-owned cache is present and read-only. The probe is a real file rather
 * than an access check, because what matters is whether a download will
 * succeed, not whether the mode bits look permissive.
 *
 * @param dir - the directory to test, created when absent.
 * @returns the reason it cannot be used, or `undefined` when it can.
 */
async function writableDirectory(dir: string): Promise<string | undefined> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, ".write-test");
    await writeFile(probe, "");
    const { unlink } = await import("node:fs/promises");
    await unlink(probe);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Download + extract terraform binary from a mirror.
 *
 * URL pattern: <mirror>/<version>/terraform_<version>_<os>_<arch>.zip
 *   e.g. https://releases.hashicorp.com/terraform/1.9.5/terraform_1.9.5_linux_amd64.zip
 *
 * Downloads to a temp file, extracts via extractArchive (adm-zip), then
 * renames the extracted `terraform` binary to a versioned name and makes it
 * executable. Non-windows only chmod — Windows doesn't need the exec bit.
 *
 * @throws DownloadError (with `kind`) on any failure. The kind lets handleInstall
 *         give the LLM a concrete next action instead of a generic "failed".
 */
type DownloadErrorKind = "network" | "http_4xx" | "http_5xx" | "extraction";
interface DownloadError extends Error {
  kind: DownloadErrorKind;
}
function downloadError(kind: DownloadErrorKind, message: string): DownloadError {
  const e = new Error(message) as DownloadError;
  e.kind = kind;
  return e;
}

async function downloadAndExtract(
  mirror: string,
  version: string,
  platform: string,
  arch: string,
  destDir: string,
): Promise<void> {
  const base = mirror.endsWith("/") ? mirror : mirror + "/";
  const url = `${base}${version}/terraform_${version}_${platform}_${arch}.zip`;

  // fetch throws TypeError on network failures (DNS, refused, timeout, TLS).
  // The bare "fetch failed" is useless to the LLM — unwrap the cause to
  // surface the actual reason (e.g. ENOTFOUND, ECONNREFUSED, certificate error).
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(300000) }); // 5 min for binary download
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause as NodeJS.ErrnoException : null;
    const detail = cause ? `${cause.code ?? cause.name}: ${cause.message}` : (err instanceof Error ? err.message : String(err));
    throw downloadError("network", `network error fetching ${url}: ${detail}`);
  }
  if (!resp.ok) {
    const kind = resp.status >= 500 ? "http_5xx" : "http_4xx";
    throw downloadError(kind, `HTTP ${resp.status} ${resp.statusText} fetching ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());

  // Write to a temp file in destDir, extract, clean up.
  const { writeFile: writeFileFs, unlink, rename } = await import("node:fs/promises");
  const tmpZip = join(destDir, `.terraform-${version}-${Date.now()}.zip`);
  await writeFileFs(tmpZip, buf);
  try {
    await extractArchive(tmpZip, destDir);
  } catch (err) {
    throw downloadError("extraction", `zip extraction failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await unlink(tmpZip).catch(() => {});
  }

  // The zip extracts a single `terraform` binary. Rename to a versioned name
  // so resolveTerraformEnv's global-cache search (terraform-<ver>) finds it.
  // If the versioned name already exists (e.g. a prior partial download), we
  // do NOT swallow the rename error — a swallowed rename leaves the binary at
  // the unversioned path while chmod targets the versioned one, producing a
  // non-executable binary that getTerraformVersion can't run.
  const extractedPath = join(destDir, "terraform");
  const versionedPath = join(destDir, `terraform-${version}`);
  await rename(extractedPath, versionedPath);

  // adm-zip's extractAllTo does not preserve unix exec bits — the extracted
  // binary is mode 0666 and won't run. chmod it executable (non-windows only;
  // Windows has no exec bit).
  if (platform !== "windows") {
    const { chmod } = await import("node:fs/promises");
    await chmod(versionedPath, 0o755);
  }
}

/**
 * Run a long terraform operation and return the tool-call result.
 *
 * Synchronous by construction. There is no background-task variant and no
 * progress channel: the harness bounds the call with the tool's own timeout,
 * and a caller that wants to give up sooner cancels the call.
 *
 * Safety gates MUST run before this — they are the synchronous fast-fail that
 * stops a doomed run before terraform starts doing anything.
 *
 * @param work - the operation, returning its exit code and outputs.
 * @returns the outputs on success, or the outputs-or-exit-code as a failure.
 */
async function runOperation(
  work: () => Promise<{ exit_code: number; outputs?: Record<string, unknown> }>,
): Promise<CallToolResult> {
  const result = await work();
  if (result.exit_code === 0) {
    return okJson(result.outputs ?? {});
  }
  return fail(JSON.stringify(result.outputs ?? { error: `exit ${result.exit_code}` }));
}

/**
 * Forget the plans an operation just spent.
 *
 * ## Why this is a function and not five lines at each call site
 *
 * Three operations write state — apply, destroy and import — and all three make
 * every saved plan stale: terraform refuses to apply a plan whose state moved
 * ("the given plan file can no longer be applied because the state was changed
 * by another operation", verified). Each was clearing the files and records
 * itself, and the three copies had already drifted: destroy cleared its own
 * preview but left the apply plan, so a second `terraform_apply` passed every
 * gate and failed on terraform's stale-plan error.
 *
 * ## Why a failure here is reported and not swallowed
 *
 * The whole point is that the next call must not find a plan whose state has
 * moved. A delete that failed leaves exactly that, so returning quietly would
 * hand the caller a workspace that will fail one step later with an error
 * naming neither the cause nor the remedy. The message says what is left and
 * what to do about it.
 *
 * A record that cannot be cleared is the milder half — the file is gone, so the
 * gate asks for a new plan anyway — but it is reported too, because a reader
 * who sees a warning is better off than one who finds out at apply time.
 *
 * @param deployment - the deployment workspace directory.
 * @returns a warning when something could not be cleared, otherwise `undefined`.
 */
async function spendPlan(deployment: string): Promise<string | undefined> {
  const problems: string[] = []
  for (const file of [PLAN_FILE, DESTROY_PLAN_FILE]) {
    try {
      await rm(join(deployment, file), { force: true })
    } catch (error) {
      problems.push(
        `${file} could not be removed (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }
  try {
    await clearPlanRecords(deployment)
  } catch (error) {
    problems.push(
      'the plan records could not be cleared '
      + `(${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (problems.length === 0) return undefined
  return (
    `The operation succeeded, but the spent plan could not be tidied away: ${problems.join('; ')}. `
    + 'The next terraform_apply or terraform_destroy may still find that file and fail with '
    + '"Saved plan is stale" — call terraform_plan before it, or remove the file by hand.'
  )
}
