/**
 * Where the account's projects are, by region.
 *
 * ## Why this is one module
 *
 * A region-scoped HuaweiCloud API puts a project id in the path, and the id is
 * not the account id: one account has one project per region, and pairing a
 * project with another region's host answers HTTP 400. Three callers need that
 * mapping — the price quote, the catalogue lookup, and the subnet listing that
 * completes an inventory — and three private copies of the same IAM call would
 * be three places to keep in step.
 *
 * ## The endpoint is global
 *
 * `iam.myhuaweicloud.com` (no region prefix) answers with every project the
 * account has, in every region, in one response. So one call serves a plan that
 * spans several regions, and the result is worth keeping for the life of one
 * tool call.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/projects
 */

import { signedHttp } from './auth-http.ts'
import type { Credentials } from './credentials.ts'

/**
 * Every project the account has, keyed by region name.
 *
 * @param credentials - the pair to sign with.
 * @returns region name → project id.
 * @throws when IAM cannot answer, with its own reason.
 */
export async function projectMap(
  credentials: Credentials,
): Promise<Map<string, string>> {
  const response = await signedHttp(
    'GET',
    new URL('https://iam.myhuaweicloud.com/v3/projects'),
    '',
    {},
    credentials,
  )
  if (response.status !== 200) {
    throw new Error(
      `could not read the project list from IAM (HTTP ${response.status}): `
      + `${response.body.slice(0, 300)}`,
    )
  }
  const parsed = JSON.parse(response.body) as { projects?: { id?: unknown, name?: unknown }[] }
  const byRegion = new Map<string, string>()
  for (const project of parsed.projects ?? []) {
    if (typeof project.name === 'string' && typeof project.id === 'string') {
      byRegion.set(project.name, project.id)
    }
  }
  return byRegion
}

/**
 * The project id for one region, or a message naming what the account does have.
 *
 * @param projects - the map from {@link projectMap}.
 * @param region - the region a request is going to.
 * @returns the project id.
 * @throws when the account has no project there, listing the regions it does.
 */
export function projectIn(
  projects: ReadonlyMap<string, string>,
  region: string,
): string {
  const known = projects.get(region)
  if (known !== undefined) return known
  throw new Error(
    `the account has no project in ${region}. `
    + `Its projects are in: ${[...projects.keys()].sort().join(', ')}.`,
  )
}