/**
 * Reading the catalogue out of a working copy.
 *
 * Discovery is structural — `skills/<category>/<product>/<skill>/SKILL.md` — so
 * these tests build the shape on disk rather than stubbing a parser. What they
 * pin: the name comes from the frontmatter (because the registry keys on it), one
 * malformed bundle does not hide the rest, and the description is bounded.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { discover, shorten, splitFrontmatter } from '../src/catalog.ts'

let workTree: string

beforeEach(() => {
  workTree = mkdtempSync(join(tmpdir(), 'skills-market-catalog-'))
})

afterEach(() => {
  rmSync(workTree, { recursive: true, force: true })
})

/** Write one bundle at the shape discovery expects. */
function bundle(category: string, product: string, name: string, frontmatter: string): void {
  const dir = join(workTree, 'skills', category, product, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${name}\n`)
}

describe('discover', () => {
  it('finds bundles at the category/product/skill depth, sorted by name', () => {
    bundle('storage', 'obs', 'obs-upload', 'name: obs-upload\ndescription: Upload files.')
    bundle('computing', 'ecs', 'ecs-manage', 'name: ecs-manage\ndescription: Manage ECS.')

    expect(discover(workTree).map(entry => entry.skill.name)).toEqual(['ecs-manage', 'obs-upload'])
    expect(discover(workTree)[0]).toEqual({
      skill: {
        name: 'ecs-manage', description: 'Manage ECS.', category: 'computing', product: 'ecs',
        path: 'skills/computing/ecs/ecs-manage', tags: [],
      },
      directory: join(workTree, 'skills', 'computing', 'ecs', 'ecs-manage'),
    })
  })

  it('takes the name from the frontmatter, not the directory', () => {
    // The registry keys on the frontmatter name, so a directory that disagrees
    // would publish a card naming a skill the model cannot load. Measured
    // upstream: all 198 agree.
    bundle('storage', 'obs', 'directory-name', 'name: frontmatter-name\ndescription: d')

    expect(discover(workTree).map(entry => entry.skill.name)).toEqual(['frontmatter-name'])
  })

  it('does not treat a resourceless directory, or a loose file, as a skill', () => {
    mkdirSync(join(workTree, 'skills', 'storage', 'obs', 'not-a-skill'), { recursive: true })
    writeFileSync(join(workTree, 'skills', 'loose.md'), '---\nname: loose\ndescription: d\n---\n')

    expect(discover(workTree)).toEqual([])
  })

  it('skips a malformed bundle without hiding the others', () => {
    // One skill author's broken YAML must cost that skill, not the catalogue.
    bundle('storage', 'obs', 'good', 'name: good\ndescription: fine')
    bundle('storage', 'obs', 'broken', 'name: [unclosed')
    bundle('storage', 'obs', 'nameless', 'description: no name here')

    expect(discover(workTree).map(entry => entry.skill.name)).toEqual(['good'])
  })

  it('carries the frontmatter tags, in both upstream spellings', () => {
    // Upstream spells the field two ways: a YAML list and a comma-separated
    // string. Both are the skill's own tags; neither is a reason to skip it.
    bundle('storage', 'obs', 'listed', 'name: listed\ndescription: d\ntags: [npu, remote]')
    bundle('storage', 'obs', 'inline', 'name: inline\ndescription: d\ntags: npu, remote')

    const found = discover(workTree).map(entry => [entry.skill.name, entry.skill.tags])
    expect(Object.fromEntries(found)).toEqual({ inline: ['npu', 'remote'], listed: ['npu', 'remote'] })
  })

  it('answers a missing or malformed tags field with no tags', () => {
    bundle('storage', 'obs', 'none', 'name: none\ndescription: d')
    bundle('storage', 'obs', 'number', 'name: number\ndescription: d\ntags: 42')

    const found = discover(workTree).map(entry => [entry.skill.name, entry.skill.tags])
    expect(Object.fromEntries(found)).toEqual({ none: [], number: [] })
  })

  it('answers an absent working copy with an empty catalogue', () => {
    expect(discover(join(workTree, 'nowhere'))).toEqual([])
  })
})

describe('splitFrontmatter', () => {
  it('separates the header from the body', () => {
    expect(splitFrontmatter('---\nname: x\n---\n\nBody\n')).toEqual({ header: 'name: x', body: '\nBody\n' })
  })

  it('answers undefined when there is no frontmatter', () => {
    expect(splitFrontmatter('# Just a heading\n')).toBeUndefined()
  })

  it('tolerates CRLF line endings', () => {
    expect(splitFrontmatter('---\r\nname: x\r\n---\r\nBody\r\n')).toEqual({ header: 'name: x', body: 'Body\r\n' })
  })
})

describe('shorten', () => {
  it('leaves a short description alone', () => {
    expect(shorten('Short.')).toBe('Short.')
  })

  it('flattens newlines so a card is one paragraph', () => {
    expect(shorten('line one\nline two')).toBe('line one line two')
  })

  it('cuts at a word boundary and marks the omission', () => {
    const long = `${'word '.repeat(80)}end`
    const short = shorten(long)
    expect(short.length).toBeLessThanOrEqual(301)
    expect(short.endsWith('…')).toBe(true)
    expect(short).not.toContain('  ')
  })
})
describe('working-copy reconciliation', () => {
  // These exercise the module's exported surface only: a leftover on disk is
  // observable through `discover`, which is what the catalogue actually reads.
  it('does not report a bundle that is no longer in the working copy', () => {
    // The property the reconciliation protects, stated at the level a caller
    // sees: what `discover` returns is what is on disk now, not what used to be.
    bundle('storage', 'obs', 'here-today', 'name: here-today\ndescription: d')
    expect(discover(workTree).map(entry => entry.skill.name)).toEqual(['here-today'])

    rmSync(join(workTree, 'skills', 'storage', 'obs', 'here-today'), { recursive: true, force: true })
    expect(discover(workTree)).toEqual([])
  })
})
