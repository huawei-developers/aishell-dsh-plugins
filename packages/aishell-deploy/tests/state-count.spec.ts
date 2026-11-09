/**
 * How many resources a deployment manages.
 *
 * The number guards two destructive operations: `terraform_destroy` refuses
 * when it is 0, and `delete_deployment` removes the workspace when it is 0. So
 * a wrong 0 is not a cosmetic error — it lets a workspace be deleted while the
 * cloud resources it manages stay up and unmanaged.
 *
 * Reading `terraform.tfstate` gave exactly that wrong 0 for a deployment with a
 * configured backend, because terraform writes state to the backend and leaves
 * no local file. Verified: `backend "local" { path = "custom.tfstate" }` puts
 * state in `custom.tfstate` and nothing in `terraform.tfstate`.
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { stateRecordedResourceCount } from '../src/deployment-state.ts'

/** Run the count over a temporary directory, with a stubbed terraform. */
async function count(
  files: Record<string, string>,
  lister: (dir: string, args: string[]) => Promise<{ exitCode: number, stdout: string }>,
): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'state-count-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content, 'utf8')
    }
    return await stateRecordedResourceCount(dir, lister)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('stateRecordedResourceCount', () => {
  it('asks terraform, so a remote backend is counted too', async () => {
    // No terraform.tfstate at all — the case a configured backend produces.
    const n = await count({}, () => Promise.resolve({
      exitCode: 0,
      stdout: 'huaweicloud_vpc.prod\nhuaweicloud_vpc_subnet.web\n',
    }))
    expect(n).toBe(2)
  })

  it('counts zero when the backend holds nothing', async () => {
    // `terraform state list` exits 0 with an empty listing for a workspace that
    // was never applied — the legitimate "nothing to destroy" answer.
    const n = await count({}, () => Promise.resolve({ exitCode: 0, stdout: '' }))
    expect(n).toBe(0)
  })

  it('counts an empty listing without counting a trailing newline', async () => {
    const n = await count({}, () => Promise.resolve({ exitCode: 0, stdout: '\n\n' }))
    expect(n).toBe(0)
  })

  it('falls back to the local state when terraform cannot answer', async () => {
    // No binary, or a broken backend. The local file is still the best evidence
    // available, and reporting 0 would unlock the destructive paths.
    const n = await count(
      { 'terraform.tfstate': JSON.stringify({ resources: [{}, {}] }) },
      () => Promise.resolve({ exitCode: 1, stdout: '' }),
    )
    expect(n).toBe(2)
  })

  it('reports zero when neither source has anything', async () => {
    const n = await count({}, () => Promise.resolve({ exitCode: 1, stdout: '' }))
    expect(n).toBe(0)
  })

  it('asks for `state list`, not a parse of a file it read itself', async () => {
    const seen: string[][] = []
    await count({}, (_dir, args) => {
      seen.push(args)
      return Promise.resolve({ exitCode: 0, stdout: 'a.b' })
    })
    expect(seen).toEqual([['state', 'list']])
  })
})