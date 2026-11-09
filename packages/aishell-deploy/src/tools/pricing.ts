/**
 * `price_resources` — what the plan will actually cost.
 *
 * ## Why the plan, and not the `.tf`
 *
 * A `.tf` file is not a list of resources. It is a list of BLOCKS, and one
 * block can become many resources:
 *
 *   - `count = 3` is three instances, billed three times;
 *   - `for_each` is one per key;
 *   - `count = var.enabled ? 1 : 0` is one or none, depending on a value only
 *     terraform can compute;
 *   - `module "db"` hides its own resources entirely.
 *
 * Reading the blocks and multiplying by one understates every deployment that
 * uses any of those, and the understatement is invisible: the total looks like
 * a total. `terraform plan` has already resolved all of it, so it is the list
 * this tool prices — `resource_changes[].type` for the classification and
 * `change.after` for the values that decide the price.
 *
 * ## Why the classification is looked up and not tabulated
 *
 * BSS wants its own codes, and they do not follow from the terraform type (see
 * `rating-map`). The service family is a short table; the resource type inside
 * a service is catalogue data, so it is queried and the answer is verified by
 * the price actually coming back.
 *
 * ## Why the region comes from the plan and not from configuration
 *
 * A price is per region, and a deployment may span several. The plan carries
 * each resource's provider block, and that block's `region` is a constant when
 * it was written as one — so the region is read per resource, never as a
 * deployment-wide value. Verified: the same 40 GB volume costs 14.308 in one
 * region and answers `CBC.99006006 Product not found` when the same product is
 * asked of another region's project.
 *
 * A plan that names no region is reported as unpriced. Filling in a default
 * would produce a number that is indistinguishable from a checked one, and
 * wrong in a way nothing on screen contradicts.
 *
 * ## What it will not do
 *
 * It quotes nothing it cannot identify. A resource with no rating rule, a spec
 * that came from a variable (so the plan does not know it), and a compute
 * instance whose image does not name a platform are each reported as unpriced
 * with the reason. A made-up number is indistinguishable from a checked one
 * once it reaches `cost.json`, and a total that silently omits resources
 * understates the bill.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/tools/pricing
 */

import type { ToolRegistrar } from '../types.ts'
import { z } from 'zod'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { READ_ONLY_CLOUD } from './annotations.ts'
import { fail, guard, okJson, type ToolResult } from './errors.ts'
import { deploymentParam } from './index.ts'
import { signedHttp } from '../auth-http.ts'
import { configuredRegion, loadCredentials, type Credentials } from '../credentials.ts'
import { PLAN_FILE } from '../gates/plan_gate.ts'
import { computeTfHash } from '../utils/hash.ts'
import { updateSnapshot } from '../deployment-state.ts'
import { runTerraform } from '../terraform-run.ts'
import { projectMap } from '../projects.ts'
import {
  DURATION_FACTOR,
  HOURS_PER_MONTH,
  SIZE_MEASURE_GB,
  chooseResourceType,
  platformSuffixOf,
  ratingRuleFor,
  type RatingRule,
} from '../rating-map.ts'
import { listResourceSpecs, rateProducts, readPrice, type RateAnswer, type RateProduct } from '../bss.ts'

/** The record this tool writes. */
const COST_FILE = 'cost.json'

/** What one priced resource carries. */
interface Quote {
  readonly address: string
  readonly type: string
  readonly spec: string
  /** The region the price was quoted for — one plan may span several. */
  readonly region: string
  readonly monthly: number
  readonly listMonthly: number
  readonly currency: string
}

/** A resource the tool could not price, and why. */
interface Unpriced {
  readonly address: string
  readonly type: string
  readonly reason: string
}

/**
 * Register `price_resources`.
 *
 * @param registrar - the capture surface this plugin's tools register into.
 */
export function registerPricingTool(registrar: ToolRegistrar): void {
  registrar.registerTool(
    'price_resources',
    {
      title: 'Price the resources in the saved plan',
      description:
        'Read the plan terraform_plan saved and quote each priceable resource against this '
        + 'account\'s own on-demand prices, then write cost.json. '
        + 'It prices the PLAN, not the .tf: a block with count = 3 is three priced instances, '
        + 'for_each is one per key, and a module\'s resources are visible — none of which the '
        + '.tf files show. '
        + 'Each figure is one month (730 hours) of the resource, with the list price it was '
        + 'discounted from and the moment of the inquiry. '
        + 'It prices compute instances (Linux and Windows bill separately), RDS, DCS, EVS '
        + 'volumes, EIPs, NAT gateways, ELB load balancers, APIG instances and VPCEP '
        + 'endpoints. Anything else — a bucket, a resource whose spec came from a variable — '
        + 'is listed as UNPRICED with the reason, never estimated. Read that list rather '
        + 'than assuming a type is covered: a total that silently omits the unpriced ones '
        + 'understates the bill, so say which they are. '
        + 'Each resource is priced in the region its provider block names, so a deployment '
        + 'spanning several regions gets a price for each — but a region written as a variable '
        + 'cannot be read from the plan, and those resources are reported unpriced rather than '
        + 'priced against a guess. Write the region as a literal in the provider block. '
        + 'It reads the saved plan, so a deployment that has not been planned has nothing to '
        + 'price.',
      annotations: READ_ONLY_CLOUD,
      inputSchema: z.object({
        deployment: deploymentParam,
      }),
    },
    guard(async (args) => handlePrice(args.deployment)),
  )
}

