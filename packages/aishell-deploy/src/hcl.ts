/**
 * Reading HCL: resource blocks out of source text, and the values inside them.
 *
 * ## Why this is its own module
 *
 * Two readers need these: the topology derivation (which needs containment and
 * display facts) and the network checks (which need CIDRs and port lists).
 * Owning them in `topology` would make `network-checks` import back from the
 * module that imports it — a cycle, and a cycle in this pair is easy to
 * introduce and hard to notice, because both halves keep working until one of
 * them is loaded first.
 *
 * ## What the parser is
 *
 * `hcl2-parser` — Terraform's own HCL grammar compiled from Go. It is used
 * rather than a hand-written pattern because the alternative is a partial
 * parser whose gaps appear as missing boxes in a diagram, which reads as a
 * design decision rather than a bug. Measured against all 900 `.tf` files of
 * the provider's shipped examples: zero failures.
 *
 * Expressions are NOT evaluated. `${...}` is left exactly as written, because
 * terraform has not run and there is no value to report. What an expression
 * does carry is its references — `huaweicloud_vpc.prod.id` names a resource
 * that will exist — and those are what a diagram is built from.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/hcl
 */

import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The HCL parser, loaded through `createRequire`.
 *
 * `hcl2-parser` ships CommonJS with a hand-written `declare module` that
 * exports no types, so an ESM `import` would be a type error at the binding
 * and `any` at every call. Requiring it explicitly puts the untyped boundary
 * in one place, behind {@link parseHcl}, instead of spreading it to callers.
 */
const hclRequire = createRequire(import.meta.url)

/** One resource block, as the HCL parser reports it. */
export interface ResourceBlock {
  /** `type` from `resource "<type>" "<name>"`. */
  readonly type: string
  /** `name` from `resource "<type>" "<name>"`. */
  readonly name: string
  /** The block body, HCL-expression strings left as written (`${...}`). */
  readonly body: Record<string, unknown>
}

/**
 * Names that look like references but are not resources.
 *
 * HCL spells several different things with the same `a.b` shape: a variable
 * (`var.region`), a local (`local.prefix`), a data source (`data.x.y`), a
 * module output (`module.x.y`), and a few meta-arguments. Treating them as
 * resources would draw edges to boxes that will never exist, so they are
 * excluded by their leading keyword.
 */
const NON_RESOURCE_ROOTS = new Set([
  'var',
  'local',
  'data',
  'module',
  'each',
  'count',
  'path',
  'terraform',
  'self',
])

/**
 * A reference written in a body, e.g. `${huaweicloud_vpc.prod.id}`.
 *
 * ## Why the identifier class is Unicode, not ASCII
 *
 * HCL identifiers admit any letter, and this provider's users write Chinese
 * labels constantly — `resource "huaweicloud_vpc" "生产网络"`. Matching only
 * `[a-zA-Z_]` silently missed every such reference, so a subnet written as
 * `vpc_id = huaweicloud_vpc.生产网络.id` was drawn at the root, outside the VPC
 * it belongs to. Verified: the block parsed, the reference did not.
 *
 * `\p{L}` is the letter category of any script, and `\p{N}` joins it inside the
 * body of a name because HCL allows digits there. The `u` flag is what makes
 * `\p{...}` meaningful.
 */
const IDENTIFIER = String.raw`[\p{L}_][\p{L}\p{N}_-]*`
const REFERENCE_RE = new RegExp(
  String.raw`\$\{\s*(${IDENTIFIER})\.(${IDENTIFIER})(?:\.[\p{L}\p{N}_.-]*)?\s*\}`, 'gu',
)

