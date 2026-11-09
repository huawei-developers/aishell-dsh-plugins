/**
 * What counts as a deployment's configuration.
 *
 * Four readers ask that question — the design tool, the design gate, the spec
 * check and the configuration digest — and when they answered differently the
 * disagreement was silent. A design written in a local module produced:
 *
 *   - `validate_design` → "the .tf files declare no resource blocks"
 *   - the design gate    → "the .tf files declare no network resources"
 *   - the digest         → a hash that DID change when the module was edited
 *   - the credential scan → a scan that DID find credentials in the module
 *
 * The last two were recursive over every directory; the first two read only the
 * workspace root. So an apply could be refused as "no network" for a
 * configuration whose network lived in a module.
 *
 * ## Why the boundary is terraform's, not a directory walk
 *
 * `<dir>/.terraform/modules/modules.json` is terraform's own record of what it
 * resolved: each module's `Source` and the `Dir` it was unpacked into. A local
 * module (`source = "./modules/net"`) unpacks inside the workspace, so editing
 * it changes the plan — verified — and its resources are part of the design. A
 * remote module unpacks under `.terraform/`, which is downloaded artifact, not
 * authored configuration.
 *
 * A plain recursive walk gets both wrong: it would read a `modules/` folder
 * nothing references, and skip nothing that a downloaded module left behind
 * outside `.terraform/`.
 */

import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configurationFiles, parseConfiguration } from '../src/hcl.ts'
import { computeTfHash } from '../src/utils/hash.ts'
import { scanTfCredentials } from '../src/gates/credential_gate.ts'

/** A workspace holding `files`, written as relative path → content. */
async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'config-files-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return dir
}

/** terraform's module record, as `terraform init` writes it. */
function modulesJson(entries: { Key: string, Source: string, Dir: string }[]): string {
  return JSON.stringify({ Modules: entries })
}

const VPC = `
resource "huaweicloud_vpc" "prod" {
  cidr = "10.0.0.0/16"
}
`