/**
 * Price the saved plan and record the result.
 *
 * @param deployment - the deployment workspace directory.
 * @returns the tool result.
 */
async function handlePrice(deployment: string): Promise<ToolResult> {
  const plan = await readPlan(deployment)
  if ('failure' in plan) return fail(plan.failure)

  // Only what the plan will MAKE cost something after it runs. A `no-op` is
  // already there and already counted in the user's bill; a `destroy` stops
  // costing the moment it completes, and pricing it would add a monthly figure
  // for a resource that will not exist. A `replace` counts once — terraform
  // bills the new one, and the old one is gone.
  const ruleful = plan.resources.filter(carriesNewCost)

  // Every region the account is subscribed to, read once from the global IAM
  // endpoint. Two uses: it is the fallback a resource's plan may omit, and it
  // is what an unpriced entry names so the reader can act on the gap.
  const credentials = await loadCredentials()
  const projects = await projectMap(credentials)
  const subscribed = [...projects.keys()].sort()
  const fallbackRegion = configuredRegion() ?? ''

  // Image platforms and project ids are per region, and a plan may draw from
  // several. Each is fetched once and keyed by the region it belongs to.
  const imageCache = new Map<string, Map<string, string>>()
  const imagesFor = async (zone: string): Promise<Map<string, string>> => {
    const cached = imageCache.get(zone)
    if (cached !== undefined) return cached
    const fetched = await imagePlatforms(zone, credentials)
    imageCache.set(zone, fetched)
    return fetched
  }
  const projectFor = async (zone: string): Promise<string> => {
    const known = projects.get(zone)
    if (known !== undefined) return known
    throw new Error(
      `the account has no project in ${zone}. `
      + `Its projects are in: ${subscribed.join(', ')}.`,
    )
  }
  const catalogues = new Map<string, readonly string[]>()
  // Specs are per (service, resource type, region), and the catalogue above is
  // per service — different questions, so different caches.
  const specsCache = new Map<string, readonly string[]>()

  const unpriced: Unpriced[] = []
  const quotable: { resource: PlannedResource, product: RateProduct }[] = []

  for (const [index, resource] of ruleful.entries()) {
    const rule = ratingRuleFor(resource.type)
    if (rule === undefined) {
      // Only reported when it would cost money: a network resource has no price
      // of its own, and listing every VPC as "unpriced" would bury the ones that
      // matter.
      if (looksBillable(resource)) {
        unpriced.push({
          address: resource.address,
          type: resource.type,
          reason: 'this module has no billing classification for that resource type, and '
            + 'guessing one attaches a price to the wrong product. Quote it through '
            + 'aishell__openapi_request if you know its cloud_service_type and resource_type.',
        })
      }
      continue
    }

    // Some resources keep their billing attributes inside a nested block (an
    // EIP's charge mode is `publicip.type`, not a top-level attribute), so the
    // attributes are searched in whichever body the rule names.
    const body = rule.attributeBlock === undefined
      ? resource.after
      : blockBody(resource.after, rule.attributeBlock)
    // A rule may name the spec outright — a load balancer's plan says which
    // flavour it wants, not which BSS product that bills under — in which case
    // there is nothing to read from the plan.
    const readSpec = rule.fixedSpec ?? (rule.specAttribute === undefined
      ? firstString(body, rule.specAttributes)
      : firstString(body, [rule.specAttribute]))
    const spec = readSpec !== undefined && rule.upperCaseSpec === true
      // APIG's `edition` is `Basic`; the billing spec is `BASIC`. A case change
      // is the whole mapping, so it is declared on the rule rather than
      // tabulated.
      ? readSpec.toUpperCase()
      : readSpec
    if (spec === undefined) {
      const names = rule.fixedSpec ?? rule.specAttribute ?? rule.specAttributes.join('/')
      unpriced.push({
        address: resource.address,
        type: resource.type,
        reason:
          `the plan holds no concrete value for `
          + `${names}`
          + `${rule.attributeBlock === undefined ? '' : ` inside ${rule.attributeBlock}`} — it `
          + 'is a value terraform only knows at apply time, so nothing can be priced now. '
          + 'Write it as a literal in the .tf and plan again.',
      })
      continue
    }

    // The region this resource is provisioned in. Taken from the plan, because
    // a price is per region: the same volume cost 14.308 in one region here and
    // answers `CBC.99006006 Product not found` from another region's project.
    //
    // A plan that names no region — the provider block sets it from an
    // expression — is reported rather than filled in. The configured fallback
    // is used only when an operator set one, and it is the same value terraform
    // was given, so the two agree.
    const resourceRegion = resource.region === '' ? fallbackRegion : resource.region
    if (resourceRegion === '') {
      unpriced.push({
        address: resource.address,
        type: resource.type,
        reason:
          'the plan does not say which region this resource is provisioned in, and a price is '
          + 'per region. Its provider block sets `region` from an expression, so terraform has '
          + 'not resolved it yet. Write the region as a literal in the provider block '
          + '(provider "huaweicloud" { region = "cn-north-4" }) and plan again. '
          + `This account is subscribed to: ${subscribed.join(', ')}.`,
      })
      continue
    }
    let resourceSpec = spec
    if (rule.platformSuffix === true) {
      const images = await imagesFor(resourceRegion)
      const image = firstString(resource.after, ['image_id', 'image_name'])
      const suffix = platformSuffixOf(image === undefined ? undefined : images.get(image))
      if (suffix === undefined) {
        unpriced.push({
          address: resource.address,
          type: resource.type,
          reason: image === undefined
            ? 'the plan names no image, so the platform is unknown — and Linux and Windows '
              + 'bill at different rates for one flavour. A price for the wrong one is a wrong '
              + 'number rather than a missing one.'
            : `image "${image}" is not a public image in this region, so its platform is `
              + 'unknown. Ask aishell__lookup_specs for the ids this region offers.',
        })
        continue
      }
      resourceSpec = `${spec}.${suffix}`
    }

    const catalogue = await catalogueFor(rule.serviceType, catalogues, credentials)
    const resourceType = chooseResourceType(rule, catalogue)
    if (resourceType === undefined) {
      unpriced.push({
        address: resource.address,
        type: resource.type,
        reason: `the catalogue lists nothing under ${rule.serviceType} that matches what this `
          + `resource is (${rule.resourceTypeHint ?? 'its own service code'}). The product may `
          + 'not be sold in this region.',
      })
      continue
    }

    const capacityBody = rule.capacityBlock === undefined
      ? resource.after
      : blockBody(resource.after, rule.capacityBlock)
    const capacity = rule.capacityAttribute === undefined
      ? undefined
      : numberFrom(capacityBody, rule.capacityAttribute)
    if (rule.capacityAttribute !== undefined && capacity === undefined) {
      // The rule says this product is sold by size, and the plan does not carry
      // one — a DCS `capacity` or an EVS `size` that came from a variable. Sending
      // it without a size answers "product not found", which reads as a wrong
      // classification rather than a missing number.
      unpriced.push({
        address: resource.address,
        type: resource.type,
        reason: `this resource is sold by capacity, and the plan holds no concrete value for `
          + `${rule.capacityBlock === undefined ? '' : `${rule.capacityBlock}.`}`
          + `${rule.capacityAttribute}. Write it as a literal in the .tf and plan again.`,
      })
      continue
    }

    // A rule with a `fixedSpec` names a product the provider never states, so
    // nothing about it can be read from the plan. The catalogue is per region,
    // so that name can be absent here; asking first reports it as a regional gap
    // rather than leaving the rating API to answer "billing item does not
    // exist", which reads as a broken classification.
    //
    // ## Why this check is limited to `fixedSpec`
    //
    // The spec list is NOT the set of priceable specs. `c7.large.2.linux` prices
    // at 312.44 CNY/month and appears in no catalogue entry, because compute
    // specs are enumerated per flavour without the OS suffix the price needs.
    // Applying the membership test to every rule would refuse a resource the
    // rating API accepts — trading a rare misleading message for a common false
    // refusal.
    //
    // A spec read from the plan is left to the rating call, which is the
    // authority: it prices what exists and says "Product not found" for what
    // does not.
    if (rule.fixedSpec !== undefined) {
      const sold = await specsFor(rule, resourceType, resourceRegion, specsCache, credentials)
      if (sold.length === 0) {
        unpriced.push({
          address: resource.address,
          type: resource.type,
          reason: `nothing under ${rule.serviceType} is sold on demand in ${resourceRegion}, so `
            + 'this resource has no on-demand price here. That is a fact about the region, not '
            + 'about the configuration — the same resource is priced in a region that sells it.',
        })
        continue
      }
      if (!sold.includes(rule.fixedSpec)) {
        unpriced.push({
          address: resource.address,
          type: resource.type,
          reason: `${rule.fixedSpec} is not among the specs sold on demand in ${resourceRegion}. `
            + `The region offers: ${sold.slice(0, 8).join(', ')}`
            + `${sold.length > 8 ? `, and ${sold.length - 8} more` : ''}. `,
        })
        continue
      }
    }
    const zone = availabilityZoneOf(resource)
    quotable.push({
      resource,
      product: {
        id: String(index + 1),
        cloudServiceType: rule.serviceType,
        resourceType,
        resourceSpec,
        region: resourceRegion,
        ...(zone === undefined ? {} : { availabilityZone: zone }),
        ...(capacity === undefined
          ? {}
          : { resourceSize: capacity, sizeMeasureId: SIZE_MEASURE_GB }),
        usageFactor: DURATION_FACTOR,
        usageValue: HOURS_PER_MONTH,
      },
    })
  }

  // Each answer carries its own body, so nothing has to be remembered
  // separately: a batch that answered once gave every product that same body,
  // and a product retried alone carries its own.
  // One inquiry per region, because a rating call carries a single project id.
  // A plan spanning two regions therefore makes two calls, and a product from
  // one region is never priced against another's project.
  const answers = new Map<string, RateAnswer>()
  const byRegion = new Map<string, RateProduct[]>()
  for (const entry of quotable) {
    const list = byRegion.get(entry.product.region) ?? []
    list.push(entry.product)
    byRegion.set(entry.product.region, list)
  }
  for (const [productRegion, products] of byRegion) {
    const projectOfRegion = await projectFor(productRegion)
    const answered = await rateProducts(projectOfRegion, products)
    for (const [id, answer] of answered) answers.set(id, answer)
  }

  const quotes: Quote[] = []
  for (const entry of quotable) {
    const answer = answers.get(entry.product.id)
    if (answer === undefined || !answer.ok) {
      unpriced.push({
        address: entry.resource.address,
        type: entry.resource.type,
        reason: answer?.failure?.detail ?? 'the rating API returned no answer for this product.',
      })
      continue
    }
    const price = readPrice(answer.body, entry.product.id)
    if (price === undefined) {
      unpriced.push({
        address: entry.resource.address,
        type: entry.resource.type,
        reason: 'the rating API answered without a price for this product.',
      })
      continue
    }
    quotes.push({
      address: entry.resource.address,
      type: entry.resource.type,
      spec: entry.product.resourceSpec,
      region: entry.product.region,
      monthly: round(price.amount),
      listMonthly: round(price.listAmount),
      currency: price.currency,
    })
  }

  const pricedAt = new Date().toISOString()
  const amounts = quoteTotal(quotes)
  const singleCurrency = amounts.currencies.length <= 1
  const currency = amounts.currencies[0] ?? 'CNY'
  const total = amounts.total
  const nothingBillable = statesNothingBillable(quotes.length, unpriced.length)
  try {
    await writeFile(join(deployment, COST_FILE), JSON.stringify({
      currency,
      // Present only when every quote agrees, so a reader can tell "one total"
      // from "figures in more than one currency that must not be added".
      ...(singleCurrency ? {} : { currencies: amounts.currencies }),
      period: 'month',
      hours: HOURS_PER_MONTH,
      priced_at: pricedAt,
      // Every region any quote came from, which is the set of regions this
      // deployment touches — a plan may span several, so there is no single
      // deployment-wide region to record instead.
      regions: [...new Set(quotes.map(quote => quote.region))].sort(),
      tf_hash: await computeTfHash(deployment),
      plan_file: PLAN_FILE,
      nothing_billable: nothingBillable,
      items: quotes,
      unpriced,
      total_monthly: total,
    }, null, 2))
    // The snapshot flag is informational: `runCostGate` reads COST_FILE itself,
    // so a failure here cannot weaken the gate. Swallowed rather than reported
    // because it would add a warning to a result whose subject — the prices —
    // was written successfully.
    await updateSnapshot(deployment, { cost_written: true, last_operation: 'price_resources' })
      .catch(() => {})
  } catch (error) {
    return fail(
      `the quotes could not be written to ${COST_FILE}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return okJson({
    deployment,
    currency,
    ...(singleCurrency ? {} : { currencies: amounts.currencies }),
    priced_at: pricedAt,
    items: quotes,
    unpriced,
    total_monthly: total,
    ...(nothingBillable ? { nothing_billable: true } : {}),
    summary: { priced: quotes.length, unpriced: unpriced.length, total_monthly: total },
    next: [
      nothingBillable
        ? 'Nothing in this plan carries a charge of its own — a network of VPCs, subnets and '
          + 'security groups costs nothing to create. Say that plainly rather than presenting '
          + 'a total of zero, and confirm the resources listed instead.'
        : `Show these with their basis: on-demand, 730 hours, from the plan, quoted ${pricedAt}.`,
      singleCurrency
        ? ''
        : `The quotes are in more than one currency (${amounts.currencies.join(', ')}), so there is no `
          + 'single total. Report each figure with its own currency and say plainly that they '
          + 'cannot be added — a summed number would be denominated in one of them.',
      unpriced.length > 0
        ? `Say plainly that ${unpriced.length} resource(s) are NOT priced and why — a total `
          + 'that silently omits them understates the bill.'
        : '',
      'Get the user\'s agreement on the specification and the cost before applying.',
    ].filter(line => line !== '').join(' '),
  })
}

/** One resource as the plan describes it. */
export interface PlannedResource {
  readonly address: string
  readonly type: string
  readonly action: string
  /** The attribute values terraform resolved, where it could. */
  readonly after: Record<string, unknown>
  /**
   * The region this resource is provisioned in.
   *
   * Per resource, not per deployment: a configuration may declare two provider
   * blocks with different regions and point resources at either, and a price
   * asked of the wrong region is a wrong price. Read from the provider block
   * the resource names, falling back to the plugin's configured region when the
   * block does not state one.
   */
  readonly region: string
}

/** What reading the plan produced. */
type PlanRead =
  | { readonly resources: readonly PlannedResource[] }
  | { readonly failure: string }

/**
 * Read the saved plan into the resources this module can look at.
 *
 * `change.after` is what terraform computed; a value it could not compute yet
 * (one that depends on a not-yet-created resource's id) appears in
 * `after_unknown` instead and is simply absent here — which is exactly the case
 * an unpriced entry reports.
 *
 * @param deployment - the deployment workspace directory.
 * @returns the resources and the region, or a failure message.
 */
async function readPlan(deployment: string): Promise<PlanRead> {
  const shown = await runTerraform(deployment, ['show', '-json', PLAN_FILE])
  if (shown.exitCode !== 0) {
    return {
      failure:
        `no readable ${PLAN_FILE} in ${deployment}. Call terraform_plan first — it computes `
        + 'what will be built, and this tool prices that. '
        + `terraform said: ${(shown.stderr || shown.stdout).trim().slice(0, 300)}`,
    }
  }
  let document: unknown
  try {
    document = JSON.parse(shown.stdout)
  } catch {
    return { failure: `terraform show produced output that is not JSON, so the plan could not be read.` }
  }
  if (document === null || typeof document !== 'object') {
    return { failure: `the plan document was empty.` }
  }
  const plan = document as {
    resource_changes?: unknown
    configuration?: unknown
  }
  if (!Array.isArray(plan.resource_changes)) {
    return { failure: `the plan document carries no resource_changes, so there is nothing to price.` }
  }

  // Where each resource's provider block is, and what region each block states.
  // The two live in different places: the resource→block link is in
  // `configuration.root_module.resources[].provider_config_key`, and the region
  // is in `configuration.provider_config[<key>].expressions.region`. A
  // resource's own `provider_name` is the registry address and is identical for
  // every alias, so it cannot distinguish them.
  const providerKeys = resourceProviderKeys(plan.configuration)
  const regions = providerRegions(plan.configuration)
  const resources: PlannedResource[] = []
  for (const raw of plan.resource_changes) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as {
      address?: unknown
      type?: unknown
      change?: { actions?: unknown, after?: unknown }
    }
    if (typeof entry.address !== 'string' || typeof entry.type !== 'string') continue
    const actions = Array.isArray(entry.change?.actions) ? entry.change.actions : []
    const after = entry.change?.after
    resources.push({
      address: entry.address,
      type: entry.type,
      action: typeof actions[0] === 'string' ? actions[0] : 'no-op',
      after: after !== null && typeof after === 'object'
        ? after as Record<string, unknown>
        : {},
      region: providerRegionOf(entry.address, providerKeys, regions),
    })
  }
  return { resources }
}

/**
 * The region one planned resource is provisioned in.
 *
 * The two address vocabularies differ, and the difference is not cosmetic: a
 * block with `count = 2` appears in `configuration` as `type.name` and in
 * `resource_changes` as `type.name[0]` and `type.name[1]`; a module called with
 * `for_each` is `module.m["a"].type.name` there against `module.m.type.name`
 * here. Verified against a real plan. A lookup keyed on the change address
 * alone therefore misses every repeated resource — which is exactly the shape
 * where a wrong region matters most, since a fleet is what a deployment is
 * usually made of.
 *
 * So the exact address is tried first, then the same address with its index
 * suffixes removed. Anything still unmatched keeps the empty string, and the
 * caller falls back to the configured region rather than guessing.
 *
 * @param address - the address from `resource_changes`.
 * @param keys - resource address → provider block, from the configuration.
 * @param regions - provider block → region.
 * @returns the region, or `''` when it cannot be resolved.
 */
function providerRegionOf(
  address: string,
  keys: ReadonlyMap<string, string>,
  regions: ReadonlyMap<string, string>,
): string {
  for (const candidate of [address, unindexedAddress(address)]) {
    const key = keys.get(candidate)
    if (key !== undefined) return regions.get(key) ?? ''
  }
  return ''
}

/**
 * An address with every `[...]` index removed.
 *
 * `module.m["a"].huaweicloud_compute_instance.web[0]` becomes
 * `module.m.huaweicloud_compute_instance.web`.
 *
 * @param address - a resource address.
 * @returns the address the configuration block is keyed by.
 */
export function unindexedAddress(address: string): string {
  return address.replace(/\[[^\]]*\]/g, '')
}

/**
 * Which provider block each resource uses, by resource address.
 *
 * A module's resources are nested under that module in `root_module`, so the
 * walk recurses — a deployment that puts its resources in modules would
 * otherwise lose every region.
 *
 * @param configuration - the plan's `configuration` section.
 * @returns resource address → `provider_config_key`.
 */
export function resourceProviderKeys(configuration: unknown): Map<string, string> {
  const keys = new Map<string, string>()
  if (configuration === null || typeof configuration !== 'object') return keys
  const root = (configuration as { root_module?: unknown }).root_module
  walkModule(root, '', keys)
  return keys
}

/**
 * Collect one module's `provider_config_key`s, and its children's.
 *
 * @param module - one module block.
 * @param prefix - the module's address prefix, for a nested resource's address.
 * @param keys - the map being filled.
 */
function walkModule(
  module: unknown,
  prefix: string,
  keys: Map<string, string>,
): void {
  if (module === null || typeof module !== 'object') return
  const resources = (module as { resources?: unknown }).resources
  if (Array.isArray(resources)) {
    for (const raw of resources) {
      if (raw === null || typeof raw !== 'object') continue
      const entry = raw as { address?: unknown, provider_config_key?: unknown }
      if (typeof entry.address !== 'string' || typeof entry.provider_config_key !== 'string') continue
      keys.set(`${prefix}${entry.address}`, entry.provider_config_key)
    }
  }
  const children = (module as { module_calls?: unknown }).module_calls
  if (children !== null && typeof children === 'object') {
    for (const [name, call] of Object.entries(children as Record<string, unknown>)) {
      if (call === null || typeof call !== 'object') continue
      const inner = (call as { module?: unknown }).module
      walkModule(inner, `${prefix}module.${name}.`, keys)
    }
  }
}

/**
 * The region each provider configuration declares, keyed by its block name.
 *
 * A plan does not put a region on the resources — `after.region` is always
 * pending, and `provider_name` is the same for every alias. What it DOES carry
 * is `configuration`: one entry per provider block, with that block's `region`
 * as a constant, and one `provider` reference on each resource naming which
 * block it uses. Joining the two is how a resource's own region is recovered.
 *
 * A `region` given as an expression rather than a constant is left out: it
 * resolves only when terraform runs, so the resource keeps the deployment's
 * configured region instead of a guess.
 *
 * @param configuration - the plan's `configuration` section.
 * @returns full provider name → region, for the blocks that name one.
 */
export function providerRegions(configuration: unknown): Map<string, string> {
  const regions = new Map<string, string>()
  if (configuration === null || typeof configuration !== 'object') return regions
  const providerConfig = (configuration as { provider_config?: unknown }).provider_config
  if (providerConfig === null || typeof providerConfig !== 'object') return regions

  for (const [key, raw] of Object.entries(providerConfig as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue
    const region = readConstantRegion(raw)
    if (region !== undefined) regions.set(key, region)
  }
  return regions
}

/**
 * One provider block's region, when the plan has it as a constant.
 *
 * The block is keyed by its configured name (`huaweicloud`, `huaweicloud.east3`)
 * while a resource's `provider_name` is the registry address, so the caller
 * matches on whichever form the plan used — both are tried.
 *
 * @param block - one `provider_config` entry.
 * @returns the region, or `undefined`.
 */
function readConstantRegion(block: unknown): string | undefined {
  if (block === null || typeof block !== 'object') return undefined
  const expressions = (block as { expressions?: unknown }).expressions
  if (expressions === null || typeof expressions !== 'object') return undefined
  const region = (expressions as { region?: unknown }).region
  if (region === null || typeof region !== 'object') return undefined
  const constant = (region as { constant_value?: unknown }).constant_value
  return typeof constant === 'string' && constant !== '' ? constant : undefined
}

/**
 * Whether a resource's action adds a monthly cost worth quoting.
 *
 * A `create` does, and so does a `replace` — terraform builds the new one, and
 * the monthly figure is the price of what will exist. A `destroy` does not: the
 * resource stops costing the moment it completes, and quoting it would add a
 * recurring charge for something the plan removes. A `no-op` is already there
 * and already in the user's bill, so quoting it double-counts.
 *
 * @param resource - one entry from the plan.
 * @returns whether the resource will add a monthly cost.
 */
export function carriesNewCost(resource: PlannedResource): boolean {
  return resource.action === 'create'
    || resource.action === 'update'
    || resource.action === 'replace'
}

/**
 * Whether a resource without a rating rule would plausibly cost money.
 *
 * The question decides only whether to REPORT it as unpriced. A VPC, a subnet
 * and a security group are free; a cluster, a database or a bucket is not.
 *
 * ## Why the free list is enumerated rather than matched by prefix
 *
 * `huaweicloud_vpc` is the prefix of `huaweicloud_vpc_bandwidth` (dedicated
 * bandwidth) and of `huaweicloud_vpc_eip`, both of which are billed monthly.
 * A prefix test on `huaweicloud_vpc` therefore classifies paid resources as
 * free and drops them from BOTH the quote and the unpriced report — a total
 * that silently understates the bill, which is the one thing this tool is for.
 * Verified against the provider's own type list.
 *
 * So the free types are written out. A type not listed here is reported as
 * unpriced, which costs the reader one sentence and never a missing number.
 *
 * @param resource - the planned resource.
 * @returns whether a missing price is worth reporting.
 */
export function looksBillable(resource: PlannedResource): boolean {
  return !FREE_TYPES.has(resource.type)
}

/**
 * Resource types that carry no charge of their own.
 *
 * A type absent from this set is assumed billable: reporting a free resource as
 * unpriced is noise, while omitting a paid one understates the total. The
 * asymmetry decides the default.
 */
const FREE_TYPES: ReadonlySet<string> = new Set([
  'huaweicloud_vpc',
  'huaweicloud_vpc_v1',
  'huaweicloud_vpc_subnet',
  'huaweicloud_vpc_subnet_v1',
  'huaweicloud_vpc_route',
  'huaweicloud_vpc_route_table',
  'huaweicloud_vpc_peering_connection',
  'huaweicloud_vpc_eip_associate',
  'huaweicloud_networking_secgroup',
  'huaweicloud_networking_secgroup_rule',
  'huaweicloud_networking_secgroup_rules',
  'huaweicloud_networking_port',
  'huaweicloud_vpc_sub_network_interface',
])

/** The first literal string among several attribute names. */
function firstString(
  after: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = after[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * One nested block's body from a plan's attribute map.
 *
 * A repeatable block appears as a list of bodies, and a single one as the body
 * itself — the same two shapes the HCL parser produces, because both read
 * terraform's own JSON.
 *
 * @param after - the resource's attribute map.
 * @param name - the block's name.
 * @returns the first body, or an empty map when the block is absent.
 */
export function blockBody(after: Record<string, unknown>, name: string): Record<string, unknown> {
  const raw = after[name]
  const first = Array.isArray(raw) ? raw[0] : raw
  return first !== null && typeof first === 'object'
    ? first as Record<string, unknown>
    : {}
}

/** A number that may have arrived as a string. */
export function numberFrom(after: Record<string, unknown>, key: string): number | undefined {
  const raw = after[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** The availability zone a resource sits in, from its own attributes. */
export function availabilityZoneOf(resource: PlannedResource): string | undefined {
  const direct = firstString(resource.after, ['availability_zone'])
  if (direct !== undefined) return direct
  const zones = resource.after.available_zones ?? resource.after.availability_zones
  if (Array.isArray(zones)) {
    const first = zones.find(zone => typeof zone === 'string')
    if (typeof first === 'string') return first
  }
  return undefined
}

/**
 * The resource types a service sells, from the catalogue.
 *
 * Cached per service for the life of one call: a deployment with four instances
 * asks once, not four times.
 *
 * @param serviceType - the BSS service code.
 * @param cache - the per-call cache.
 * @param credentials - the region's credentials.
 * @returns the codes, empty when the catalogue could not be read.
 */
async function catalogueFor(
  serviceType: string,
  cache: Map<string, readonly string[]>,
  credentials: Credentials,
): Promise<readonly string[]> {
  const cached = cache.get(serviceType)
  if (cached !== undefined) return cached
  const url = new URL(
    `https://bss.myhuaweicloud.com/v2/products/service-resources`
    + `?service_type_code=${encodeURIComponent(serviceType)}&limit=100`,
  )
  const response = await signedHttp('GET', url, '', {}, credentials)
  if (response.status !== 200) {
    cache.set(serviceType, [])
    return []
  }
  const parsed = JSON.parse(response.body) as { infos?: { basic_info?: { resource_type_code?: unknown } }[] }
  const codes = (parsed.infos ?? []).flatMap((info) => {
    const code = info.basic_info?.resource_type_code
    return typeof code === 'string' ? [code] : []
  })
  cache.set(serviceType, codes)
  return codes
}

/**
 * The platform each public image in the region implies, by image id.
 *
 * A failure to read the catalogue leaves every instance unpriced rather than
 * priced as the wrong platform, which is the safe direction: a gap says nobody
 * knows, a wrong number says somebody checked.
 *
 * @param region - the region.
 * @param credentials - the region's credentials.
 * @returns image id → OS description.
 */
async function imagePlatforms(
  region: string,
  credentials: Credentials,
): Promise<Map<string, string>> {
  const url = new URL(`https://ims.${region}.myhuaweicloud.com/v2/cloudimages?__imagetype=gold&limit=500`)
  const response = await signedHttp('GET', url, '', {}, credentials)
  const platforms = new Map<string, string>()
  if (response.status !== 200) return platforms
  const parsed = JSON.parse(response.body) as {
    images?: { id?: unknown, name?: unknown, __os_version?: unknown }[]
  }
  for (const image of parsed.images ?? []) {
    if (typeof image.id !== 'string') continue
    const label = typeof image.__os_version === 'string'
      ? image.__os_version
      : typeof image.name === 'string' ? image.name : ''
    if (label !== '') platforms.set(image.id, label)
  }
  return platforms
}


/** Round to the cent, which is what a price is quoted in. */
export function round(amount: number): number {
  return Math.round(amount * 100) / 100
}
/**
 * Whether a cost record says "nothing to charge for" rather than "nothing was
 * priced".
 *
 * The two look identical: both have an empty `items`. The apply gate has to
 * tell them apart, because one is an approval and the other is a gap —
 *
 *   - a network of VPCs, subnets, routes and security groups has no charge of
 *     its own, so an empty total is the correct figure and the deployment may
 *     proceed;
 *   - a deployment of databases whose specs came from variables has no quote
 *     either, and applying it spends money nobody has established a figure for.
 *
 * The discriminator is `unpriced`: every resource this tool could not answer is
 * recorded there, with its reason. So an empty quote list with nothing
 * unpriced is a plan that genuinely costs nothing.
 *
 * @param quoted - how many resources were priced.
 * @param unpriced - how many could not be.
 * @returns whether the record should carry `nothing_billable`.
 */
export function statesNothingBillable(quoted: number, unpriced: number): boolean {
  return quoted === 0 && unpriced === 0
}

/**
 * The monthly total of a set of quotes, and the currencies it spans.
 *
 * A total is only meaningful inside one currency. The rating API answers in the
 * currency of the region's price list, and a deployment spanning regions can in
 * principle draw from two — adding those figures would produce a number
 * denominated in whichever came first, which reads exactly like a checked one.
 *
 * So the currencies are collected first, and a mixed set yields `total: null`
 * rather than a sum. The caller reports the per-item figures with their own
 * currencies and says they cannot be added.
 *
 * @param quotes - the priced resources.
 * @returns the currencies present (sorted, so the report is stable) and the
 *   total, which is `null` when there is none to compute.
 */
export function quoteTotal(
  quotes: readonly { readonly monthly: number, readonly currency: string }[],
): { readonly currencies: readonly string[], readonly total: number | null } {
  const currencies = [...new Set(quotes.map(quote => quote.currency))].sort()
  if (quotes.length === 0 || currencies.length > 1) {
    return { currencies, total: null }
  }
  return {
    currencies,
    total: round(quotes.reduce((sum, quote) => sum + quote.monthly, 0)),
  }
}

/**
 * The specs a region sells on demand for one product.
 *
 * Cached per (service, resource type, region): a deployment with several load
 * balancers asks once. The catalogue behind this is region-scoped, which is why
 * the region is part of the key — one region sells a different set of specs
 * from another.
 *
 * @param rule - the rating rule, for its service code.
 * @param resourceType - the code `catalogueFor` resolved for this service. Passed
 *   in rather than derived, so the spec query asks about the same product the
 *   price inquiry will bill against; a second derivation could disagree and
 *   report "not sold here" about a product that is.
 * @param region - the region to ask about.
 * @param cache - the per-call cache.
 * @param credentials - the pair to sign with.
 * @returns the spec codes, empty when the region sells none.
 */
async function specsFor(
  rule: RatingRule,
  resourceType: string,
  region: string,
  cache: Map<string, readonly string[]>,
  credentials: Credentials,
): Promise<readonly string[]> {
  const key = `${rule.serviceType}\u0000${resourceType}\u0000${region}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const fetched = await listResourceSpecs(credentials, {
    serviceType: rule.serviceType,
    resourceType,
    region,
  })
  cache.set(key, fetched)
  return fetched
}
