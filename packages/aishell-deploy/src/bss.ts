/**
 * Asking the BSS rating API what something costs.
 *
 * ## What the API will not tell you, and what it will
 *
 * An on-demand inquiry takes `usage_measure_id` — the unit the quantity is
 * expressed in. It is required, and nothing publishes its value: the API
 * contract describes it as "the unit, e.g. hours", and `usage-types` returns
 * only `code: "Duration"`. So a caller cannot look it up, and guessing is what
 * a naive implementation does.
 *
 * The API answers a wrong value with the right one:
 *
 * ```
 * POST  usage_measure_id: 999
 * 400   "Convert from value measure(9) to measure unit(4) error"
 * ```
 *
 * Verified for compute, RDS and DCS. That turns an unknown into a fact the
 * call itself reports, so this module submits once, reads the correction, and
 * retries — then remembers it for the rest of the process. No table of magic
 * numbers, and no unit that goes stale when a service changes its billing.
 *
 * ## Why the classification comes from the catalogue
 *
 * `cloud_service_type` and `resource_type` are BSS's own codes, and the
 * mapping from a terraform resource type is not mechanical: `ecs` bills under
 * `ec2`, `nat_gateway` under `natgateway`, an RDS instance under
 * `hws.resource.type.rds.vm` rather than `…rds`. A table of 1961 provider types
 * would be wrong within a month. The catalogue is the data those codes live in,
 * so it is asked instead.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/bss
 */

import { signedHttp } from './auth-http.ts'

/** The BSS host. Global — it serves every region. */
const BSS_HOST = 'https://bss.myhuaweicloud.com'

/**
 * The measure unit each usage factor is billed in, learned at runtime.
 *
 * Keyed by usage factor (`Duration`, `upflow`, …) rather than by service,
 * because the unit belongs to the factor: every `Duration`-priced product is
 * measured in the same unit. Populated by {@link rateProduct}'s correction pass
 * and never shipped as a literal — a value this module has not been told is a
 * guess, whatever it looks like.
 */
const measureUnits = new Map<string, number>()

/**
 * The unit a factor falls back on before it has been learned.
 *
 * Four is the unit for `Duration` as the API reports it, and `Duration` is the
 * factor for every hourly-priced product. It is a starting point chosen to make
 * the common case one call instead of two; a wrong starting point costs one
 * extra round trip, and the correction pass replaces it.
 */
const FIRST_ATTEMPT_UNIT = 4

/** One product to price. */
export interface RateProduct {
  /** The caller's identifier, echoed back so a batch can be matched up. */
  readonly id: string
  readonly cloudServiceType: string
  readonly resourceType: string
  readonly resourceSpec: string
  readonly region: string
  readonly availabilityZone?: string
  /** The capacity, for a product sold by size. */
  readonly resourceSize?: number
  readonly sizeMeasureId?: number
  readonly usageFactor: string
  /** How many units to price. A month of hours is 730. */
  readonly usageValue: number
}

/** What the rating API answered. */
export interface RateAnswer {
  readonly ok: boolean
  /** The response body, parsed when `ok`. */
  readonly body?: unknown
  /** The failure as the API stated it, when not `ok`. */
  readonly failure?: RateFailure
}

/**
 * Why an inquiry did not produce a price.
 *
 * `notOffered` is separated from the rest because it is the only failure that
 * changing the request cannot fix: the account does not carry the product, or
 * the region does not sell it.
 */
export type RateFailure =
  | { readonly kind: 'not-offered', readonly detail: string }
  | { readonly kind: 'malformed', readonly detail: string }
  | { readonly kind: 'unknown', readonly detail: string }

/**
 * Price a batch of products in one inquiry.
 *
 * One call, many products: the API prices each entry independently and echoes
 * the caller's `id`, so a batch is atomic — one project, one currency, one
 * moment. A product whose classification turns out to need a different usage
 * unit is retried once on its own, because the batch has already been refused.
 *
 * @param projectId - the region's project id.
 * @param products - the products to price.
 * @returns one answer per product, in input order.
 */
