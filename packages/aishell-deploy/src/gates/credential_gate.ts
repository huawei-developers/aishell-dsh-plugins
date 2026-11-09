/**
 * Plaintext credential scanner for configuration files.
 *
 * Deterministic grep for access_key/secret_key/security_token/password
 * assignments in .tf files. Catches the most severe leak: credentials
 * hardcoded into .tf. Whitelists var.xxx / data.xxx references (those are
 * not plaintext values, though instructions still say don't define cred
 * variables — the gate only catches the plaintext case).
 *
 * Runs at terraform_init — early, before a provider is fetched — and again at
 * terraform_apply, where it is the last gate before resources are created.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { configurationFiles } from "../hcl.ts";

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "access_key", re: /access_key\s*=\s*"[^"]+"/ },
  { name: "secret_key", re: /secret_key\s*=\s*"[^"]+"/ },
  { name: "security_token", re: /security_token\s*=\s*"[^"]+"/ },
  { name: "password", re: /password\s*=\s*"[^"]+"/ },
];

export interface CredentialFinding {
  file: string;
  line: number;
  pattern: string;
}

/**
 * Scan every configuration file this deployment owns for plaintext credentials.
 *
 * The file set comes from {@link configurationFiles}, so it is the same one the
 * design tool reads and the digest hashes. That alignment is the point: a
 * module's `.tf` is compiled into the plan, so a credential written there is
 * exactly as exposed as one in the workspace root — and a scan that skipped it
 * while the digest counted it would be two readers disagreeing about what the
 * deployment is.
 *
 * ## Why the two syntaxes are scanned differently
 *
 * HCL writes an assignment as `key = "value"`, so a line pattern finds it. JSON
 * writes `"key": "value"`, where the same pattern matches nothing — the
 * separator and the quoting both differ, so a leak written in JSON is invisible
 * to a scan built for HCL. Verified: a line scan over a `.tf.json` holding an
 * `access_key` returned no findings.
 *
 * So a `.tf.json` is parsed and its string leaves inspected, comparing the KEY
 * rather than the line. That comparison is exact, which is also why it does not
 * need the HCL scan's `var.` exemption: a JSON value is either a string or a
 * reference object, never an expression that reads like one.
 *
 * @param dir - the deployment workspace directory.
 * @returns the findings, empty when the configuration is clean.
 */
export async function scanTfCredentials(dir: string): Promise<CredentialFinding[]> {
  const findings: CredentialFinding[] = [];
  for (const relPath of await configurationFiles(dir)) {
    let content: string;
    try {
      content = await readFile(join(dir, relPath), "utf8");
    } catch {
      // Unreadable is `validate_design`'s to report; a scan that threw here
      // would refuse an apply for a permission problem and call it a leak.
      continue;
    }
    if (relPath.endsWith(".tf.json")) {
      findings.push(...scanJson(content, relPath));
      continue;
    }
    const lines = content.split("\n");
    for (const [lineNum, line] of lines.entries()) {
      const trimmed = line.trim();
      // Skip comments (# or //) — HCL comment lines, not real assignments.
      if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
      // Skip var.xxx / data.xxx references — not plaintext.
      if (/=\s*(var\.|data\.)/.test(line)) continue;
      for (const { name, re } of PATTERNS) {
        if (re.test(line)) {
          findings.push({ file: relPath, line: lineNum + 1, pattern: name });
        }
      }
    }
  }
  return findings;
}

/**
 * Credentials written as JSON configuration.
 *
 * The value must be a non-empty string, because that is the only thing that can
 * be a literal secret: `{"access_key": {"ref": "var.x"}}` is a reference and
 * resolves at apply time, which is the case the HCL scan exempts too.
 *
 * The line number comes from the document's text, not from the parse: a
 * finding a reader cannot open is only half a finding, and JSON.parse gives no
 * positions. Searching for the key's own spelling locates it well enough for a
 * human to find the line, and a miss reports line 0 rather than a wrong one.
 *
 * @param content - the file's text.
 * @param file - its path, relative to the deployment.
 * @returns the findings.
 */
function scanJson(content: string, file: string): CredentialFinding[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    // A broken file is `validate_design`'s to report with a position; a scan
    // that refused here would call a syntax error a credential leak.
    return []
  }
  const lines = content.split('\n')
  const findings: CredentialFinding[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(key) && typeof inner === 'string' && inner.trim() !== '') {
        const line = lines.findIndex(entry => entry.includes(`"${key}"`))
        findings.push({ file, line: line === -1 ? 0 : line + 1, pattern: key })
      }
      visit(inner)
    }
  }
  visit(parsed)
  return findings
}

/**
 * The keys that must never hold a literal.
 *
 * Exact, not a pattern: a JSON key is a whole word, so `"access_key"` is a
 * secret and `"access_key_ref"` is not. Pattern-matching here would report the
 * second as the first.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'access_key',
  'secret_key',
  'security_token',
  'password',
])

/** Throw if any plaintext credential is found. */
export async function assertNoCredentials(dir: string): Promise<void> {
  const findings = await scanTfCredentials(dir);
  if (findings.length > 0) {
    const first = findings[0]!;
    throw new Error(
      `plaintext credential found in ${first.file}: line ${first.line} `
      + `(${first.pattern}). Remove the assignment: the terraform run receives its credentials `
      + 'from the environment, never from the configuration.',
    );
  }
}