/**
 * Pull every resource block out of one configuration file.
 *
 * Two syntaxes, both of which terraform reads:
 *
 *   - **HCL** (`.tf`) — parsed by the Go grammar.
 *   - **JSON** (`.tf.json`) — the same configuration in JSON form, which
 *     terraform validates and plans identically (verified: a `.tf.json` with a
 *     resource and a `.tf` with the provider block plan together).
 *
 * The JSON form uses the same shape the HCL parser produces, which is why one
 * extractor handles both: a resource is `{resource: {<type>: {<name>: <body>}}}`
 * with the body possibly wrapped in an array.
 *
 * Both syntaxes must be read, because terraform treats them as the same
 * configuration: it validates and plans a `.tf.json` identically, so a
 * deployment written that way is a design like any other and has to reach the
 * same readers. A reader that accepted only HCL would answer "nothing declared"
 * about a file terraform has just planned successfully.
 *
 * @param source - the text of one `.tf` or `.tf.json` file.
 * @returns the resource blocks it declares, in file order.
 * @throws when the text is not parseable, with a message about the
 *   configuration's syntax rather than about a byte offset in a string.
 */
export function parseResources(source: string): ResourceBlock[] {
  return resourcesOf(parseHcl(source))
}

/**
 * Pull every resource block out of JSON configuration text.
 *
 * Separate from {@link parseResources} because the failure mode differs: JSON
 * says where it broke, and a reader fixing it needs the file and the offset,
 * which the HCL parser cannot give.
 *
 * @param source - the text of one `.tf.json` file.
 * @returns the resource blocks it declares.
 * @throws when the text is not valid JSON.
 */