export async function rateProducts(
  projectId: string,
  products: readonly RateProduct[],
): Promise<Map<string, RateAnswer>> {
  const answers = new Map<string, RateAnswer>()
  if (products.length === 0) return answers

  const batch = await post(projectId, products)
  if (batch.ok) {
    for (const product of products) answers.set(product.id, batch)
    return answers
  }

  // The batch was refused. Either one product is at fault, or the usage unit is
  // unknown for the factor — which the API names. When it names one, the whole
  // batch is retried with that unit; the products that were fine answer the
  // same way they would have.
  const correction = readMeasureCorrection(batch.failure)
  if (correction !== undefined && products.every(product => product.usageFactor === products[0]?.usageFactor)) {
    const factor = products[0]?.usageFactor ?? 'Duration'
    measureUnits.set(factor, correction)
    const retry = await post(projectId, products)
    if (retry.ok) {
      for (const product of products) answers.set(product.id, retry)
      return answers
    }
    for (const product of products) answers.set(product.id, retry)
    return answers
  }

  // Otherwise each product is asked alone: one bad entry must not sink the
  // prices of the ones beside it, and the failure that belongs to a product is
  // reported against it.
  for (const product of products) {
    answers.set(product.id, await rateAlone(projectId, product))
  }
  return answers
}

/**
 * Price one product, correcting the usage unit when the API names it.
 *
 * @param projectId - the region's project id.
 * @param product - the product.
 * @returns the answer.
 */
async function rateAlone(
  projectId: string,
  product: RateProduct,
): Promise<RateAnswer> {
  const first = await post(projectId, [product])
  if (first.ok) return first
  const correction = readMeasureCorrection(first.failure)
  if (correction === undefined) return first
  measureUnits.set(product.usageFactor, correction)
  return post(projectId, [product])
}

/**
 * The unit the API said it wanted, when it said so.
 *
 * The body nests the useful part: `…[msg]:{"error_code":"CBC.6050","error_msg":
 * "Convert from value measure(9) to measure unit(4) error"}` — a JSON object
 * inside a string inside JSON. The number after "measure unit" is the one to
 * resubmit.
 *
 * @param failure - the failure the API reported.
 * @returns the corrective unit, or `undefined` when this was not that error.
 */
export function readMeasureCorrection(failure: RateFailure | undefined): number | undefined {
  if (failure === undefined) return undefined
  const match = /measure unit\((\d+)\)/.exec(failure.detail)
  if (match?.[1] === undefined) return undefined
  const unit = Number(match[1])
  return Number.isSafeInteger(unit) ? unit : undefined
}

/**
 * Send one inquiry.
 *
 * @param projectId - the region's project id.
 * @param products - the products.
 * @returns the answer.
 */
