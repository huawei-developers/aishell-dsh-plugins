/**
 * Reading the catalogue responses: what a region actually sells.
 *
 * ## Why this exists
 *
 * A `.tf` file names a flavour and an image by ID: `flavor_id = "c7.large.2"`,
 * `image_id = "img-xxx"`. `terraform validate` checks only that those are
 * strings — a clearly invented `flavor_id` passes. The value is checked at
 * apply time by the cloud, after the user has approved a plan and a price.
 *
 * So a design can be schema-valid, priced, approved, and fail on the first
 * resource. This module reads the two catalogues that close that gap: the
 * flavours and images a region offers, and the database specs with the zones
 * that carry them.
 *
 * ## Why the calls are described here and not in the prompt
 *
 * Every URL, query parameter and response field below was established against
 * the live API. A model reconstructing them from a one-line instruction in the
 * prompt gets them wrong — `vcpus` arrives as a string while `ram` arrives as a
 * number, RDS lists its zones in `az_status` whose values are `normal` or
 * `unsupported`, and an engine name is a path segment rather than a query. Those
 * are exactly the details that read plausible and fail.
 *
 * Pricing lives in `bss.ts` and `rating-map.ts`; this module only answers what
 * can be bought.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/catalog
 */

/**
 * The region's project id, from IAM.
 *
 * Every region-scoped API needs it in the path, and it is not the account id:
 * one account has a project per region. `loadAccount()` already resolves the
 * account; this is the region part of the same identity.
 */
export interface ProjectRef {
  readonly id: string
  readonly region: string
}

/** One compute flavour the region offers in a given availability zone. */
export interface Flavor {
  readonly id: string
  readonly name: string
  readonly vcpus: number
  /** Memory in MiB, as the API reports it. */
  readonly ramMb: number
  /** Local disk in GiB, `0` for a flavour with none. */
  readonly diskGb: number
}

/** One image that can boot an instance in the region. */
export interface Image {
  readonly id: string
  readonly name: string
  /** e.g. `Ubuntu 22.04 server 64bit`. */
  readonly os: string
  readonly minDiskGb: number
  readonly minRamMb: number
}

/**
 * The flavours an ECS response lists.
 *
 * `ram` is MiB and arrives as a number; `vcpus` and `disk` arrive as strings
 * (`"48"`, `"0"`). The whole list is returned rather than a subset because the
 * caller decides what to show — and a filter here would hide the very flavour
 * a `.tf` names and turn "not offered" into "not found".
 *
 * @param body - the parsed `cloudservers/flavors` response.
 * @returns the flavours, in the order the API gave them.
 */
export function readFlavors(body: unknown): Flavor[] {
  const list = childArray(body, 'flavors')
  return list.flatMap((raw): Flavor[] => {
    const entry = raw as { id?: unknown, name?: unknown, vcpus?: unknown, ram?: unknown, disk?: unknown }
    if (typeof entry.id !== 'string') return []
    return [{
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      vcpus: toNumber(entry.vcpus) ?? 0,
      ramMb: toNumber(entry.ram) ?? 0,
      diskGb: toNumber(entry.disk) ?? 0,
    }]
  })
}

/**
 * The images an IMS response lists.
 *
 * `min_disk` and `min_ram` are what the image needs from the flavour it boots
 * on, which is the constraint a reader has to check against the chosen flavour
 * — so they are kept rather than dropped.
 *
 * @param body - the parsed `cloudimages` response.
 * @returns the images.
 */
export function readImages(body: unknown): Image[] {
  const list = childArray(body, 'images')
  return list.flatMap((raw): Image[] => {
    const entry = raw as {
      id?: unknown
      name?: unknown
      os_type?: unknown
      min_disk?: unknown
      min_ram?: unknown
      __os_version?: unknown
    }
    if (typeof entry.id !== 'string') return []
    const os = typeof entry.__os_version === 'string'
      ? entry.__os_version
      : typeof entry.os_type === 'string' ? entry.os_type : ''
    return [{
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      os,
      minDiskGb: toNumber(entry.min_disk) ?? 0,
      minRamMb: toNumber(entry.min_ram) ?? 0,
    }]
  })
}

/**
 * A named array from a response object.
 *
 * @param body - the parsed response.
 * @param key - the field holding the array.
 * @returns its entries, or an empty list when the field is absent or not an array.
 */
function childArray(body: unknown, key: string): unknown[] {
  if (body === null || typeof body !== 'object') return []
  const value = (body as Record<string, unknown>)[key]
  return Array.isArray(value) ? value : []
}
/** One database instance specification the region offers. */
export interface DatabaseFlavor {
  readonly id: string
  readonly specCode: string
  readonly vcpus: number
  readonly ramGb: number
  /** The modes it can be bought in: `single`, `ha`, `replica`, … */
  readonly instanceMode: string
  /** Zones where this spec can be deployed, keyed by zone id. */
  readonly zones: Readonly<Record<string, string>>
}

/**
 * The database specs an RDS `flavors/<engine>` response lists.
 *
 * `az_status` is the field that makes the list usable for a design: a spec
 * exists region-wide but not in every zone, so a design that names a spec has
 * to be checked against the zone it placed the instance in. Reporting a spec as
 * available without its zones would approve a combination the cloud refuses.
 *
 * @param body - the parsed `flavors/<engine>` response.
 * @returns the specs, in the order the API gave them.
 */
export function readDatabaseFlavors(body: unknown): DatabaseFlavor[] {
  const list = childArray(body, 'flavors')
  return list.flatMap((raw): DatabaseFlavor[] => {
    const entry = raw as {
      id?: unknown
      spec_code?: unknown
      vcpus?: unknown
      ram?: unknown
      instance_mode?: unknown
      az_status?: unknown
    }
    const specCode = typeof entry.spec_code === 'string' ? entry.spec_code : undefined
    if (specCode === undefined) return []
    const zones: Record<string, string> = {}
    if (entry.az_status !== null && typeof entry.az_status === 'object') {
      for (const [zone, status] of Object.entries(entry.az_status as Record<string, unknown>)) {
        if (typeof status === 'string') zones[zone] = status
      }
    }
    return [{
      id: typeof entry.id === 'string' ? entry.id : specCode,
      specCode,
      vcpus: toNumber(entry.vcpus) ?? 0,
      ramGb: toNumber(entry.ram) ?? 0,
      instanceMode: typeof entry.instance_mode === 'string' ? entry.instance_mode : '',
      zones,
    }]
  })
}

/**
 * Whether a spec is deployable in one zone.
 *
 * The API reports `normal` for an available zone and `unsupported` for one it
 * does not serve. Anything else — an unexpected status — counts as unavailable,
 * because the safe reading of "I do not understand this" is "do not approve it".
 *
 * @param flavor - the spec.
 * @param zone - the zone to ask about.
 * @returns whether the spec can be deployed there.
 */
export function deployableInZone(flavor: DatabaseFlavor, zone: string): boolean {
  return flavor.zones[zone] === 'normal'
}

/**
 * A number the API sent as a string or a number.
 *
 * `vcpus` and `disk` arrive as strings (`"48"`, `"0"`) while `ram` and
 * `min_disk` arrive as numbers, so every numeric field is read through this.
 *
 * @param value - whatever the field held.
 * @returns the number, or `undefined`.
 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
