/**
 * From a terraform resource to what BSS needs to price it.
 *
 * ## The two codes, and why neither is derivable
 *
 * The rating API wants BSS's own vocabulary: a `cloud_service_type`
 * (`hws.service.type.ec2`) and a `resource_type` (`hws.resource.type.vm`).
 * Neither follows from the terraform type by rule:
 *
 *   - `huaweicloud_compute_instance` bills under `ec2`, not `compute`;
 *   - `huaweicloud_nat_gateway` bills under `natgateway`;
 *   - an RDS instance bills under `hws.resource.type.rds.vm`, and
 *     `hws.resource.type.rds` is a different product that answers
 *     `CBC.6074`, the code that otherwise means "not sold to this account".
 *
 * So the service is carried in a table — one line per service family, with its
 * known irregularities — and the resource type is looked up in the catalogue,
 * choosing among what that service sells by the shape of the resource.
 *
 * ## Why the table is small and the catalogue is asked
 *
 * The provider has 1961 resource types and BSS 2535, and they are not the same
 * set. A table covering both would be wrong within a provider release. The
 * service family is stable — ECS is ECS — so it is written down; the resource
 * type inside a service is data, so it is queried.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/rating-map
 */

/**
 * How one terraform type becomes a BSS inquiry.
 *
 * `spec` says where the price-bearing value lives, because the provider is
 * inconsistent about it: compute instances take `flavor_id`, managed databases
 * take `flavor`, and a DCS instance additionally needs a `capacity` because one
 * spec code covers every size.
 */
export interface RatingRule {
  /** The BSS service family, e.g. `hws.service.type.ec2`. */
  readonly serviceType: string
  /** Attribute names holding the spec, in preference order. */
  readonly specAttributes: readonly string[]
  /**
   * Whether the spec needs an OS suffix. Compute bills Linux and Windows at
   * different rates for one flavour, and the API's own contract says to append
   * `.linux` or `.win`.
   */
  readonly platformSuffix?: boolean
  /** Whether the resource is sold by capacity, and where that number lives. */
  readonly capacityAttribute?: string
  /** Where the capacity lives when the provider nests it in a block. */
  readonly capacityBlock?: string
  /**
   * Which of the service's resource types this shape needs, as a suffix or a
   * full code. Absent means "the service's own code", e.g. `hws.resource.type.dcs`
   * from `hws.service.type.dcs`.
   */
  readonly resourceTypeHint?: string
  /**
   * Where the attributes live when the provider nests them in a block.
   *
   * An EIP keeps its billing mode in `publicip.type` and its bandwidth in
   * `bandwidth.size`, not at the top level — so a rule that only reads top-level
   * attributes finds nothing and reports the resource as unpriced. The plan
   * carries these as a list of block bodies, one per repetition.
   */
  readonly attributeBlock?: string
  /**
   * The value substituted into the spec template, when the spec is composed
   * from attributes rather than named by one.
   *
   * An EIP's `resource_spec` is `5_bgp` or `19_bgp`: the leading number is the
   * billing kind and the suffix its charge mode, and only `publicip.type` names
   * it directly. `{value}` is replaced by the attribute named here.
   */
  readonly specAttribute?: string
  /**
   * The spec code itself, when the provider names none.
   *
   * A load balancer's plan says `l4_flavor_id`, not which BSS product that
   * bills under, and a VPCEP endpoint carries no spec at all — one is sold. For
   * those the catalogue's own code IS the spec, and writing it here is the same
   * kind of decision as `serviceType`: a measured fact, verified by the price
   * that comes back.
   */
  readonly fixedSpec?: string
  /**
   * Whether the attribute holds the spec in a different case than BSS sells it.
   *
   * APIG's provider attribute is `edition` and takes `Basic`; the billing spec
   * is `BASIC`. The mapping is a case change and nothing else, so it is
   * declared rather than duplicated as a code table that would drift.
   */
  readonly upperCaseSpec?: boolean
}

