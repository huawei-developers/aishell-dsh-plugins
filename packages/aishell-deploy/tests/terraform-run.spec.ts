/**
 * The terraform runner: what it reports when the process is killed.
 *
 * The bug this pins was silent and in the worst direction. A process killed by
 * a signal has no exit code — `code` is `null` — and mapping that to `0` made
 * every caller treat a killed run as a success:
 *
 *   - `terraform_apply` stamped the cost record and reported the deployment up
 *     after a timeout killed it;
 *   - `terraform_destroy` reported `resources_destroyed` for a teardown that
 *     never completed.
 *
 * Measured before the fix: `spawn('sleep 30')` then SIGTERM gave
 * `code: null, signal: SIGTERM`, and the runner reported `exitCode: 0`.
 *
 * These run the real binary through `runTerraform`, with `terraform_path`-style
 * resolution bypassed by pointing the env at a shell script.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fake terraform binary, at a path `HW_TERRAFORM_PATH` can name. */
async function fakeBinary(script: string): Promise<{ dir: string, path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tf-run-'))
  const path = join(dir, 'terraform')
  await writeFile(path, `#!/bin/sh\n${script}\n`, 'utf8')
  await chmod(path, 0o755)
  return { dir, path }
}

const scratch: string[] = []
const original = process.env['HW_TERRAFORM_PATH']

afterEach(async () => {
  if (original === undefined) delete process.env['HW_TERRAFORM_PATH']
  else process.env['HW_TERRAFORM_PATH'] = original
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('runTerraform — how a process death is reported', () => {
  it('reports a non-zero exit when the process ends by itself with a status', async () => {
    const { dir, path } = await fakeBinary('echo boom >&2; exit 3')
    scratch.push(dir)
    process.env['HW_TERRAFORM_PATH'] = path

    const { runTerraform } = await import('../src/terraform-run.ts')
    const result = await runTerraform(dir, ['version'])

    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('boom')
  })

  it('reports a failure, not a success, when the process kills itself', async () => {
    // SIGKILL cannot be caught, so this is a death by signal and not an exit
    // status — exactly the shape the timeout produces.
    const { dir, path } = await fakeBinary('kill -9 $$')
    scratch.push(dir)
    process.env['HW_TERRAFORM_PATH'] = path

    const { runTerraform } = await import('../src/terraform-run.ts')
    const result = await runTerraform(dir, ['version'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/terminated by SIGKILL/)
  })

  it('says why the process was terminated', async () => {
    // The caller shows this text, so a timeout has to be distinguishable from a
    // crash: "terminated by SIGTERM" alone does not say whose decision it was.
    const { dir, path } = await fakeBinary('kill -TERM $$')
    scratch.push(dir)
    process.env['HW_TERRAFORM_PATH'] = path

    const { runTerraform } = await import('../src/terraform-run.ts')
    const result = await runTerraform(dir, ['version'])

    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toMatch(/SIGTERM/)
  })

  it('keeps a successful run successful', async () => {
    const { dir, path } = await fakeBinary('echo fine; exit 0')
    scratch.push(dir)
    process.env['HW_TERRAFORM_PATH'] = path

    const { runTerraform } = await import('../src/terraform-run.ts')
    const result = await runTerraform(dir, ['version'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('fine')
  })
})