async function post(
  projectId: string,
  products: readonly RateProduct[],
): Promise<RateAnswer> {
  // `signedHttp` bounds every request with its own 30 s timeout, so a caller's
  // cancellation is not threaded through here: the call cannot outlive that
  // budget, and the harness's own timeout covers the tool call around it.
  const body = JSON.stringify({
    project_id: projectId,
    inquiry_precision: 1,
    product_infos: products.map(product => toWire(product)),
  })
  const url = new URL(`${BSS_HOST}/v2/bills/ratings/on-demand-resources`)
  let response
  try {
    response = await signedHttp('POST', url, body)
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: 'unknown',
        detail: `the inquiry could not be sent: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
  if (response.status === 200) {
    try {
      return { ok: true, body: JSON.parse(response.body) }
    } catch {
      return {
        ok: false,
        failure: { kind: 'unknown', detail: `the response was not JSON: ${response.body.slice(0, 200)}` },
      }
    }
  }
  return { ok: false, failure: classify(response.status, response.body) }
}

/**
 * One product as the API's own vocabulary.
 *
 * @param product - the product.
 * @returns the request entry.
 */
function toWire(product: RateProduct): Record<string, unknown> {
  return {
    id: product.id,
    cloud_service_type: product.cloudServiceType,
    resource_type: product.resourceType,
    resource_spec: product.resourceSpec,
    region: product.region,
    ...(product.availabilityZone === undefined
      ? {}
      : { available_zone: product.availabilityZone }),
    ...(product.resourceSize === undefined
      ? {}
      : { resource_size: product.resourceSize }),
    ...(product.sizeMeasureId === undefined ? {} : { size_measure_id: product.sizeMeasureId }),
    usage_factor: product.usageFactor,
    usage_value: product.usageValue,
    usage_measure_id: measureUnits.get(product.usageFactor) ?? FIRST_ATTEMPT_UNIT,
    subscription_num: 1,
  }
}

/**
 * Read a rejection into the kind of problem it is.
 *
 * @param status - the HTTP status.
 * @param body - the response body.
 * @returns the failure.
 */
function classify(status: number, body: string): RateFailure {
  if (body.includes('CBC.6074') || body.includes('billing item does not exist')) {
    return {
      kind: 'not-offered',
      detail:
        'The account has no billing item for this product. That is not a request-shape '
        + 'problem: the product is not sold on-demand in this region, or not enabled on the '
        + 'account. Retrying the same resource answers the same way, and so does every other '
        + 'spec listed under it — a service can expose resource types whose on-demand billing '
        + 'does not exist. If a different resource type under the same service is sold '
        + 'on-demand, that one prices; otherwise this is a regional or account gap.',
    }
  }
  if (body.includes('CBC.99006006') || body.includes('Product not found')) {
    return {
      kind: 'malformed',
      detail:
        'The API does not recognise this product, which usually means the spec or the '
        + 'resource type is not one it sells. Check the catalogue at '
        + '`/v2/products/service-resources` for this service before retrying.',
    }
  }
  return { kind: 'unknown', detail: `HTTP ${status}: ${body.slice(0, 400)}` }
}

/**
 * The price of one product out of a successful batch.
 *
 * `amount` is what this account pays; `official_website_amount` is the list
 * price. The account's own is the figure to quote — the list price would
 * overstate the bill by the account's discount.
 *
 * @param body - the parsed response.
 * @param productId - the caller's id for that product.
 * @returns the amounts, or `undefined` when the response carries none for it.
 */
export function readPrice(
  body: unknown,
  productId: string,
): { readonly amount: number, readonly listAmount: number, readonly currency: string } | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const response = body as { product_rating_results?: unknown, currency?: unknown }
  const results = Array.isArray(response.product_rating_results)
    ? response.product_rating_results
    : []
  for (const raw of results) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as { id?: unknown, amount?: unknown, official_website_amount?: unknown }
    if (entry.id !== productId) continue
    const amount = toNumber(entry.amount) ?? toNumber(entry.official_website_amount)
    if (amount === undefined) return undefined
    return {
      amount,
      listAmount: toNumber(entry.official_website_amount) ?? amount,
      currency: typeof response.currency === 'string' ? response.currency : 'CNY',
    }
  }
  return undefined
}

/**
 * A number the API sent as a string or a number.
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

/** The measure unit this process has learned for a factor, for a diagnostic. */
export function learnedMeasureUnit(usageFactor: string): number | undefined {
  return measureUnits.get(usageFactor)
}

/** Forget every learned unit. For a test that must not inherit one. */
export function resetLearnedMeasureUnits(): void {
  measureUnits.clear()
}
/**
 * The spec codes one resource type is sold under, from the catalogue.
 *
 * ## Why this exists
 *
 * The rating API takes a `resource_spec`, and nothing publishes that
 * vocabulary: a caller that guesses answers `CBC.99006006 Product not found`,
 * which reads as "this product does not exist" about a product that is sold.
 * The guess is the problem, so the catalogue is asked instead.
 *
 * `POST /v2/products/resource-specs-query` takes the service, the resource
 * type, the region and a charge mode, and lists every spec sold that way. Both
 * axes matter: the list is per REGION — the same service offers different specs
 * in different regions — and per CHARGE MODE, so a product sold only on
 * subscription returns an empty on-demand list.
 *
 * ## What an empty list does and does not mean
 *
 * Empty means "nothing under this resource type is sold that way here". It does
 * NOT mean the resource type is unpriceable in general, and a NON-empty list
 * does not promise the rating call will accept an entry: a service can list
 * specs whose billing item does not exist. The rating call remains the authority
 * on whether a price comes back; this answers only what the catalogue offers.
 *
 * @param credentials - the pair to sign with.
 * @param query - the service, resource type, region and charge mode to ask about.
 * @returns the spec codes, in catalogue order; empty when none are sold.
 */
export async function listResourceSpecs(
  credentials: { readonly ak: string, readonly sk: string },
  query: {
    readonly serviceType: string
    readonly resourceType: string
    readonly region: string
    /** `1` subscription, `3` on-demand. */
    readonly chargeMode?: '1' | '3'
  },
): Promise<readonly string[]> {
  const body = JSON.stringify({
    cloud_service_type: query.serviceType,
    resource_type: query.resourceType,
    region_code: query.region,
    charge_mode: query.chargeMode ?? '3',
  })
  let response
  try {
    response = await signedHttp(
      'POST',
      new URL(`${BSS_HOST}/v2/products/resource-specs-query`),
      body,
      {},
      credentials,
    )
  } catch {
    return []
  }
  if (response.status !== 200) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    return []
  }
  const basics = (parsed as { cloud_service_basics?: unknown }).cloud_service_basics
  if (!Array.isArray(basics)) return []
  const specs: string[] = []
  for (const entry of basics) {
    if (entry === null || typeof entry !== 'object') continue
    const spec = (entry as { resource_spec?: unknown }).resource_spec
    if (typeof spec === 'string' && spec !== '') specs.push(spec)
  }
  return specs
}