/**
 * The services this module can price.
 *
 * Each entry was established against the live catalogue and rating API — the
 * service code, the resource type it resolves to, and a priced response for a
 * real spec. A type absent here is reported as unpriced, never guessed: a wrong
 * classification attaches a number to the wrong product, and a wrong number is
 * worse than a stated gap.
 */
const RULES: Readonly<Record<string, RatingRule>> = {
  huaweicloud_compute_instance: {
    serviceType: 'hws.service.type.ec2',
    specAttributes: ['flavor_id', 'flavor_name'],
    platformSuffix: true,
    resourceTypeHint: 'vm',
  },
  huaweicloud_rds_instance: {
    serviceType: 'hws.service.type.rds',
    specAttributes: ['flavor'],
    resourceTypeHint: 'rds.vm',
  },
  // The spec codes for the next four come from the catalogue
// (`/v2/products/resource-specs-query`), not from a provider attribute and not
// from a guess. A wrong spec answers CBC.99006006 "Product not found", which
// reads as "this is not sold" about a product that is — so each is taken from
// the same source the rating API bills against.
  huaweicloud_nat_gateway: {
    // Sold as `natgateway_middle` / `natgateway_large`, by size. The provider's
    // `spec` attribute takes those same codes.
    serviceType: 'hws.service.type.natgateway',
    specAttributes: ['spec'],
    resourceTypeHint: 'natgateway',
  },
  huaweicloud_elb_loadbalancer: {
    // A shared load balancer bills as resource type `elbv2` with spec
    // `elbv2.basic.default`, under `hws.service.type.elb` — singular, because
    // `elbv3` is a resource type rather than a service.
    //
    // The provider names its flavour (`l4_flavor_id`), never the billing
    // product, so the spec is fixed. `elbv3` is the dedicated line: it lists
    // specs but has no on-demand billing item, so naming `elbv2` here is what
    // makes the shared form priceable at all.
    serviceType: 'hws.service.type.elb',
    specAttributes: [],
    fixedSpec: 'elbv2.basic.default',
    resourceTypeHint: 'elbv2',
  },
  huaweicloud_apig_instance: {
    // APIG's specs are tier names, and the provider's `edition` attribute
    // carries them in a different case (`Basic` against `BASIC`).
    serviceType: 'hws.service.type.apig',
    specAttributes: ['edition'],
    upperCaseSpec: true,
    resourceTypeHint: 'apig.instance',
  },
  huaweicloud_vpcep_endpoint: {
    // One spec, `vpcep.basic`; the service has no other shape. The provider
    // does not name it, so it is fixed. The hourly charge only — traffic
    // through the endpoint is billed separately.
    serviceType: 'hws.service.type.vpc',
    specAttributes: [],
    fixedSpec: 'vpcep.basic',
    resourceTypeHint: 'vpcep',
  },
  // Deliberately absent, each for a measured reason — a rule that fails at the
  // API is worse than no rule, because it reports a broken product instead of an
  // unpriced one:
  //
  //   - `huaweicloud_obs_bucket`: its charge is per-dimension — storage size,
//     then PUT/GET/DELETE request counts, traffic and bandwidth, each its own
//     usage type (`ListUsageTypes` returns 144 of them for this service).
//     Those codes are not resource specs: every one answers CBC.99006074 when
//     priced, the same response a wrong resource type gets. OBS bills on
//     consumption rather than on an up-front order, so what it owes is read
//     from the bill, not quoted from the rating API.
  huaweicloud_dcs_instance: {
    serviceType: 'hws.service.type.dcs',
    specAttributes: ['flavor'],
    capacityAttribute: 'capacity',
    resourceTypeHint: 'dcs',
  },
  huaweicloud_vpc_eip: {
    // An EIP bills under the VPC service — not a service of its own — and its
    // `resource_spec` is the `publicip.type` value verbatim (`5_bgp` for
    // traffic-billed, `19_bgp` for bandwidth). Verified: `5_bgp` answers
    // 14.60 CNY/month.
    serviceType: 'hws.service.type.vpc',
    specAttributes: [],
    specAttribute: 'type',
    attributeBlock: 'publicip',
    // Bandwidth is a BW_… product with its own size; the traffic-billed form has
    // no capacity at all, so it is read only when `bandwidth` carries one.
    capacityBlock: 'bandwidth',
    capacityAttribute: 'size',
    resourceTypeHint: 'ip',
  },
  huaweicloud_evs_volume: {
    // `ebs`, not `evs`: the catalogue lists 云硬盘 as `hws.service.type.ebs`,
    // and `…evs` answers a parameter error. Verified by pricing a 40 GB SAS
    // volume at 14.31 CNY/month.
    serviceType: 'hws.service.type.ebs',
    // A volume has no spec code: it is sold by size and type, and the size is
    // the price-bearing value. `resource_spec` carries the disk type.
    specAttributes: ['type'],
    capacityAttribute: 'size',
    resourceTypeHint: 'volume',
  },
}

