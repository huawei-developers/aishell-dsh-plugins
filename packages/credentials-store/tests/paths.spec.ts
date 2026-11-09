/**
 * The host data directory — defined once, used by both consumers.
 *
 * `DSH_HOME` decides where this product keeps everything it writes: the
 * encrypted credentials file and the terraform cache. Defining it in one place
 * is what keeps those two from drifting, which is the same failure the
 * credential-scope constant was created to end.
 *
 * The fallback is `~/.aishell`, shared by every caller. Separation between
 * builds comes from the credential *file name*, not from a second directory.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { FALLBACK_HOME_NAME, credentialsDir, dshHome } from '../src/paths.ts'

const original = process.env.DSH_HOME

afterEach(() => {
  if (original === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = original
})

describe('dshHome', () => {
  it('uses DSH_HOME when the host set it', () => {
    process.env.DSH_HOME = '/var/lib/dsh'
    expect(dshHome()).toBe('/var/lib/dsh')
  })

  it('reads DSH_HOME per call, not once at import', () => {
    // A load-time snapshot would pin whatever was set when this module was
    // first imported, so a host that configures afterwards would look ignored.
    process.env.DSH_HOME = '/first'
    expect(dshHome()).toBe('/first')
    process.env.DSH_HOME = '/second'
    expect(dshHome()).toBe('/second')
  })

  it('treats an empty or whitespace DSH_HOME as unset', () => {
    // A host that sets the variable to an empty string means "unset", not
    // "use the root of the filesystem".
    for (const value of ['', '   ']) {
      process.env.DSH_HOME = value
      expect(dshHome()).toBe(join(homedir(), FALLBACK_HOME_NAME))
    }
  })

  it('falls back to ~/.aishell', () => {
    delete process.env.DSH_HOME
    expect(FALLBACK_HOME_NAME).toBe('.aishell')
    expect(dshHome()).toBe(join(homedir(), '.aishell'))
  })
})

describe('credentialsDir', () => {
  it('is <DSH_HOME>/credentials', () => {
    process.env.DSH_HOME = '/var/lib/dsh'
    expect(credentialsDir()).toBe(join('/var/lib/dsh', 'credentials'))
  })

  it('is ~/.aishell/credentials with no host', () => {
    // The same root the terraform cache uses, so an install without a
    // host-set `DSH_HOME` keeps everything in one place.
    delete process.env.DSH_HOME
    expect(credentialsDir()).toBe(join(homedir(), '.aishell', 'credentials'))
  })

  it('does not add a per-build subdirectory', () => {
    // Builds are separated by the file name (`plugins.credentials.enc`), so a
    // second build shares this directory and still cannot read the first's
    // secrets.
    process.env.DSH_HOME = '/var/lib/dsh'
    expect(credentialsDir()).toBe(join('/var/lib/dsh', 'credentials'))
    expect(credentialsDir()).not.toContain('plugins')
  })

  it('joins rather than concatenating', () => {
    process.env.DSH_HOME = '/var/lib/dsh/'
    expect(credentialsDir()).toBe(join('/var/lib/dsh', 'credentials'))
    expect(credentialsDir()).not.toContain('//')
  })
})