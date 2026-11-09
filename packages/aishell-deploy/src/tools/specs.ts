/**
 * `lookup_specs` — what the region offers, and whether the design asks for it.
 *
 * ## The gap it fills
 *
 * A `.tf` names a flavour and an image by ID, and `terraform validate` accepts
 * any string there. So a design with an invented flavour is schema-valid,
 * validates clean, gets drawn, gets priced, gets approved — and fails at apply,
 * on the first instance, on a value nobody could have checked.
 *
 * This tool answers the question a person actually has at that moment: "is
 * `c7.large.2` a thing this region sells, in the zone I put it in, and does the
 * image fit on it?"
 *
 * ## Two modes, because there are two moments
 *
 * - **No `deployment`**: list what the region offers. This is what the model
 *   needs BEFORE writing `.tf`, because `flavor_id` and `image_id` are UUIDs and
 *   names it cannot invent.
 * - **With `deployment`**: read the `.tf`, and check every flavour and image it
 *   names against the catalogue. This is the check nothing else performs:
 *   `terraform validate` accepts any string for `flavor_id`, so a design naming
 *   a flavour the region does not sell passes validation and fails at apply.
 *
 * ## What it reports, and what it does not
 *
 * It reports absence and mismatch. It does not judge suitability — whether
 * 4 vCPU is enough for the workload is the user's call, and a tool that
 * guessed would be overstepping. The numbers are returned so the person can
 * decide.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/tools/specs
 */

import type { ToolRegistrar } from '../types.ts'
import { z } from 'zod'

import { READ_ONLY_CLOUD } from './annotations.ts'
import { fail, guard, okJson, type ToolResult } from './errors.ts'
import { deploymentParam } from './index.ts'
import { signedHttp } from '../auth-http.ts'
import { projectIn, projectMap } from '../projects.ts'
import { loadCredentials } from '../credentials.ts'
import {
  deployableInZone,
  readDatabaseFlavors,
  readFlavors,
  readImages,
  type DatabaseFlavor,
  type Flavor,
  type Image,
  type ProjectRef,
} from '../catalog.ts'
import { parseConfiguration } from '../hcl.ts'

/** The ECS host for one region. */
function ecsHost(region: string): string {
  return `https://ecs.${region}.myhuaweicloud.com`
}

/** The IMS host for one region. */
function imsHost(region: string): string {
  return `https://ims.${region}.myhuaweicloud.com`
}

/** How many catalogue entries one response may carry. */
const CATALOGUE_LIMIT = 500


/**
 * Every flavour the region sells in one availability zone.
 *
 * Scoped to an AZ because that is how availability works: a flavour exists in
 * a zone or it does not, and an instance placed in cn-north-4a cannot use a
 * flavour that only cn-north-4b carries. Asking without the zone would return
 * a union and turn "not in this zone" into a false pass.
 *
 * @param project - the region's project.
 * @param availabilityZone - the zone to ask about.
 * @returns the flavours.
 */
async function listFlavors(project: ProjectRef, availabilityZone: string): Promise<Flavor[]> {
  const url = new URL(
    `${ecsHost(project.region)}/v1/${project.id}/cloudservers/flavors`
    + `?availability_zone=${encodeURIComponent(availabilityZone)}`,
  )
  const response = await signedHttp('GET', url, '')
  if (response.status !== 200) {
    throw new Error(
      `could not list compute flavours (HTTP ${response.status}): ${response.body.slice(0, 300)}`,
    )
  }
  return readFlavors(JSON.parse(response.body))
}

/**
 * The public images available in the region.
 *
 * Gold images only — the marketplace's private and shared images are not what
 * a new design should start from, and including them would bury the ones that
 * matter under a model's own uploads.
 *
 * @param project - the region's project.
 * @returns the images.
 */
async function listImages(project: ProjectRef): Promise<Image[]> {
  const url = new URL(
    `${imsHost(project.region)}/v2/cloudimages?__imagetype=gold&limit=${CATALOGUE_LIMIT}`,
  )
  const response = await signedHttp('GET', url, '')
  if (response.status !== 200) {
    throw new Error(
      `could not list images (HTTP ${response.status}): ${response.body.slice(0, 300)}`,
    )
  }
  return readImages(JSON.parse(response.body))
}