/**
 * The rating rule for one terraform type.
 *
 * @param type - the terraform resource type.
 * @returns the rule, or `undefined` when this module cannot price that type.
 */
export function ratingRuleFor(type: string): RatingRule | undefined {
  return RULES[type]
}

/** The measure unit the API uses for GB. */
export const SIZE_MEASURE_GB = 17

/** The usage factor every hourly-priced product bills on. */
export const DURATION_FACTOR = 'Duration'

/** Hours in the month a quote is computed for. */
export const HOURS_PER_MONTH = 730

/**
 * The BSS resource type to bill one resource under, from what the service sells.
 *
 * The catalogue answers with several codes per service — `ec2` sells `vm`,
 * `vm.image`, `vm.offline` and more — so the hint picks among them. A service
 * whose own code is the answer (`dcs`) needs no hint: the plain code is one of
 * the entries.
 *
 * @param rule - the resource's rating rule.
 * @param catalogueCodes - every `resource_type` code the service sells.
 * @returns the code, or `undefined` when the catalogue does not carry it.
 */
export function chooseResourceType(
  rule: RatingRule,
  catalogueCodes: readonly string[],
): string | undefined {
  const hint = rule.resourceTypeHint
  if (hint === undefined) {
    // The service's own name: `hws.service.type.dcs` → `hws.resource.type.dcs`.
    const suffix = rule.serviceType.replace('hws.service.type.', '')
    return catalogueCodes.find(code => code === `hws.resource.type.${suffix}`)
  }
  // An exact code, then a code that ends with the hint. `rds.vm` matches
  // `hws.resource.type.rds.vm` without also matching `rds.vm.image`.
  return catalogueCodes.find(code => code === `hws.resource.type.${hint}`)
    ?? catalogueCodes.find(code => code.endsWith(`.${hint}`) && !code.startsWith(`hws.resource.type.${hint}.`))
    ?? catalogueCodes.find(code => code.endsWith(`.${hint}`))
}

/**
 * The platform a boot image implies, for the OS suffix.
 *
 * The variant is part of the price, and the API contract states the rule
 * plainly: append `.linux` or `.win` to the flavour id. The platform comes from
 * the image, which the plan names by id.
 *
 * @param imageName - the image's OS description, when the catalogue knows it.
 * @returns the suffix, or `undefined` when the image cannot be classified.
 */
export function platformSuffixOf(imageName: string | undefined): 'linux' | 'windows' | undefined {
  if (imageName === undefined) return undefined
  const lowered = imageName.toLowerCase()
  if (lowered.includes('windows')) return 'windows'
  for (const marker of ['euler', 'ubuntu', 'centos', 'debian', 'suse', 'fedora', 'alpine', 'kylin', 'openeuler']) {
    if (lowered.includes(marker)) return 'linux'
  }
  return undefined
}