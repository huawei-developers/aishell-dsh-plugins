/**
 * The terraform binary a deployment was told to use.
 *
 * `terraform_install` accepts a `terraform_path` and reports it in its result.
 * Before this was recorded, that path was validated, echoed back, and dropped:
 * the next `terraform_plan` failed with "terraform not found", which is the
 * least useful answer to a call that had just reported success.
 *
 * The record lives under the host's data directory, so these tests point
 * `DSH_HOME` at a temp directory and never touch the real one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A directory the host's state can be written into. */
let home: string
let originalHome: string | undefined
let originalPath: string | undefined
let originalTerraformPath: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'deploy-home-'))
  originalHome = process.env['DSH_HOME']
  originalPath = process.env['PATH']
  originalTerraformPath = process.env['HW_TERRAFORM_PATH']
  process.env['DSH_HOME'] = home
  // An empty PATH keeps a real terraform on the developer's machine from
  // answering the search, so the fallback order is what the test exercises.
  process.env['PATH'] = home
  delete process.env['HW_TERRAFORM_PATH']
})

afterEach(async () => {
  for (const [name, value] of [
    ['DSH_HOME', originalHome],
    ['PATH', originalPath],
    ['HW_TERRAFORM_PATH', originalTerraformPath],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(home, { recursive: true, force: true })
})

describe('recorded binary path', () => {
  it('writes the path where the resolver looks for it', async () => {
    const { recordBinaryPath } = await import('../src/gates/terraform_env.ts')
    const { terraformPathRecord } = await import('../src/data-paths.ts')

    await recordBinaryPath('/opt/terraform/terraform')

    expect((await readFile(terraformPathRecord(), 'utf8')).trim()).toBe('/opt/terraform/terraform')
  })

  it('resolves the recorded binary when nothing else answers', async () => {
    const { recordBinaryPath, resolveTerraformEnv } = await import('../src/gates/terraform_env.ts')
    const { terraformPathRecord } = await import('../src/data-paths.ts')

    // A real executable at the recorded path, so the resolver's own file check
    // passes rather than the test asserting a string round trip.
    const binary = join(home, 'mine')
    await writeFile(binary, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(binary, 0o755)
    await recordBinaryPath(binary)

    const resolved = await resolveTerraformEnv(home)
    expect(resolved.binary).toBe(binary)
    // The record is a path, not a secret: `terraformPathRecord` is a file name
    // the resolver owns, and nothing derived from credentials lives beside it.
    expect(terraformPathRecord()).toContain('binary-path')
  })

  it('ignores a recorded path that no longer exists', async () => {
    const { recordBinaryPath, resolveTerraformEnv } = await import('../src/gates/terraform_env.ts')

    await recordBinaryPath(join(home, 'deleted-binary'))

    // Falling back is better than failing: the message the caller gets then
    // names terraform_install, which is the action that fixes it.
    await expect(resolveTerraformEnv(home)).rejects.toThrow(/terraform not found/)
  })

  it('lets HW_TERRAFORM_PATH win over a recorded path', async () => {
    // An operator's environment variable is explicit configuration and outranks
    // whatever a previous tool call recorded.
    const { recordBinaryPath, resolveTerraformEnv } = await import('../src/gates/terraform_env.ts')

    const recorded = join(home, 'recorded')
    const fromEnv = join(home, 'from-env')
    for (const path of [recorded, fromEnv]) {
      await writeFile(path, '#!/bin/sh\nexit 0\n', 'utf8')
      await chmod(path, 0o755)
    }
    await recordBinaryPath(recorded)
    process.env['HW_TERRAFORM_PATH'] = fromEnv

    const resolved = await resolveTerraformEnv(home)
    expect(resolved.binary).toBe(fromEnv)
  })
})
describe('TF_CLI_CONFIG_FILE is absolute, whatever the caller passed', () => {
  let cwdBefore: string
  let envRcBefore: string | undefined
  beforeEach(async () => {
    cwdBefore = process.cwd()
    envRcBefore = process.env['TF_CLI_CONFIG_FILE']
    delete process.env['TF_CLI_CONFIG_FILE']
    // The outer suite points PATH at the temp home to exercise the search
    // order; these cases are about path resolution and only need a binary to
    // resolve, so a stub goes where that PATH already looks.
    const stub = join(home, 'terraform')
    await writeFile(stub, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(stub, 0o755)
  })
  afterEach(() => {
    process.chdir(cwdBefore)
    if (envRcBefore === undefined) delete process.env['TF_CLI_CONFIG_FILE']
    else process.env['TF_CLI_CONFIG_FILE'] = envRcBefore
  })

  it('resolves a relative deployment before handing it to the child', async () => {
    // The failure this prevents: the subprocess runs with `cwd` set to the
    // deployment and resolves TF_CLI_CONFIG_FILE against THAT directory. A
    // relative value therefore becomes `<deployment>/<deployment>/.terraformrc`
    // — a file that cannot exist. Verified before the fix: init warned "Unable
    // to open CLI configuration file", and the provider mirror silently never
    // applied.
    const parent = await mkdtemp(join(tmpdir(), 'rc-rel-'))
    try {
      const dep = join(parent, 'huawei-topology')
      await (await import('node:fs/promises')).mkdir(dep, { recursive: true })
      await writeFile(join(dep, '.terraformrc'), 'provider_installation {\n  direct {}\n}\n', 'utf8')
      process.chdir(parent)

      const { resolveTerraformEnv } = await import('../src/gates/terraform_env.ts')
      const resolved = await resolveTerraformEnv('huawei-topology')

      expect(resolved.env['TF_CLI_CONFIG_FILE']).toBe(join(dep, '.terraformrc'))
      // Absolute is the property, not the exact spelling.
      expect(resolved.env['TF_CLI_CONFIG_FILE']?.startsWith('/')).toBe(true)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('absolutizes a TF_CLI_CONFIG_FILE inherited from the environment', async () => {
    // The same hazard applies to the operator's value: it is read by the
    // parent but resolved by the child.
    const parent = await mkdtemp(join(tmpdir(), 'rc-env-'))
    const saved = process.env['TF_CLI_CONFIG_FILE']
    try {
      await writeFile(join(parent, 'custom.rc'), 'provider_installation {\n  direct {}\n}\n', 'utf8')
      process.chdir(parent)
      process.env['TF_CLI_CONFIG_FILE'] = 'custom.rc'

      const { resolveTerraformEnv } = await import('../src/gates/terraform_env.ts')
      const resolved = await resolveTerraformEnv(home)

      expect(resolved.env['TF_CLI_CONFIG_FILE']).toBe(join(parent, 'custom.rc'))
    } finally {
      if (saved === undefined) delete process.env['TF_CLI_CONFIG_FILE']
      else process.env['TF_CLI_CONFIG_FILE'] = saved
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('skips the deployment entirely when none was named', async () => {
    // `terraform_install` can run before any workspace exists; the search must
    // still work, and no CLI file is involved.
    const { resolveTerraformEnv } = await import('../src/gates/terraform_env.ts')
    const resolved = await resolveTerraformEnv(undefined)
    expect(resolved.env['TF_CLI_CONFIG_FILE']).toBeUndefined()
  })
})

describe('where a download lands, and whether the search finds it', () => {
  let savedHome: string | undefined
  let savedPath: string | undefined
  let savedTf: string | undefined

  beforeEach(() => {
    savedHome = process.env['DSH_HOME']
    savedPath = process.env['PATH']
    savedTf = process.env['HW_TERRAFORM_PATH']
    delete process.env['HW_TERRAFORM_PATH']
  })
  afterEach(() => {
    for (const [k, v] of [
      ['DSH_HOME', savedHome], ['PATH', savedPath], ['HW_TERRAFORM_PATH', savedTf],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('finds a binary in the temporary cache the download falls back to', async () => {
    // The seam that makes the fallback real: `terraform_install` writes into
    // the temp cache when the host cache is read-only, and `resolveBinary` has
    // to look there. Without the second half, an install would report success
    // and every later call would report no terraform.
    const scratch = await mkdtemp(join(tmpdir(), 'tfcache-'))
    const tempCache = join(tmpdir(), 'aishell-terraform')
    const binary = join(tempCache, 'terraform-0.0.0-spec')
    try {
      process.env['DSH_HOME'] = scratch
      process.env['PATH'] = scratch
      await mkdir(tempCache, { recursive: true })
      await writeFile(binary, '#!/bin/sh\nexit 0\n', 'utf8')
      await chmod(binary, 0o755)

      const { resolveTerraformEnv } = await import('../src/gates/terraform_env.ts')
      expect((await resolveTerraformEnv(scratch)).binary).toBe(binary)
    } finally {
      await rm(binary, { force: true })
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('prefers the host cache over the temporary one', async () => {
    // The temp cache is the fallback; a writable host cache is the ordinary
    // case and must win, or every process would read a copy that outlives its
    // usefulness.
    const scratch = await mkdtemp(join(tmpdir(), 'tfcache-'))
    const tempCache = join(tmpdir(), 'aishell-terraform')
    const tempBinary = join(tempCache, 'terraform-0.0.0-spec2')
    const hostBinary = join(scratch, 'terraform', 'bin', 'terraform-9.9.9')
    try {
      process.env['DSH_HOME'] = scratch
      process.env['PATH'] = scratch
      await mkdir(tempCache, { recursive: true })
      await writeFile(tempBinary, '#!/bin/sh\nexit 0\n', 'utf8')
      await chmod(tempBinary, 0o755)
      await mkdir(join(scratch, 'terraform', 'bin'), { recursive: true })
      await writeFile(hostBinary, '#!/bin/sh\nexit 0\n', 'utf8')
      await chmod(hostBinary, 0o755)

      const { resolveTerraformEnv } = await import('../src/gates/terraform_env.ts')
      expect((await resolveTerraformEnv(scratch)).binary).toBe(hostBinary)
    } finally {
      await rm(tempBinary, { force: true })
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
