/**
 * Reading the catalogue responses `lookup_specs` depends on.
 *
 * The parsers are pinned against the shapes the live API returns — verified
 * against huaweicloud ECS, IMS and RDS in cn-north-4a, where `vcpus` and `disk`
 * arrive as strings while `ram` and `min_disk` arrive as numbers. A fixture that
 * normalised all of that in advance would pass while the real response parsed
 * to nothing.
 *
 * The RDS parser is the one worth keeping: `az_status` decides which zone can
 * host a spec, and reporting a spec as available without it approves a
 * combination the cloud refuses.
 */

import { describe, it, expect } from 'vitest'

import {
  deployableInZone,
  readDatabaseFlavors,
  readFlavors,
  readImages,
} from '../src/catalog.ts'

describe('readFlavors', () => {
  it('reads the fields the ECS API returns', () => {
    const flavors = readFlavors({
      flavors: [{ id: 'c7.large.2', name: 'c7.large.2', vcpus: '2', ram: 4096, disk: '0' }],
    })
    expect(flavors).toEqual([
      { id: 'c7.large.2', name: 'c7.large.2', vcpus: 2, ramMb: 4096, diskGb: 0 },
    ])
  })

  it('skips an entry with no id rather than dropping the list', () => {
    const flavors = readFlavors({ flavors: [{ name: 'no id' }, { id: 'ok', vcpus: 1 }] })
    expect(flavors.map(flavor => flavor.id)).toEqual(['ok'])
  })

  it('returns nothing for a response with no flavors array', () => {
    expect(readFlavors({})).toEqual([])
    expect(readFlavors(null)).toEqual([])
  })
})

describe('readImages', () => {
  it('keeps the minimums, which decide whether an image fits a flavour', () => {
    const images = readImages({
      images: [{ id: 'abc', name: 'EulerOS', __os_version: 'EulerOS 3.0', min_disk: 10, min_ram: 1024 }],
    })
    expect(images[0]).toEqual({
      id: 'abc',
      name: 'EulerOS',
      os: 'EulerOS 3.0',
      minDiskGb: 10,
      minRamMb: 1024,
    })
  })

  it('reads numbers sent as strings', () => {
    const images = readImages({ images: [{ id: 'i', min_disk: '40', min_ram: '2048' }] })
    expect(images[0]).toMatchObject({ minDiskGb: 40, minRamMb: 2048 })
  })
})

describe('readDatabaseFlavors', () => {
  it('reads spec_code and the per-zone availability', () => {
    const flavors = readDatabaseFlavors({
      flavors: [{
        id: '8d13383f',
        spec_code: 'rds.mysql.8xlarge.arm4.rha.rr',
        vcpus: '32',
        ram: 128,
        instance_mode: 'replica',
        az_status: { 'cn-north-4a': 'normal', 'cn-north-4c': 'unsupported' },
      }],
    })
    expect(flavors[0]).toMatchObject({
      specCode: 'rds.mysql.8xlarge.arm4.rha.rr',
      vcpus: 32,
      ramGb: 128,
      zones: { 'cn-north-4a': 'normal', 'cn-north-4c': 'unsupported' },
    })
  })
})

describe('deployableInZone', () => {
  const flavor = readDatabaseFlavors({
    flavors: [{ spec_code: 's', az_status: { ok: 'normal', no: 'unsupported', odd: 'something' } }],
  })[0]!

  it('accepts a zone the catalogue marks normal', () => {
    expect(deployableInZone(flavor, 'ok')).toBe(true)
  })

  it('refuses a zone it marks unsupported, an unknown status, and an absent zone', () => {
    // "I do not understand this" reads as "do not approve it".
    expect(deployableInZone(flavor, 'no')).toBe(false)
    expect(deployableInZone(flavor, 'odd')).toBe(false)
    expect(deployableInZone(flavor, 'missing')).toBe(false)
  })
})
