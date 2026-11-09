/**
 * Stateless terraform execution environment resolver.
 *
 * Each tool call is independent — nothing here remembers what terraform_install
 * or terraform_init did. But the terraform subprocess needs to know: binary
 * path, .terraformrc location, TF_PLUGIN_CACHE_DIR, and credential env.
 *
 * Every terraform tool (init/plan/apply/destroy/refresh/state) calls this
 * before spawning. It re-derives from filesystem state — a few stat calls,
 * no cross-call memory.
 *
 * Credential env is injected from the keychain — NEVER passed via
 * tool parameters. The tool-param-controlled env is `extraEnv` — an array
 * of KEY=VALUE strings merged onto the subprocess env (e.g. TF_LOG=DEBUG,
 * TF_LOG_PROVIDER=OFF, TF_CLI_ARGS_plan=-refresh=false).
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { configuredRegion, loadCredentials } from "../credentials.js";
import { terraformBinDir, terraformPathRecord, terraformPluginDir } from "../data-paths.js";

// Resolved through `../data-paths` on each use, not captured at module load:
// `DSH_HOME` is read at call time there, and a snapshot would ignore a host
// that sets it after this module was first imported.

export interface ResolvedEnv {
  binary: string;
  env: Record<string, string>;
}

/**
 * Resolve the terraform binary path + env for a deployment.
 * Throws if no binary can be found.
 */
