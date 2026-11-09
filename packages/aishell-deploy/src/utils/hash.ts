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

export async function computeTfHash(dir: string): Promise<string> {
  const tfFiles = await configurationFiles(dir);

  const parts: string[] = [];
  for (const name of tfFiles) {
    const content = await readFile(join(dir, name), "utf8");
    const h = createHash("sha256").update(content, "utf8").digest("hex");
    parts.push(`${name}${h}`);
  }
  const concatenated = parts.join("");
  const hash = createHash("sha256").update(concatenated, "utf8").digest("hex");
  return `sha256:${hash}`;
}