describe('configurationFiles', () => {
  it('reads the workspace root when there are no modules', async () => {
    const dir = await workspace({ 'main.tf': VPC, 'other.tf': '# nothing' })
    try {
      expect(await configurationFiles(dir)).toEqual(['main.tf', 'other.tf'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads the .tf of a local module, which terraform unpacked in the workspace', async () => {
    const dir = await workspace({
      'main.tf': 'module "net" {\n  source = "./modules/net"\n}\n',
      'modules/net/vpc.tf': VPC,
      '.terraform/modules/modules.json': modulesJson([
        { Key: '', Source: '', Dir: '.' },
        { Key: 'net', Source: './modules/net', Dir: 'modules/net' },
      ]),
    })
    try {
      expect(await configurationFiles(dir)).toEqual(['main.tf', 'modules/net/vpc.tf'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves out a module terraform downloaded', async () => {
    // A remote module lands under `.terraform/`, which is a downloaded artifact
    // rather than something this deployment wrote. Reading it would make the
    // digest depend on what terraform fetched.
    const dir = await workspace({
      'main.tf': 'module "remote" {\n  source = "some/registry/module"\n}\n',
      '.terraform/modules/modules.json': modulesJson([
        { Key: '', Source: '', Dir: '.' },
        { Key: 'remote', Source: 'some/registry/module', Dir: '.terraform/modules/remote' },
      ]),
      '.terraform/modules/remote/main.tf': 'resource "huaweicloud_vpc" "theirs" {}\n',
    })
    try {
      expect(await configurationFiles(dir)).toEqual(['main.tf'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves out a directory nothing references', async () => {
    // A vendored copy of something the configuration does not call is not part
    // of the plan, so drawing or hashing it would describe a different design.
    const dir = await workspace({
      'main.tf': VPC,
      'modules/unused/vpc.tf': 'resource "huaweicloud_vpc" "stray" {}\n',
    })
    try {
      expect(await configurationFiles(dir)).toEqual(['main.tf'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads only the root before terraform has run', async () => {
    // No `modules.json` means no `terraform_init`. Deriving module paths from
    // `source = "..."` strings would be a second resolver that can disagree
    // with terraform's own.
    const dir = await workspace({
      'main.tf': 'module "net" {\n  source = "./modules/net"\n}\n',
      'modules/net/vpc.tf': VPC,
    })
    try {
      expect(await configurationFiles(dir)).toEqual(['main.tf'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('survives a malformed modules.json', async () => {
    const dir = await workspace({
      'main.tf': VPC,
      '.terraform/modules/modules.json': '{ not json',
    })
    try {
      expect(await configurationFiles(dir)).toEqual(['main.tf'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a Dir that escapes the workspace', async () => {
    // A hand-edited record naming `../elsewhere` would otherwise let a
    // deployment read files outside itself, and hash or scan them.
    const dir = await workspace({
      'main.tf': VPC,
      '.terraform/modules/modules.json': modulesJson([
        { Key: '', Source: '', Dir: '.' },
        { Key: 'bad', Source: '../evil', Dir: '../evil' },
      ]),
    })
    try {
      expect(await configurationFiles(dir)).toEqual(['main.tf'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns nothing for a directory that does not exist', async () => {
    expect(await configurationFiles('/nonexistent/deploy/xyz')).toEqual([])
  })
})

describe('the four readers agree about a module-based deployment', () => {
  /** A deployment whose whole network lives in a local module. */
  async function moduleDeployment(): Promise<string> {
    return await workspace({
      'main.tf': 'module "net" {\n  source = "./modules/net"\n}\n',
      'modules/net/vpc.tf': VPC,
      '.terraform/modules/modules.json': modulesJson([
        { Key: '', Source: '', Dir: '.' },
        { Key: 'net', Source: './modules/net', Dir: 'modules/net' },
      ]),
    })
  }

  it('the parser finds the resources the module declares', async () => {
    const dir = await moduleDeployment()
    try {
      const { blocks } = await parseConfiguration(dir)
      expect(blocks.map(block => `${block.type}.${block.name}`))
        .toEqual(['huaweicloud_vpc.prod'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the digest changes when the module is edited', async () => {
    const dir = await moduleDeployment()
    try {
      const before = await computeTfHash(dir)
      await writeFile(join(dir, 'modules', 'net', 'vpc.tf'), `${VPC}\n# edited\n`, 'utf8')
      expect(await computeTfHash(dir)).not.toBe(before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the credential scan finds a secret written in the module', async () => {
    // It compiles into the plan, so it is exactly as exposed as one in the root.
    const dir = await moduleDeployment()
    try {
      await writeFile(join(dir, 'modules', 'net', 'vpc.tf'),
        'resource "huaweicloud_vpc" "prod" {\n  access_key = "AKIAEXAMPLE"\n}\n', 'utf8')
      const findings = await scanTfCredentials(dir)
      expect(findings).toHaveLength(1)
      expect(findings[0]?.file).toBe('modules/net/vpc.tf')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('the module path is reported relative to the workspace', async () => {
    // A finding names the file a reader has to open, and that path is relative
    // to the deployment — not absolute, and not truncated to a bare basename.
    const dir = await moduleDeployment()
    try {
      await writeFile(join(dir, 'modules', 'net', 'vpc.tf'),
        'resource "huaweicloud_vpc" "prod" {\n  password = "hunter2"\n}\n', 'utf8')
      expect((await scanTfCredentials(dir))[0]?.file).toBe('modules/net/vpc.tf')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
describe('the JSON syntax terraform also reads', () => {
  const VPC_JSON = JSON.stringify({
    resource: { huaweicloud_vpc: { fromJson: { cidr: '10.0.0.0/16' } } },
  }, null, 2)

  it('is configuration, so the file set includes it', async () => {
    // terraform validates and plans a `.tf.json` exactly like the HCL form
    // (verified), so leaving it out of this set made a deployment written that
    // way invisible to every reader at once.
    const dir = await workspace({ 'main.tf': VPC, 'extra.tf.json': VPC_JSON })
    try {
      expect(await configurationFiles(dir)).toEqual(['extra.tf.json', 'main.tf'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is parsed, so its resources are drawn', async () => {
    const dir = await workspace({ 'main.tf': VPC, 'extra.tf.json': VPC_JSON })
    try {
      const { blocks, unparsed } = await parseConfiguration(dir)
      expect(unparsed).toEqual([])
      // The JSON one is found at all, which is what was broken.
      expect(blocks.map(block => `${block.type}.${block.name}`))
        .toEqual(['huaweicloud_vpc.fromJson', 'huaweicloud_vpc.prod'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is not a variable file: tfvars stays out', async () => {
    // `terraform.tfvars` carries values for variables, not resources. Hashing
    // or scanning it would treat an authored value as configuration.
    const dir = await workspace({
      'main.tf': VPC,
      'terraform.tfvars': 'x = 1',
      'terraform.tfvars.json': '{"x": 1}',
    })
    try {
      expect(await configurationFiles(dir)).toEqual(['main.tf'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('counts in the digest, so an edit invalidates the gates', async () => {
    const dir = await workspace({ 'main.tf': VPC, 'extra.tf.json': VPC_JSON })
    try {
      const before = await computeTfHash(dir)
      await writeFile(join(dir, 'extra.tf.json'), JSON.stringify({
        resource: { huaweicloud_vpc: { fromJson: { cidr: '10.9.0.0/16' } } },
      }), 'utf8')
      expect(await computeTfHash(dir)).not.toBe(before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is scanned for plaintext credentials, which a line pattern misses', async () => {
    // HCL writes `key = "value"`, JSON writes `"key": "value"`. A line pattern
    // built for the first matches nothing in the second — verified: the scan
    // returned clean for a file that held an access key.
    const dir = await workspace({
      'leaky.tf.json': JSON.stringify({
        resource: { huaweicloud_vpc: { prod: { cidr: '10.0.0.0/16', access_key: 'AKIAEXAMPLE' } } },
      }, null, 2),
    })
    try {
      const findings = await scanTfCredentials(dir)
      expect(findings).toHaveLength(1)
      expect(findings[0]?.pattern).toBe('access_key')
      // A reader has to be able to open the line.
      expect(findings[0]?.line).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not mistake a differently-named key for a secret', async () => {
    // A JSON key is a whole word: `access_key_ref` is a variable reference,
    // not a literal.
    const dir = await workspace({
      'ok.tf.json': JSON.stringify({
        resource: { huaweicloud_vpc: { prod: { access_key_ref: 'var.x' } } },
      }),
    })
    try {
      expect(await scanTfCredentials(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a broken JSON file as unparsed rather than as no resources', async () => {
    const dir = await workspace({ 'broken.tf.json': '{ "resource": ' })
    try {
      const { blocks, unparsed } = await parseConfiguration(dir)
      expect(blocks).toEqual([])
      expect(unparsed).toEqual(['broken.tf.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
