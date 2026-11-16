/**
 * SHA-256 hash of a deployment's configuration, recorded as `tf_hash`.
 *
 * Deterministic: files sorted by path, content hashed, concatenated.
 *   "sha256:" + SHA256(path1 + hash1 + path2 + hash2 + ...)
 *
 * ## Which files
 *
 * The same set every other reader uses — {@link configurationFiles} in `hcl`,
 * which includes a local module's `.tf`. That is the point of routing through
 * one function: the digest answers "has the configuration changed since it was
 * checked", and a file the design tool READ but the digest IGNORED would let an
 * edit pass every gate unnoticed.
 *
 * A `.terraform/` directory is excluded by that function's construction, not by
 * a filter here: it holds providers, downloaded modules and the state, and
 * hashing those would make the digest change whenever terraform fetched
 * anything.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { configurationFiles } from "../hcl.ts";

/**
 * Hash a deployment's configuration files.
 *
 * The reads run together: a deployment is a handful of files whose sizes are
 * independent, and hashing them one at a time made the wait their sum. The
 * digest itself is unchanged — each file is hashed on its own and the parts are
 * concatenated in path order, so concurrency only changes when the bytes are
 * read, never how they are combined.
 *
 * @param dir - the deployment directory.
 * @returns the `sha256:` digest of its configuration.
 */
export async function computeTfHash(dir: string): Promise<string> {
  const tfFiles = await configurationFiles(dir);

  const parts = await Promise.all(tfFiles.map(async (name) => {
    const content = await readFile(join(dir, name), "utf8");
    return `${name}${createHash("sha256").update(content, "utf8").digest("hex")}`;
  }));
  // Concatenation stays in `tfFiles` order because `Promise.all` preserves
  // input order, which is what keeps the digest stable across runs.
  const hash = createHash("sha256").update(parts.join(""), "utf8").digest("hex");
  return `sha256:${hash}`;
}