export async function resolveTerraformEnv(
  deployment: string | undefined,
  extraEnv: string[] = [],
): Promise<ResolvedEnv> {
  const binary = await resolveBinary();
  const env: Record<string, string> = {};

  // .terraformrc — provider mirror config
  await resolveTerraformrc(deployment, env);

  // TF_PLUGIN_CACHE_DIR — global provider cache (HOME writable only)
  await resolvePluginCache(env);

  // Credentials from the keychain. Env var names match the huaweicloud
  // provider's documented names (docs/index.md): HW_ACCESS_KEY, HW_SECRET_KEY,
  // HW_SECURITY_TOKEN. Same names auth.ts reads — one set.
  try {
    const creds = await loadCredentials();
    env["HW_ACCESS_KEY"] = creds.ak;
    env["HW_SECRET_KEY"] = creds.sk;
    if (creds.securityToken) {
      env["HW_SECURITY_TOKEN"] = creds.securityToken;
    }
  } catch {
    // Not authenticated — terraform will fail with a clear error if it
    // needs creds. We don't block here; some commands (e.g. terraform fmt)
    // don't need creds.
  }

  // HW_REGION_NAME, only when an operator configured one.
  //
  // It is the provider's fallback for a configuration that does not set
  // `region` itself, so injecting a built-in value would let a deployment be
  // provisioned somewhere nobody chose — and would hide the provider's own
  // "region required" error, which names the missing argument. Left unset, a
  // provider block that names a region works, one that does not says so.
  const configured = configuredRegion();
  if (configured !== undefined && configured !== "") {
    env["HW_REGION_NAME"] = configured;
  }

  // Merge user-supplied env vars (KEY=VALUE strings) — e.g. TF_LOG=DEBUG,
  // TF_LOG_PROVIDER=OFF, TF_CLI_ARGS_plan=-refresh=false. These are merged
  // AFTER credentials, so a user-supplied HW_ACCESS_KEY etc. overrides the
  // keychain credentials — this is intentional, allowing per-call account
  // switching. A KEY= (empty value) unsets/empties the var.
  for (const entry of extraEnv) {
    const eq = entry.indexOf("=");
    if (eq >= 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }

  return { binary, env };
}

/**
 * Binary priority: HW_TERRAFORM_PATH env > PATH > recorded path > global cache
 * > deployment fallback.
 *
 * The recorded path sits after PATH and before the cache: it is the binary the
 * user named in `terraform_install`, so it outranks an unexplored cache, but an
 * environment variable set by the operator still wins over it — the same
 * precedence the rest of this module gives to explicit configuration.
 */
async function resolveBinary(): Promise<string> {
  // 1. User-specified via the environment.
  const envPath = process.env["HW_TERRAFORM_PATH"];
  if (envPath && (await fileExists(envPath))) {
    return envPath;
  }

  // 2. PATH search.
  const pathBinary = await findInPath("terraform");
  if (pathBinary) {
    return pathBinary;
  }

  // 3. The path a previous `terraform_install` was told to use.
  const recorded = await recordedBinaryPath();
  if (recorded !== undefined && (await fileExists(recorded))) {
    return recorded;
  }

  // 4. Cache under the host's data directory.
  const globalBin = await findGlobalCacheBinary();
  if (globalBin) {
    return globalBin;
  }

  // 5. The temporary cache, which is where a download lands when the host's
  //    data directory is not writable. It is also shared by every deployment,
  //    for the same reason the host cache is.
  const temporaryBin = await findTemporaryCacheBinary();
  if (temporaryBin) {
    return temporaryBin;
  }

  throw new Error("terraform not found — call terraform_install first");
}

/**
 * Record the binary path `terraform_install` was given.
 *
 * Without this, the path is validated, reported in the tool result, and
 * forgotten — and the very next `terraform_plan` fails with "terraform not
 * found", which is the least useful answer to a call that just succeeded.
 *
 * A failure to write is swallowed by the caller: the install itself worked, and
 * losing the record only means the next call falls back to the search order.
 *
 * @param path - an absolute path to a terraform binary the user supplied.
 */
export async function recordBinaryPath(path: string): Promise<void> {
  const record = terraformPathRecord();
  await mkdir(join(record, ".."), { recursive: true });
  await writeFile(record, path, "utf8");
}

/**
 * The recorded binary path, when there is one.
 *
 * @returns the path, or `undefined` when nothing was recorded or it is unusable.
 */
async function recordedBinaryPath(): Promise<string | undefined> {
  try {
    const raw = await readFile(terraformPathRecord(), "utf8");
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/**
 * Where terraform's CLI configuration comes from: deployment file > user env >
 * user home > none.
 *
 * ## Why the deployment file is absolute
 *
 * The subprocess runs with `cwd` set to the deployment, and `TF_CLI_CONFIG_FILE`
 * is resolved by terraform against THAT directory, not against the process that
 * spawned it. A deployment given as a relative path therefore produced
 * `<deployment>/<deployment>/.terraformrc`: a file that cannot exist, a warning
 * on every run, and — the part that matters — a provider mirror that silently
 * never applied.
 *
 * `resolve(deployment)` is what makes the value mean the same thing to both
 * processes. The caller may hand this module a relative path; nothing
 * downstream can.
 *
 * @param deployment - the deployment directory, relative or absolute.
 * @param env - the subprocess env being assembled.
 */
async function resolveTerraformrc(deployment: string | undefined, env: Record<string, string>): Promise<void> {
  if (deployment !== undefined) {
    const depRc = join(resolve(deployment), ".terraformrc");
    if (await fileExists(depRc)) {
      env["TF_CLI_CONFIG_FILE"] = depRc;
      return;
    }
  }

  // User set TF_CLI_CONFIG_FILE in the environment — respect it.
  // Copied into the subprocess env as an absolute path for the same reason:
  // the child resolves it against its own cwd, not the parent's.
  const fromEnv = process.env["TF_CLI_CONFIG_FILE"];
  if (fromEnv !== undefined && fromEnv !== "") {
    env["TF_CLI_CONFIG_FILE"] = resolve(fromEnv);
    return;
  }

  // User has ~/.terraformrc — terraform reads it by default, no env needed.
  const homeRc = join(homedir(), ".terraformrc");
  if (await fileExists(homeRc)) {
    return;
  }

  // No config — terraform uses default registry. Server could generate one
  // here, but terraform_init handles that. Other tools just run with defaults.
}

/** TF_PLUGIN_CACHE_DIR — global cache when HOME is writable. */
async function resolvePluginCache(env: Record<string, string>): Promise<void> {
  if (process.env["TF_PLUGIN_CACHE_DIR"]) {
    return; // User set it — respect.
  }
  // Created on demand: the cache is ours to make, and a missing directory is
  // the normal first-run state rather than a reason to fall back.
  const pluginDir = terraformPluginDir();
  try {
    await mkdir(pluginDir, { recursive: true });
    env["TF_PLUGIN_CACHE_DIR"] = pluginDir;
  } catch {
    // Not writable — terraform uses its per-deployment .terraform/providers/
    // default, which is correct but slower.
  }
}

/**
 * Find terraform in PATH by running `terraform version`.
 *
 * This is the only reliable probe. `which`/`where` confirm a file exists on
 * PATH, not that it is a working terraform binary: a same-named empty file, a
 * corrupt download and an architecture mismatch all pass those and fail this.
 * `which` has portability problems of its own too — Alpine lacks it by default,
 * busybox's behaves differently, and Windows `where` emits several lines.
 * `terraform version` succeeding means the binary genuinely runs.
 *
 * The extra spawn is negligible: each terraform tool call already spawns a
 * subprocess that runs for seconds-to-minutes (init/plan/apply); a
 * `terraform version` probe takes tens of milliseconds.
 */
async function findInPath(_name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("terraform", ["version"], { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? "terraform" : null));
  });
}

/** Find a cached binary in `<DSH_HOME>/terraform/bin` (terraform-<ver>). */
/**
 * Find a binary downloaded into the temporary cache.
 *
 * This is where `terraform_install` puts one when the host's data directory is
 * read-only — a container with a read-only home, a sandboxed runner. The
 * search order has to know about it or the install would report success and
 * every later call would report no terraform.
 *
 * @returns the binary's path, or `null` when there is none.
 */
async function findTemporaryCacheBinary(): Promise<string | null> {
  try {
    const { readdir } = await import("node:fs/promises");
    const dir = join(tmpdir(), "aishell-terraform");
    const entries = await readdir(dir);
    const versioned = entries.filter((entry) => entry.startsWith("terraform-"));
    if (versioned.length > 0) {
      versioned.sort().reverse();
      const path = join(dir, versioned[0]!);
      if (await fileExists(path)) return path;
    }
    const plain = join(dir, "terraform");
    if (await fileExists(plain)) return plain;
    return null;
  } catch {
    return null;
  }
}

async function findGlobalCacheBinary(): Promise<string | null> {
  try {
    const { readdir } = await import("node:fs/promises");
    const binDir = terraformBinDir();
    const entries = await readdir(binDir);
    // Prefer versioned (terraform-1.9.5), fallback to unversioned (terraform).
    const versioned = entries.filter((e) => e.startsWith("terraform-"));
    if (versioned.length > 0) {
      // Sort descending — latest version first.
      versioned.sort().reverse();
      const path = join(binDir, versioned[0]!);
      if (await fileExists(path)) return path;
    }
    const plain = join(binDir, "terraform");
    if (await fileExists(plain)) return plain;
    return null;
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
