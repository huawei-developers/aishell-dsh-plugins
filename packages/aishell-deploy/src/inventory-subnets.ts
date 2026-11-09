/**
 * Subnets, which RMS does not report.
 *
 * ## Why this module exists
 *
 * A network picture is a network and its subdivisions. RMS reports one of those
 * two levels: a `service: "vpc"` query comes back with `vpcs`,
 * `securityGroups`, `publicips` and `bandwidths` and no subnets at all —
 * confirmed against a live 49-resource account. So an inventory built only from
 * RMS cannot place a server in its subnet, because the subnet is not in the
 * data to place it in.
 *
 * The VPC API does list them, per region and with the `vpc_id` that puts each
 * one inside its VPC. This module reads that, in the vocabulary the inventory
 * already speaks (`provider: "vpc"`, `type: "subnets"`), so the derivation
 * places them and everything that names them without knowing where they came
 * from.
 *
 * ## Why only subnets
 *
 * The same reasoning would justify reaching for any resource RMS misses, and
 * that is exactly the trap. Subnets are asked for because the picture's own
 * structure has a second level and RMS omits it; a resource RMS omits that the
 * picture has no place for is not a gap, it is something the picture is not
 * about. Adding a service here because it is missing would turn this module
 * into a per-service compatibility list.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/inventory-subnets
 */

import { signedHttp } from './auth-http.ts'
import { loadCredentials } from './credentials.ts'
import { projectIn, projectMap } from './projects.ts'

/** One subnet, in the shape the inventory's other resources arrive in. */
export interface InventorySubnet {
  readonly id: string
  readonly name: string
  readonly provider: 'vpc'
  readonly type: 'subnets'
  readonly region: string
  readonly properties: Readonly<Record<string, unknown>>
}

/** The VPC API's subnet record: only the fields this module reads. */
interface VpcSubnet {
  readonly id?: unknown
  readonly name?: unknown
  readonly cidr?: unknown
  readonly vpc_id?: unknown
  readonly gateway_ip?: unknown
  readonly status?: unknown
}

/** How many pages a region's subnet list may take before giving up. */
const MAX_PAGES = 10

/**
 * Every subnet the account has in one region.
 *
 * Best-effort by contract: a caller completes an inventory, and a region whose
 * subnets could not be read is worse off without its other resources, not
 * better. So a failure is reported rather than thrown, and the caller decides
 * what to say about it.
 *
 * @param region - the region to list.
 * @returns the subnets, or the reason they could not be read.
 */
export async function subnetsInRegion(
  region: string,
): Promise<{ readonly subnets: InventorySubnet[], readonly failure?: string }> {
  let projectId: string
  try {
    const projects = await projectMap(await loadCredentials())
    projectId = projectIn(projects, region)
  } catch (error) {
    return { subnets: [], failure: error instanceof Error ? error.message : String(error) }
  }

  const subnets: InventorySubnet[] = []
  let marker: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`https://vpc.${region}.myhuaweicloud.com/v1/${projectId}/subnets`)
    if (marker !== undefined) url.searchParams.set('marker', marker)
    let response
    try {
      response = await signedHttp('GET', url, '')
    } catch (error) {
      return {
        subnets,
        failure: `the subnet list for ${region} could not be read: `
          + `${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (response.status !== 200) {
      return {
        subnets,
        failure: `the subnet list for ${region} answered HTTP ${response.status}: `
          + `${response.body.slice(0, 200)}`,
      }
    }

    const parsed = JSON.parse(response.body) as {
      subnets?: VpcSubnet[]
      page_info?: { next_marker?: string }
    }
    for (const subnet of parsed.subnets ?? []) {
      const mapped = asInventorySubnet(subnet, region)
      if (mapped !== undefined) subnets.push(mapped)
    }

    marker = parsed.page_info?.next_marker
    if (marker === undefined || marker === '') break
  }
  return { subnets }
}

/**
 * One VPC API subnet as an inventory resource.
 *
 * `properties.vpc_id` is what places it: `locationRank` reads the attribute's
 * noun, so a subnet with this field lands inside its VPC by the same rule that
 * puts anything else where it lives. The CIDR and gateway go along because a
 * reader comparing subnets needs to see the ranges.
 *
 * @param subnet - one record from the API.
 * @param region - the region it came from.
 * @returns the resource, or `undefined` when it is missing the id every node
 *   needs.
 */
export function asInventorySubnet(
  subnet: VpcSubnet,
  region: string,
): InventorySubnet | undefined {
  if (typeof subnet.id !== 'string' || subnet.id === '') return undefined
  const properties: Record<string, unknown> = {}
  if (typeof subnet.vpc_id === 'string') properties['vpc_id'] = subnet.vpc_id
  if (typeof subnet.cidr === 'string') properties['cidr'] = subnet.cidr
  if (typeof subnet.gateway_ip === 'string') properties['gateway_ip'] = subnet.gateway_ip
  if (typeof subnet.status === 'string') properties['status'] = subnet.status
  return {
    id: subnet.id,
    name: typeof subnet.name === 'string' ? subnet.name : subnet.id.slice(0, 8),
    provider: 'vpc',
    type: 'subnets',
    region,
    properties,
  }
}