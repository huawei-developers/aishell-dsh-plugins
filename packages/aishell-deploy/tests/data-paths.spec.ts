/**
 * The terraform cache lives under the host's data directory.
 *
 * The base directory itself is defined in `credentials-store/paths` and tested
 * there; what is pinned here is the terraform half — that the cache hangs off
 * that base, and that every path below it is built with `join` rather than
 * string concatenation.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'

import {
  terraformBinDir,
  terraformPluginDir,
  terraformRoot,
} from '../src/data-paths.ts'

const original = process.env.DSH_HOME

afterEach(() => {
  if (original === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = original
})

describe('the terraform directories', () => {
  it('hangs off the host data directory', () => {
    process.env.DSH_HOME = '/var/lib/dsh'
    expect(terraformRoot()).toBe(join('/var/lib/dsh', 'terraform'))
    expect(terraformBinDir()).toBe(join('/var/lib/dsh', 'terraform', 'bin'))
    expect(terraformPluginDir()).toBe(join('/var/lib/dsh', 'terraform', 'plugins'))
  })

  it('resolves per call, not once at import', () => {
    // A module-load snapshot would ignore a host that sets `DSH_HOME` after
    // this module is first imported.
    process.env.DSH_HOME = '/first'
    expect(terraformBinDir()).toBe(join('/first', 'terraform', 'bin'))
    process.env.DSH_HOME = '/second'
    expect(terraformBinDir()).toBe(join('/second', 'terraform', 'bin'))
  })

  it('joins rather than concatenating', () => {
    // A trailing separator is the common shape a host config takes
    // (`DSH_HOME=/var/lib/dsh/`); concatenation would produce `dsh//terraform`
    // and Windows would get mixed separators.
    process.env.DSH_HOME = '/var/lib/dsh/'
    expect(terraformBinDir()).toBe(join('/var/lib/dsh', 'terraform', 'bin'))
    expect(terraformBinDir()).not.toContain('//')
  })

  it('does not create anything', () => {
    // Resolution is pure. The writer creates the directory, so a read-only
    // caller — `terraform_state`, a plan — never touches the filesystem.
    process.env.DSH_HOME = '/nonexistent/should/not/be/created'
    expect(() => terraformBinDir()).not.toThrow()
  })
})