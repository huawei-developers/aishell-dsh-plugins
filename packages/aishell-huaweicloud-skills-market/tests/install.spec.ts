/**
 * Publishing and removing bundles under the skills root.
 *
 * The tests that matter here are the refusals: every one of them exists because
 * the wrong answer destroys work the plugin did not create. A test that only
 * covered the happy path would pass on an implementation that overwrites a
 * hand-authored skill with the same name.
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  INSTALL_MARKER,
  installBundle,
  isMarketInstalled,
  listInstalled,
  marketplacePaths,
  readInstallRecord,
  uninstallBundle,
  type MarketplacePaths,
} from '../src/install.ts'

let root: string
let paths: MarketplacePaths

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-market-install-'))
  mkdirSync(join(root, 'skills'), { recursive: true })
  paths = marketplacePaths(join(root, 'skills'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Build a source bundle in the working copy, as the catalogue would find it. */
function sourceBundle(name: string, body = '# Skill\n'): string {
  const dir = join(root, 'repository', 'skills', 'storage', 'obs', name)
  mkdirSync(join(dir, 'references'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill.\n---\n\n${body}`)
  writeFileSync(join(dir, 'references', 'guide.md'), 'guide\n')
  return dir
}

const record = (name: string) => ({ name, path: `skills/storage/obs/${name}`, installedAt: '2026-11-19T00:00:00.000Z' })

describe('installBundle', () => {
  it('publishes the whole bundle and its marker', () => {
    const source = sourceBundle('obs-upload')
    const outcome = installBundle(paths, 'obs-upload', source, record('obs-upload'))

    expect(outcome).toEqual({ ok: true })
    const target = join(paths.skillsRoot, 'obs-upload')
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('name: obs-upload')
    expect(readFileSync(join(target, 'references', 'guide.md'), 'utf8')).toBe('guide\n')
    expect(isMarketInstalled(target)).toBe(true)
    expect(readInstallRecord(target)).toEqual({
      name: 'obs-upload',
      path: 'skills/storage/obs/obs-upload',
      installedAt: '2026-11-19T00:00:00.000Z',
    })
  })

  it('leaves no staging directory behind', () => {
    installBundle(paths, 'obs-upload', sourceBundle('obs-upload'), record('obs-upload'))
    expect(existsSync(paths.stagingRoot) ? readdirSync(paths.stagingRoot) : []).toEqual([])
  })

  it('refuses to overwrite a skill the market did not install', () => {
    // The failure this guards: a person wrote their own `obs-upload`, and the
    // market's install of the same name would replace it with no way back.
    const target = join(paths.skillsRoot, 'obs-upload')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), '---\nname: obs-upload\ndescription: Mine.\n---\n\nMINE\n')

    const outcome = installBundle(paths, 'obs-upload', sourceBundle('obs-upload'), record('obs-upload'))

    expect(outcome).toEqual({ ok: false, refusal: { code: 'name-taken' } })
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('MINE')
  })

  it('replaces a bundle it installed before', () => {
    const source = sourceBundle('obs-upload', 'VERSION ONE\n')
    installBundle(paths, 'obs-upload', source, record('obs-upload'))
    const updated = sourceBundle('obs-upload', 'VERSION TWO\n')
    const outcome = installBundle(paths, 'obs-upload', updated, record('obs-upload'))

    expect(outcome).toEqual({ ok: true })
    expect(readFileSync(join(paths.skillsRoot, 'obs-upload', 'SKILL.md'), 'utf8')).toContain('VERSION TWO')
    // The replaced copy is gone, not parked in the scanned directory.
    expect(existsSync(paths.trashRoot) ? readdirSync(paths.trashRoot) : []).toEqual([])
  })

  it('overwrites a marker the upstream bundle shipped', () => {
    // A bundle carrying its own marker would otherwise make the bundle
    // uninstallable by describing the wrong install.
    const source = sourceBundle('obs-upload')
    writeFileSync(join(source, INSTALL_MARKER), '{"name":"someone-else","path":"x"}\n')

    installBundle(paths, 'obs-upload', source, record('obs-upload'))

    expect(readInstallRecord(join(paths.skillsRoot, 'obs-upload'))?.name).toBe('obs-upload')
  })
})

describe('uninstallBundle', () => {
  it('removes a bundle it installed', () => {
    installBundle(paths, 'obs-upload', sourceBundle('obs-upload'), record('obs-upload'))
    expect(uninstallBundle(paths.skillsRoot, 'obs-upload')).toEqual({ ok: true })
    expect(existsSync(join(paths.skillsRoot, 'obs-upload'))).toBe(false)
  })

  it('refuses to remove a skill the market did not install', () => {
    const target = join(paths.skillsRoot, 'obs-upload')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'SKILL.md'), 'MINE\n')

    expect(uninstallBundle(paths.skillsRoot, 'obs-upload')).toEqual({
      ok: false, refusal: { code: 'not-installed-here' },
    })
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true)
  })

  it('treats an absent bundle as removed', () => {
    // The caller asked for an end state, not for an event.
    expect(uninstallBundle(paths.skillsRoot, 'never-installed')).toEqual({ ok: true })
  })
})

describe('listInstalled', () => {
  it('lists only bundles carrying the marker', () => {
    installBundle(paths, 'from-market', sourceBundle('from-market'), record('from-market'))
    mkdirSync(join(paths.skillsRoot, 'by-hand'), { recursive: true })
    writeFileSync(join(paths.skillsRoot, 'by-hand', 'SKILL.md'), 'mine\n')

    expect(listInstalled(paths.skillsRoot)).toEqual(['from-market'])
  })

  it('answers an absent skills root with an empty list', () => {
    expect(listInstalled(join(root, 'nowhere'))).toEqual([])
  })
})

describe('readInstallRecord', () => {
  it('treats a malformed marker as absent rather than throwing', () => {
    // A crash mid-install, or a hand edit, must not make the catalogue
    // unreadable.
    const dir = join(paths.skillsRoot, 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, INSTALL_MARKER), '{not json')
    expect(readInstallRecord(dir)).toBeUndefined()
  })
})
describe('concurrent installs', () => {
  it('gives two installs arriving together their own staging directory', () => {
    // Both copies start in the same millisecond, which is the ordinary case for
    // two windows open at once. A timestamp-named staging directory would put
    // them in one directory, where each copy lands on top of the other.
    const first = sourceBundle('obs-upload', 'FROM FIRST\n')
    const second = sourceBundle('ecs-manage', 'FROM SECOND\n')

    const a = installBundle(paths, 'obs-upload', first, record('obs-upload'))
    const b = installBundle(paths, 'ecs-manage', second, record('ecs-manage'))

    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    expect(readFileSync(join(paths.skillsRoot, 'obs-upload', 'SKILL.md'), 'utf8')).toContain('FROM FIRST')
    expect(readFileSync(join(paths.skillsRoot, 'ecs-manage', 'SKILL.md'), 'utf8')).toContain('FROM SECOND')
    // And no staging directory survives either one.
    expect(existsSync(paths.stagingRoot) ? readdirSync(paths.stagingRoot) : []).toEqual([])
  })

  it('replaces an installed bundle without leaving its predecessor behind', () => {
    installBundle(paths, 'obs-upload', sourceBundle('obs-upload', 'OLD\n'), record('obs-upload'))
    installBundle(paths, 'obs-upload', sourceBundle('obs-upload', 'NEW\n'), record('obs-upload'))

    expect(readFileSync(join(paths.skillsRoot, 'obs-upload', 'SKILL.md'), 'utf8')).toContain('NEW')
    expect(existsSync(paths.trashRoot) ? readdirSync(paths.trashRoot) : []).toEqual([])
  })
})