/**
 * Register `lookup_specs`.
 *
 * @param registrar - the capture surface this plugin's tools register into.
 */
export function registerSpecsTool(registrar: ToolRegistrar): void {
  registrar.registerTool(
    'lookup_specs',
    {
      title: 'Look up compute flavours and images, and check a design against them',
      description:
        'Two uses. WITHOUT `deployment`: list the compute flavours and images this region '
        + 'offers in one availability zone, with each flavour vCPUs, memory and disk, and each '
        + 'image OS, minimum disk and minimum memory. `flavor_id` and `image_id` are values '
        + 'only the region knows — an invented one passes terraform validate, which checks '
        + 'only that the value is a string, and fails at apply. '
        + 'WITH `deployment`: read the .tf files and check every flavor_id, flavor_name, '
        + 'image_id and image_name they name against the catalogue, reporting any that the '
        + 'region does not offer in that zone, plus images whose minimum disk or memory the '
        + 'chosen flavour cannot meet. terraform validate cannot see any of this: it checks '
        + 'only that the value is a string. '
        + 'The numbers are returned so the user can judge suitability; this tool does not '
        + 'judge it.',
      annotations: READ_ONLY_CLOUD,
      inputSchema: z.object({
        availability_zone: z.string().describe(
          'The zone to ask about, e.g. "cn-north-4a". A flavour exists per zone, so this '
          + 'is required — asking without it would report a flavour as available when only '
          + 'another zone carries it.',
        ),
        region: z.string().min(1).describe(
          'The region to ask about, e.g. "cn-north-4". A flavour, an image and a price all '
          + 'exist per region, so this is required and is not defaulted: a flavour listed for '
          + 'one region says nothing about another. Pass the region the resources will be '
          + 'created in — the one written in the provider block of the .tf.',
        ),
        deployment: deploymentParam.optional().describe(
          'When given, also check the .tf files in this deployment against the catalogue.',
        ),
      }),
    },
    guard(async (args) => handleLookup(args.availability_zone, args.region, args.deployment)),
  )
}

/**
 * Answer the lookup, with or without a design to check.
 *
 * @param availabilityZone - the zone to ask about.
 * @param region - the region to ask about; a required choice, not a default.
 * @param deployment - the deployment to check, or `undefined` to only list.
 * @returns the tool result.
 */
