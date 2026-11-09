/**
 * Aggregate generator behavior.
 *
 * What these pin: the manifest's `disable` and `override` sections render as
 * id-targeted rows after the insert groups. The `disable` list was lost once
 * (a manifest rewrite in a rename commit dropped it, and the aggregate check
 * then passed because the generator had lost the feature too) — these tests
 * exist so a generator or manifest regression of that shape fails loudly
 * instead of shipping a bundle whose upstream rows stay live.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'aggregate.mjs')

/** Run the generator against a synthetic packages tree and return its patch. */
function generate(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'aggregate-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, 'packages', path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    execFileSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' })
    return readFileSync(join(root, 'packages', 'base', 'cordis.patch.yml'), 'utf8')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Run the generator in-tree and return its combined exit + output. */
function runInTree(files: Record<string, string>): { status: number, output: string } {
  const root = mkdtempSync(join(tmpdir(), 'aggregate-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, 'packages', path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    const output = execFileSync(process.execPath, [SCRIPT, '--root', root], {
      encoding: 'utf8', stdio: 'pipe',
    })
    return { status: 0, output }
  } catch (error) {
    const failure = error as { status: number, stdout: string, stderr: string }
    return { status: failure.status, output: `${failure.stdout}\n${failure.stderr}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** A minimal aggregate child package the generator can read. */
const CHILD_MANIFEST = JSON.stringify({
  name: '@huaweidevtools/aishell-dsh-x', version: '0.0.0', main: 'lib/index.js',
}, undefined, 2)

const CHILD_PATCH = `# comment
- insert:
    - id: x
      name: '@huaweidevtools/aishell-dsh-x'
`

/** One synthetic tree with the given manifest body. */
function tree(manifest: string): Record<string, string> {
  return {
    'base/aggregate.yml': manifest,
    'base/package.json': '{"name":"base","version":"0.0.0","dependencies":{}}',
    'child/package.json': CHILD_MANIFEST,
    'child/cordis.patch.yml': CHILD_PATCH,
  }
}

describe('aggregate generator — upstream row handling', () => {
  it('renders manifest disable entries as id-targeted disabled rows', () => {
    const patch = generate(tree('patchFrom:\n  - ../child\ndeps:\n  - ../child\ndisable:\n  - llm-deepseek\n'))
    expect(patch).toContain('- id: llm-deepseek\n  disabled: true')
  })

  it('renders manifest override entries as id-targeted config rows', () => {
    const patch = generate(tree('patchFrom:\n  - ../child\ndeps:\n  - ../child\n'
      + 'override:\n  - agent-default-model: { provider: aishell, model: glm-5.3-flash }\n'))
    expect(patch).toContain('- id: agent-default-model\n  config: { provider: aishell, model: glm-5.3-flash }')
  })

  it('rejects a disable entry colliding with an inserted row id', () => {
    const { status, output } = runInTree(tree('patchFrom:\n  - ../child\ndeps:\n  - ../child\ndisable:\n  - aishell-x\n'))
    expect(status).not.toBe(0)
    expect(output).toContain('disable id collides')
  })

  it('rejects a malformed override entry rather than rendering junk', () => {
    const { status, output } = runInTree(tree('patchFrom:\n  - ../child\ndeps:\n  - ../child\noverride:\n  - no-colon-here\n'))
    expect(status).not.toBe(0)
    expect(output).toContain('override entry is not')
  })

  it('emits no upstream-row sections when the manifest carries none', () => {
    const patch = generate(tree('patchFrom:\n  - ../child\ndeps:\n  - ../child\n'))
    expect(patch).not.toContain('disabled: true')
    expect(patch).not.toContain('# overridden upstream rows')
  })
})

describe('aggregate generator — the real aishell-base manifest', () => {
  it('keeps the DeepSeek identity rows disabled and the default model on aishell', () => {
    // The regression this guards against: a manifest rewrite that drops the
    // disable list leaves the official providers live in the composed profile
    // while our override points the default elsewhere.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const patch = readFileSync(join(repoRoot, 'packages/aishell-base/cordis.patch.yml'), 'utf8')
    for (const id of ['deepseek-account', 'account-controller', 'ui-settings-account', 'llm-deepseek', 'llm-deepseek-account']) {
      expect(patch).toContain(`- id: ${id}\n  disabled: true`)
    }
    // The reserved alias, not a real gateway model id: the selection is read
    // through a synchronous Config getter that cannot await the gateway's
    // catalog, so a literal id would couple every fresh session to one
    // catalog entry and break them all the day that entry is dropped.
    expect(patch).toContain('- id: agent-default-model\n  config: { provider: aishell, model: trial }')
  })

  it('points session feedback at the AI Shell collector without dropping any config', () => {
    // Two independent regressions this guards against:
    //
    //   1. A patch replaces a row's `config` wholesale (`target[key] = value`
    //      in dsh-app-boot's applyEntryPatches), so any key omitted from this
    //      line is silently lost. The dangerous one is `processor`: dropping
    //      it turns batching off and sends every record in its own request.
    //   2. Replacing either `!!js` escape with a literal would make that env
    //      var silently stop working — the deployment could no longer repoint
    //      the collector or switch to DISABLED without a new bundle.
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const patch = readFileSync(join(repoRoot, 'packages/aishell-base/cordis.patch.yml'), 'utf8')

    expect(patch).toContain('- id: session-telemetry-otel')

    // Every key the official row carries must survive the override.
    for (const key of [
      'mode:', 'shutdownTimeoutMillis:', 'maxRequestBytes:',
      'exporter:', 'url:', 'compression:', 'timeoutMillis:',
      'processor:', 'scheduledDelayMillis:', 'maxQueueSize:',
      'maxExportBatchSize:', 'exportTimeoutMillis:',
    ]) {
      expect(patch).toContain(key)
    }

    // The endpoint itself.
    expect(patch).toContain('https://public.aishell.openbuildlab.com/feedback')

    // Both switches stay expressions, not literals.
    expect(patch).toContain('!!js process.env.DSH_TELEMETRY_MODE')
    expect(patch).toContain('!!js process.env.DSH_TELEMETRY_OTLP_URL')

    // The timeout must not fall back to the official 1000ms default: a timeout
    // is not retried (dsh-otel passes `errorCodes: []`, overriding got's
    // network-error list), so a tight budget loses the batch outright.
    expect(patch).toContain('timeoutMillis: 3000')
  })
})