export function parseJsonResources(source: string): ResourceBlock[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(
      `the configuration is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the configuration is not a JSON object, so it declares no resources.')
  }
  return resourcesOf(parsed as Record<string, unknown>)
}

/**
 * The resource blocks of a parsed configuration tree, in either syntax.
 *
 * @param tree - the top-level block map.
 * @returns the blocks.
 */
function resourcesOf(tree: Record<string, unknown>): ResourceBlock[] {
  const blocks: ResourceBlock[] = []
  // The tree is one object keyed by top-level block type. A `resource` entry is
  // `{ resource: { <type>: { <name>: [ <body> ] } } }`.
  const resource = tree.resource
  if (resource !== null && typeof resource === 'object') {
    for (const [type, byName] of Object.entries(resource as Record<string, unknown>)) {
      if (byName === null || typeof byName !== 'object') continue
      for (const [name, bodies] of Object.entries(byName as Record<string, unknown>)) {
        // The parser wraps each block body in an array, because HCL allows the
        // same block key to repeat.
        const body = Array.isArray(bodies) ? bodies[0] : bodies
        if (body === null || typeof body !== 'object') continue
        blocks.push({ type, name, body: body as Record<string, unknown> })
      }
    }
  }
  return blocks
}

/**
 * Call the HCL parser, turning its failure mode into a message about the file.
 *
 * The parser returns `[tree, error]`. On success `tree` is the single top-level
 * object and `error` is `null`; on failure `tree` is `null` and `error` is an
 * object — an EMPTY one for every syntax error tried (unclosed brace, stray
 * semicolon, dangling operator), so it carries nothing worth reporting.
 *
 * What that means for the message: a null tree is a syntax error, and the
 * parser cannot say where. Saying so plainly is more useful than passing on an
 * empty object or a byte offset that points into a string with no filename.
 *
 * @param source - HCL text.
 * @returns the top-level block map.
 */
function parseHcl(source: string): Record<string, unknown> {
  const parser = hclRequire('hcl2-parser') as {
    parseToObject: (text: string) => [unknown, unknown]
  }
  let parsed: [unknown, unknown]
  try {
    parsed = parser.parseToObject(source)
  } catch (error) {
    // A thrown value means the parser itself broke, not the configuration.
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`the configuration could not be parsed (${detail.trim()}).`)
  }
  const [tree] = parsed
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) {
    throw new Error(
      'the configuration is not valid HCL. '
      + 'Check the braces, the quoting and any trailing operators, then try again — '
      + 'nothing was derived from a file that does not parse.',
    )
  }
  return tree as Record<string, unknown>
}

/**
 * Every reference one body makes to another resource.
 *
 * @param body - one resource block's body.
 * @returns referenced `type.name` addresses, deduplicated, in first-seen order.
 */
export function referencesOf(body: Record<string, unknown>): string[] {
  const seen = new Set<string>()
  for (const text of stringsIn(body)) {
    for (const address of addressesIn(text)) seen.add(address)
  }
  return [...seen]
}

/**
 * The first `type.name` written in a string, if any.
 *
 * @param text - one attribute value.
 * @returns the referenced address, or `undefined`.
 */
export function firstReference(text: string): string | undefined {
  return addressesIn(text)[0]
}

/**
 * Every `type.name` address written in one string.
 *
 * The regex is stateful (`/g`), so `matchAll` is used rather than `exec`: it
 * iterates without leaving `lastIndex` set for the next caller.
 *
 * @param text - one attribute value.
 * @returns the addresses, in order of appearance.
 */
function addressesIn(text: string): string[] {
  const addresses: string[] = []
  for (const match of text.matchAll(REFERENCE_RE)) {
    const [, type, name] = match
    if (type === undefined || name === undefined) continue
    if (NON_RESOURCE_ROOTS.has(type)) continue
    addresses.push(`${type}.${name}`)
  }
  return addresses
}

/**
 * The value of one body attribute, if it is a plain string.
 *
 * Only plain strings are returned. An expression (`${...}`, `var.x`,
 * `local.y`) has no value this module can know — terraform has not run — so it
 * is reported as `undefined` rather than rendered as the expression text, which
 * a reader would mistake for the deployed value.
 *
 * @param body - one resource block's body.
 * @param key - the attribute name.
 * @returns the literal value, or `undefined`.
 */
export function literalOf(body: Record<string, unknown>, key: string): string | undefined {
  const raw = body[key]
  if (typeof raw === 'string' && !raw.includes('${') && raw !== '') return raw
  return undefined
}

/**
 * Every string contained anywhere in a value, including nested collections.
 *
 * @param value - any parsed body value.
 * @returns the strings it contains, in traversal order.
 */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(stringsIn)
  }
  return []
}
/**
 * Every resource block a directory's `.tf` files declare, including its modules.
 *
 * ## What counts as this deployment's configuration
 *
 * A `.tf` file directly in the workspace, and any file under a **local module
 * directory** that the configuration calls. Nothing else.
 *
 * That boundary is not a guess: terraform records its own resolution in
 * `<dir>/.terraform/modules/modules.json`, which names each module's `Source`
 * and the `Dir` it was unpacked into. A local module (`source = "./modules/net"`)
 * unpacks to a directory that is part of the workspace — editing it changes the
 * plan, verified — so its resources belong to the design. A remote module
 * unpacks under `.terraform/modules/`, which is where terraform keeps
 * downloaded artifacts, and its content is a dependency rather than part of
 * what this deployment wrote.
 *
 * Reading only `modules.json`'s local entries also settles the case a recursive
 * directory walk gets wrong: a `modules/` folder holding something nothing
 * references is not part of the configuration, and neither is a vendored copy
 * of an unrelated module.
 *
 * ## Why all callers share it
 *
 * The design tool, the design gate, the spec check, the configuration digest and
 * the plaintext-credential scan each ask "what does this deployment declare",
 * for their own reasons. When they answer differently the disagreement is
 * silent: a design gate that sees no network in a configuration whose resources
 * live in a module refuses an apply that `terraform validate` has already
 * passed. So the boundary is decided once, here.
 *
 * ## What it does NOT recurse into
 *
 * `.terraform/` is skipped wholesale. That is where providers, downloaded
 * modules and the state live — none of it is authored configuration, and the
 * digest already excludes it.
 *
 * @param directory - the deployment workspace directory.
 * @returns every parsed block, and the files that could not be parsed.
 */
export async function parseConfiguration(
  directory: string,
): Promise<{ readonly blocks: readonly ResourceBlock[], readonly unparsed: readonly string[] }> {
  const blocks: ResourceBlock[] = []
  const unparsed: string[] = []
  for (const rel of await configurationFiles(directory)) {
    let source: string
    try {
      source = await readFile(join(directory, rel), 'utf8')
    } catch {
      unparsed.push(rel)
      continue
    }
    try {
      blocks.push(...(rel.endsWith('.tf.json') ? parseJsonResources(source) : parseResources(source)))
    } catch {
      unparsed.push(rel)
    }
  }
  return { blocks, unparsed }
}

/**
 * Every `.tf` file that belongs to a deployment, as paths relative to it.
 *
 * Sorted, so two runs agree on order. A directory that does not exist yields an
 * empty list rather than throwing: callers treat "nothing declared" as a normal
 * answer, and an absent directory is the state before `create_deployment`.
 *
 * @param directory - the deployment workspace directory.
 * @returns the relative paths, workspace files first, then local modules'.
 */
export async function configurationFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }

  const files = entries
    .filter(entry => entry.isFile() && isConfigurationFile(entry.name))
    .map(entry => entry.name)

  // Sequential on purpose, like the file reads below: a deployment has a
  // handful of modules, and opening them at once buys nothing while making the
  // failure order unpredictable.
  for (const moduleDir of await localModuleDirs(directory)) {
    let inner
    try {
      inner = await readdir(join(directory, moduleDir), { withFileTypes: true })
    } catch {
      continue
    }
    files.push(...inner
      .filter(entry => entry.isFile() && isConfigurationFile(entry.name))
      .map(entry => `${moduleDir}/${entry.name}`))
  }
  return files.sort()
}

/**
 * The directories terraform unpacked LOCAL modules into.
 *
 * Read from `.terraform/modules/modules.json`, which is terraform's own record
 * of what it resolved — see the note on {@link parseConfiguration}. When that
 * file is absent (no `terraform_init` yet) the answer is empty: an
 * uninitialised deployment has no modules to read, and guessing paths from
 * `source = "..."` strings would be a second, disagreeing resolver.
 *
 * A remote module's `Dir` points under `.terraform/`, and is excluded here by
 * construction rather than by name: anything outside the workspace is not this
 * deployment's configuration.
 *
 * @param directory - the deployment workspace directory.
 * @returns workspace-relative directory names, deduplicated.
 */
async function localModuleDirs(directory: string): Promise<string[]> {
  let raw: string
  try {
    raw = await readFile(join(directory, '.terraform', 'modules', 'modules.json'), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const modules = (parsed as { Modules?: unknown }).Modules
  if (!Array.isArray(modules)) return []

  const dirs = new Set<string>()
  for (const entry of modules) {
    if (entry === null || typeof entry !== 'object') continue
    const dir = (entry as { Dir?: unknown }).Dir
    if (typeof dir !== 'string' || dir === '' || dir === '.') continue
    // A downloaded module lands under `.terraform/`; a local one is a plain
    // relative path inside the workspace.
    const normalised = dir.replace(/\\/g, '/').replace(/^\.\//, '')
    if (normalised.startsWith('../') || normalised.startsWith('/')) continue
    if (normalised === '.terraform' || normalised.startsWith('.terraform/')) continue
    dirs.add(normalised)
  }
  return [...dirs].sort()
}

/**
 * Whether a file name is terraform configuration.
 *
 * Both syntaxes terraform reads: `.tf` (HCL) and `.tf.json` (the JSON form). A
 * `.tfvars` or `.tfvars.json` is NOT — those carry values for variables, not
 * resources, and reading them as configuration would put their contents into
 * the digest and the credential scan as if they were authored resources.
 *
 * @param name - a file's base name.
 * @returns whether it declares configuration.
 */
export function isConfigurationFile(name: string): boolean {
  return name.endsWith('.tf') || name.endsWith('.tf.json')
}