async function handleLookup(
  availabilityZone: string,
  region: string,
  deployment: string | undefined,
): Promise<ToolResult> {
  const resolvedRegion = region
  try {
    // The project list is global, so one IAM call answers for every region —
    // and the id found here is the one the region-scoped catalogue hosts need.
    const credentials = await loadCredentials()
    const projects = await projectMap(credentials)
    const project: ProjectRef = {
      id: projectIn(projects, resolvedRegion),
      region: resolvedRegion,
    }
    const [flavors, images] = await Promise.all([
      listFlavors(project, availabilityZone),
      listImages(project),
    ])
    // The database catalogue is per engine and is fetched only when the design
    // asks for one: a request for every engine the region carries would be
    // dozens of calls for a configuration that uses none of them.
    const engines = deployment === undefined ? [] : await databaseEngines(deployment)
    // Sequential rather than concurrent: a design usually names one or two
    // engines, so the parallelism buys nothing, and every catalogue call goes
    // through the same signed client against one host — flooding it holds no
    // advantage over asking twice in a row.
    const databaseFlavors = new Map<string, readonly DatabaseFlavor[]>()
    for (const engine of engines) {
      databaseFlavors.set(engine, await listDatabaseFlavors(project, engine))
    }

    if (deployment === undefined) {
      return okJson({
        region: resolvedRegion,
        availability_zone: availabilityZone,
        flavors: flavors.map(flavor => ({
          id: flavor.id,
          name: flavor.name,
          vcpus: flavor.vcpus,
          memory_gb: flavor.ramMb / 1024,
          disk_gb: flavor.diskGb,
        })),
        images: images.map(image => ({
          id: image.id,
          name: image.name,
          os: image.os,
          min_disk_gb: image.minDiskGb,
          min_memory_gb: image.minRamMb / 1024,
        })),
        note:
          'Use these values for flavor_id and image_id in the .tf. An image whose '
          + 'min_disk_gb or min_memory_gb the chosen flavour cannot meet will not boot.',
      })
    }

    const check = await checkDeployment(deployment, flavors, images, databaseFlavors, availabilityZone)
    return okJson({
      region: resolvedRegion,
      availability_zone: availabilityZone,
      deployment,
      catalogue: { flavors: flavors.length, images: images.length },
      specs: check.specs,
      problems: check.problems,
      ...(check.unparsed.length === 0 ? {} : { unparsed: check.unparsed }),
      summary: {
        checked: check.specs.length,
        problems: check.problems.length,
        complete: check.unparsed.length === 0,
      },
      note: specNote(check),
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** A resource the design names, with the spec values it asks for. */
interface SpecUse {
  readonly address: string
  readonly flavor?: string
  readonly image?: string
  /** A managed database's spec code. */
  readonly databaseFlavor?: string
  /** A managed database's engine, e.g. `MySQL`. */
  readonly engine?: string
}

/** One problem a catalogue check found. */
interface SpecProblem {
  readonly address: string
  readonly summary: string
  readonly detail: string
}

/**
 * What to tell the model about a catalogue check.
 *
 * The `complete` flag is the part that matters. A configuration with a file
 * that did not parse has had only part of its specs checked, so a clean result
 * would be a false assurance: "no problems" would mean "no problems in the
 * files I could read". Saying that plainly is the difference between a check
 * and the appearance of one.
 *
 * @param check - what the catalogue comparison found.
 * @returns the note to attach to the result.
 */
function specNote(check: {
  readonly problems: readonly SpecProblem[]
  readonly unparsed: readonly string[]
}): string {
  const incomplete = check.unparsed.length > 0
    ? ` ${check.unparsed.join(', ')} did not parse, so their resources were NOT checked — `
      + 'this result is incomplete and must not be described as a clean design.'
    : ''
  if (check.problems.length > 0) {
    return 'These problems are invisible to terraform validate. Fix them before pricing and '
      + `applying — each one fails at apply, after the design is approved.${incomplete}`
  }
  return incomplete === ''
    ? 'Every flavour and image this configuration names exists in this zone.'
    : `No problems in the files that parsed.${incomplete}`
}

/**
 * Every flavour and image the configuration names, in resource order.
 *
 * Both spellings are read: the provider accepts `flavor_id` or `flavor_name`,
 * and `image_id` or `image_name`, and a design may use either. A value that is
 * an expression is skipped — it resolves only when terraform runs, and
 * checking the expression text against the catalogue would report a false
 * problem.
 *
 * @param deployment - the deployment workspace directory.
 * @returns the spec uses, and the files that could not be parsed.
 */
async function readSpecUses(
  deployment: string,
): Promise<{ readonly uses: SpecUse[], readonly unparsed: readonly string[] }> {
  const { blocks, unparsed } = await parseConfiguration(deployment)
  const uses: SpecUse[] = []
  for (const block of blocks) {
    const flavor = literalOfEither(block.body, 'flavor_id', 'flavor_name')
    const image = literalOfEither(block.body, 'image_id', 'image_name')
    // A managed database names its spec in `flavor` and its engine in a `db`
    // block. Its zone comes from the spec itself, so it needs its own record
    // rather than being folded into the compute shape.
    const databaseFlavor = block.type === 'huaweicloud_rds_instance'
      ? literalOfEither(block.body, 'flavor', 'flavor')
      : undefined
    const engine = engineOf(block.body)
    if (flavor === undefined && image === undefined && databaseFlavor === undefined) continue
    uses.push({
      address: `${block.type}.${block.name}`,
      ...(flavor === undefined ? {} : { flavor }),
      ...(image === undefined ? {} : { image }),
      ...(databaseFlavor === undefined ? {} : { databaseFlavor }),
      ...(engine === undefined ? {} : { engine }),
    })
  }
  return { uses, unparsed }
}

/**
 * The first literal string among two attribute names.
 *
 * @param body - a resource body.
 * @param first - the preferred attribute.
 * @param second - the alternative spelling.
 * @returns the value, or `undefined` when both are absent or non-literal.
 */
function literalOfEither(
  body: Record<string, unknown>,
  first: string,
  second: string,
): string | undefined {
  for (const key of [first, second]) {
    const value = body[key]
    if (typeof value === 'string' && value !== '' && !value.includes('${')) return value
  }
  return undefined
}

/**
 * Check the design's named flavours and images against the catalogue.
 *
 * Two kinds of problem, both invisible to `terraform validate`:
 *
 *   - a value the region does not offer in this zone;
 *   - an image whose minimum disk or memory the chosen flavour cannot meet,
 *     which produces an instance that never boots.
 *
 * Matching is by id OR name: the API reports both, and a `.tf` may use either.
 *
 * @param deployment - the deployment workspace directory.
 * @param flavors - the catalogue.
 * @param images - the catalogue.
 * @returns the checked uses and the problems found.
 */
async function checkDeployment(
  deployment: string,
  flavors: readonly Flavor[],
  images: readonly Image[],
  databaseFlavors: ReadonlyMap<string, readonly DatabaseFlavor[]>,
  availabilityZone: string,
): Promise<{ readonly specs: SpecUse[], readonly problems: SpecProblem[], readonly unparsed: readonly string[] }> {
  const { uses, unparsed } = await readSpecUses(deployment)
  const problems: SpecProblem[] = []

  const flavorByValue = new Map<string, Flavor>()
  for (const flavor of flavors) {
    flavorByValue.set(flavor.id, flavor)
    flavorByValue.set(flavor.name, flavor)
  }
  const imageByValue = new Map<string, Image>()
  for (const image of images) {
    imageByValue.set(image.id, image)
    imageByValue.set(image.name, image)
  }

  for (const use of uses) {
    const flavor = use.flavor === undefined ? undefined : flavorByValue.get(use.flavor)
    if (use.flavor !== undefined && flavor === undefined) {
      problems.push({
        address: use.address,
        summary: `flavour "${use.flavor}" is not offered in this zone`,
        detail:
          'terraform validate accepts any string here, so the design looks correct and '
          + 'fails at apply. Choose one of the flavour ids this tool listed, or a zone '
          + 'that carries it.',
      })
    }

    const image = use.image === undefined ? undefined : imageByValue.get(use.image)
    if (use.image !== undefined && image === undefined) {
      problems.push({
        address: use.address,
        summary: `image "${use.image}" is not a public image in this region`,
        detail:
          'Only gold images are checked. An image id copied from another region, or a '
          + 'private image belonging to another account, will not resolve at apply.',
      })
    }

    // An image's minimum disk is met by the SYSTEM DISK, which the provider
    // configures separately (`system_disk_size`) — not by the flavour's local
    // disk. A flavour reporting `disk: 0` is one with no local disk at all,
    // which is the normal case: the instance boots from an EVS volume sized by
    // `system_disk_size`. Comparing against the flavour's disk would report a
    // failure for every such instance.
    //
    // So the disk side is checked only when the flavour HAS local disk: then
    // the image can boot on it directly, and a too-small one is a real problem.
    // The memory side is always checkable — memory comes from the flavour.
    if (flavor !== undefined && image !== undefined) {
      if (flavor.diskGb > 0 && image.minDiskGb > flavor.diskGb) {
        problems.push({
          address: use.address,
          summary: `image needs ${image.minDiskGb} GiB but flavour "${flavor.name}" has only ${flavor.diskGb} GiB of local disk`,
          detail:
            'This flavour carries its own disk and it is smaller than the image minimum. '
            + 'A flavour with no local disk (disk 0) boots from a system disk sized by '
            + '`system_disk_size` instead, which is the usual arrangement.',
        })
      }
      if (image.minRamMb > flavor.ramMb) {
        problems.push({
          address: use.address,
          summary: `image needs ${Math.round(image.minRamMb / 1024)} GiB but flavour "${flavor.name}" has ${Math.round(flavor.ramMb / 1024)} GiB`,
          detail:
            'The instance will not boot: the image requires more memory than the flavour '
            + 'provides.',
        })
      }
    }
  }
  // A managed database's spec is checked differently from a compute flavour:
  // RDS carries every zone in one catalogue, so the question is not "does this
  // flavour exist" but "is it deployable where the design puts it". A spec that
  // exists region-wide and is `unsupported` in the chosen zone is exactly the
  // combination that passes review and fails at apply.
  for (const use of uses) {
    if (use.databaseFlavor === undefined) continue
    if (use.engine === undefined) {
      problems.push({
        address: use.address,
        summary: 'the db block names no engine',
        detail:
          'The engine decides which catalogue the spec belongs to, so a database without '
          + 'one cannot be checked or priced. Set `db { type = "..." }`.',
      })
      continue
    }
    const catalogue = databaseFlavors.get(use.engine) ?? []
    if (catalogue.length === 0) {
      problems.push({
        address: use.address,
        summary: `RDS offers no ${use.engine} catalogue in this region`,
        detail:
          'The engine name must be the one RDS lists (MySQL, PostgreSQL, SQLServer, …). '
          + 'An unrecognised name returns nothing, which is indistinguishable from a region '
          + 'that does not carry the engine.',
      })
      continue
    }
    const spec = catalogue.find(entry => entry.specCode === use.databaseFlavor)
    if (spec === undefined) {
      problems.push({
        address: use.address,
        summary: `spec "${use.databaseFlavor}" is not in the ${use.engine} catalogue`,
        detail:
          'terraform validate accepts any string for `flavor`, so the design looks correct '
          + 'and fails at apply. Choose a spec_code this tool listed.',
      })
      continue
    }
    if (!deployableInZone(spec, availabilityZone)) {
      problems.push({
        address: use.address,
        summary: `spec "${use.databaseFlavor}" is not deployable in ${availabilityZone}`,
        detail:
          `The catalogue lists it for this region but marks ${availabilityZone} as `
          + 'unsupported. Place the instance in a zone the spec serves, or pick a spec that '
          + 'the zone carries.',
      })
    }
  }

  return { specs: uses, problems, unparsed }
}
/**
 * The database engine one block declares.
 *
 * It sits in a nested `db` block (`db { type = "MySQL" }`), which the parser
 * reports as a list because the block may repeat.
 *
 * @param body - the resource body.
 * @returns the engine, or `undefined`.
 */
function engineOf(body: Record<string, unknown>): string | undefined {
  const db = body.db
  const first = Array.isArray(db) ? db[0] : db
  if (first === null || typeof first !== 'object') return undefined
  const type = (first as Record<string, unknown>).type
  return typeof type === 'string' && !type.includes('${') ? type : undefined
}

/**
 * The database engines a deployment's configuration names.
 *
 * Read from the `db` blocks, so only the engines a design actually uses get
 * queried.
 *
 * @param deployment - the deployment workspace directory.
 * @returns the engine names, deduplicated.
 */
async function databaseEngines(deployment: string): Promise<string[]> {
  const { blocks } = await parseConfiguration(deployment)
  const engines = new Set<string>()
  for (const block of blocks) {
    if (block.type !== 'huaweicloud_rds_instance') continue
    const engine = engineOf(block.body)
    if (engine !== undefined) engines.add(engine)
  }
  return [...engines]
}

/**
 * The specs RDS offers for one engine.
 *
 * @param project - the region's project.
 * @param engine - the engine name, e.g. `MySQL`.
 * @returns the specs, empty when the region does not carry that engine.
 */
async function listDatabaseFlavors(
  project: ProjectRef,
  engine: string,
): Promise<readonly DatabaseFlavor[]> {
  const url = new URL(
    `https://rds.${project.region}.myhuaweicloud.com/v3/${project.id}/flavors/${encodeURIComponent(engine)}`,
  )
  const response = await signedHttp('GET', url, '')
  if (response.status !== 200) return []
  return readDatabaseFlavors(JSON.parse(response.body))
}
