/**
 * Cloud resources that already exist, as the diagram shows them.
 *
 * ## Why these arrive as a parameter
 *
 * The design stage answers "what should the network be". In an account that
 * already has a VPC, that question is partly "what can be reused", and a
 * diagram drawn only from the `.tf` answers a different question: it shows what
 * will be created and says nothing about what is already there.
 *
 * The caller supplies them because it is the only party that knows which of the
 * account's resources the user is designing AROUND. `list_existing_resources`
 * returns everything in the account — usually far more than the design is
 * about — and picking the relevant subset is a judgement, not a query. An
 * automatic "match by name or CIDR" rule would be a guess, and a diagram that
 * guesses is worse than one that omits.
 *
 * ## Why they are not given terraform addresses
 *
 * These are not managed by this deployment. They have a cloud id and a name,
 * and no `type.name` address — that identity belongs to whoever's terraform
 * manages them, not to this one. They are marked instead, so a reader can tell
 * at a glance which boxes this deployment will create and which it will use.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/existing
 */

import { z } from 'zod'

/**
 * The shape a caller sends for one existing resource.
 *
 * `type` is accepted in either spelling — the terraform type
 * (`huaweicloud_vpc`) or RMS's short name (`vpc`) — because both are what a
 * caller has to hand. RMS is the likelier source: it is the tool that lists
 * what exists, and it answers with short names.
 *
 * `parent` is the containing resource's ID, which is how a caller says "this
 * ECS is in that subnet". It is optional: a caller that does not know the
 * placement still gets the box, at the root.
 */
export const ExistingResourceSchema = z.object({
  id: z.string().min(1).describe('The cloud resource ID.'),
  type: z.string().min(1).describe(
    'The resource type as whoever reported it spelled it. From '
    + 'list_existing_resources that is the RMS `type` ("vpcs", '
    + '"securityGroups", "cloudservers"); from a .tf it is the terraform type '
    + '("huaweicloud_vpc"). Do not translate between the two vocabularies — '
    + 'pass `provider` alongside an RMS type and this resolves it.',
  ),
  provider: z.string().optional().describe(
    'The RMS provider the resource came from ("vpc", "ecs", "rds"). Needed when '
    + '`type` is an RMS name and this tool has to resolve it: "instances" is a '
    + 'database under rds and an API gateway under apig, and the pair is what '
    + 'tells them apart.',
  ),
  properties: z.record(z.string(), z.unknown()).optional().describe(
    'The `properties` object from list_existing_resources, copied verbatim. '
    + 'This is where the relationships live: when one property holds another '
    + "resource's id, the two are connected. Pass it and the diagram is derived "
    + 'from the account itself, with no per-service knowledge.',
  ),
  name: z.string().optional().describe('Display name, when the cloud id is not the name.'),
  parent: z.string().optional().describe(
    "The containing resource's cloud ID, when known. An ECS's subnet, a "
    + "subnet's VPC. Resources with no parent are drawn at the root.",
  ),
  cidr: z.string().optional().describe('Address range, for a VPC or subnet.'),
  region: z.string().optional().describe('Region, when it is worth showing.'),
  flavor: z.string().optional().describe('Specification, for a compute or database resource.'),
  address: z.string().optional().describe(
    "The terraform address this resource stands for, when the configuration "
    + "references it — `huaweicloud_vpc.prod` for a VPC whose `.tf` block is "
    + "omitted because it already exists. A `.tf` reference resolves only "
    + 'through this: the cloud name and the terraform label are independent, '
    + 'so no rule can derive one from the other.',
  ),
})

/** One existing resource, as the caller described it. */
export type ExistingResource = z.infer<typeof ExistingResourceSchema>

/** The node kind an existing resource takes, from either type spelling. */
export type ExistingKind =
  | 'vpc'
  | 'subnet'
  | 'security-group'
  | 'security-group-rule'
  | 'gateway'
  | 'load-balancer'
  | 'compute'
  | 'database'

/**
 * What a resource is, as far as the topology is concerned — or nothing.
 *
 * The seven kinds that can appear are the vocabulary a network design is
 * written in. Everything else is not "an unknown kind of box": it is a
 * resource the picture is not about, and drawing it would put a key pair or an
 * alarm rule next to a subnet as if the reader should compare them.
 *
 * So the lookup answers `undefined` for those, and the caller reports them
 * instead of inventing a shape. That is the difference between "this diagram
 * shows the network" and "this diagram shows whatever the file contained".
 */
export type TopologyKind = ExistingKind

/**
 * Terraform types, mapped to the node kinds a design diagram has.
 *
 * One vocabulary only, and that matters: this table answers for a `.tf` block.
 * RMS answers with its own plurals (`vpcs`, `cloudservers`, `securityGroups`),
 * which are a different vocabulary and are resolved by
 * {@link resolveRmsType} from the provider/type pair instead. Mixing the two
 * here produced entries that could never match anything the inventory sends.
 *
 * Terraform types lose the `huaweicloud_` prefix and any `_vN` suffix before
 * lookup. Spelled out rather than assumed: `huaweicloud_vpc_subnet` reduces to
 * `vpc_subnet`, not `subnet`, and a table written from the service names alone
 * silently fails on every subnet.
 *
 * ## Why this table is small, and why that is not a coverage problem
 *
 * The provider has over a thousand resource types; this lists the ones a
 * network topology is made of. Measured against the provider's own example
 * corpus — 1368 resource instances of 438 distinct types — these kinds are 46%
 * of the instances, and what they leave out is mostly resources the picture is
 * not about: alarm rules, backups, parameter templates, key pairs,
 * subscriptions.
 *
 * A wider table would draw those too. That is the trade this table refuses: a
 * diagram is read by comparing boxes, and a box that represents nothing the
 * reader is comparing against is noise in the place where signal has to fit.
 * What is left out is reported by name instead, so nothing is hidden.
 */
const KIND_BY_SHORT_NAME: Readonly<Record<string, ExistingKind>> = {
  vpc: 'vpc',
  vpc_subnet: 'subnet',
  networking_secgroup: 'security-group',
  networking_secgroup_rule: 'security-group-rule',
  // Both spellings exist in the provider and both are installed: the networking
  // ones are the newer API and `compute_secgroup_v2` is the older one, which a
  // provider built without the networking resources still offers. Confirmed
  // against the installed provider's schema, which lists
  // `huaweicloud_compute_secgroup_v2` and not `huaweicloud_security_group`.
  compute_secgroup: 'security-group',
  compute_instance: 'compute',
  // Managed databases: the engines differ, the shape a diagram draws does not.
  // These are the ones the provider's example corpus shows most often; a new
  // engine joins by adding a line, which is the deliberate cost of keeping this
  // a decision rather than a heuristic.
  rds_instance: 'database',
  dcs_instance: 'database',
  dds_instance: 'database',
  gaussdb_instance: 'database',
  gaussdb_cassandra_instance: 'database',
  gaussdb_mysql_instance: 'database',
  gaussdb_opengauss_instance: 'database',
  taurusdb_instance: 'database',
  geminidb_instance: 'database',
  dws_cluster: 'database',
  nat_gateway: 'gateway',
  // A SNAT rule is part of the gateway that carries it, not a peer.
  nat_snat_rule: 'gateway',
  vpc_eip: 'gateway',
  elb_loadbalancer: 'load-balancer',
  // Compute beyond ECS: a container node and a function run on a subnet the
  // same way an instance does, so they take the same containment rule and the
  // same place in the picture.
  cce_cluster: 'compute',
  cce_node: 'compute',
  fgs_function: 'compute',
  // Storage that is a resource of its own. Buckets and filesystems have no
  // subnet, so they land at the root — which is where they are.
  obs_bucket: 'database',
  sfs_turbo: 'database',
  evs_volume: 'database',
}

/**
 * What one configured resource is.
 *
 * This answers for a `.tf` block, whose type is the provider's own spelling. An
 * account's resources do not come through here: the inventory already knows
 * what each one is, and a table of its vocabulary would grow with every service
 * — see `existing-topology.ts` for how that case is derived instead.
 *
 * @param type - a terraform type (`huaweicloud_vpc`) or the short name the
 *   provider's own docs use (`vpc`).
 * @returns the node kind, or `undefined` when the picture has none for it.
 */
export function kindOfExisting(type: string): ExistingKind | undefined {
  const stripped = type.replace(/^huaweicloud_/, '').replace(/_v\d+$/, '')
  return KIND_BY_SHORT_NAME[stripped]
}

/** Every kind a node may take. */
const KINDS: ReadonlySet<string> = new Set<ExistingKind>([
  'vpc',
  'subnet',
  'security-group',
  'security-group-rule',
  'gateway',
  'load-balancer',
  'compute',
  'database',
])

/**
 * What one described resource is.
 *
 * `type` is resolved on its own, which is the whole answer for a caller that
 * sent a terraform type. A caller that copied an RMS `type` has a plural
 * vocabulary ("vpcs", "cloudservers") that says nothing about what the resource
 * IS — and `instances` is both a database and an API gateway, depending on the
 * provider. So when `provider` is present it is used to disambiguate, and when
 * the pair resolves to nothing the answer is `undefined`: the resource is real
 * but this picture has no box for it.
 *
 * @param resource - the described resource.
 * @returns the kind, or `undefined` when the picture has none for it.
 */
export function kindOfResource(resource: {
  readonly type: string
  readonly provider?: string | undefined
}): ExistingKind | undefined {
  const stripped = resource.type.replace(/^huaweicloud_/, '').replace(/_v\d+$/, '')
  const direct = KIND_BY_SHORT_NAME[stripped] ?? resolveRmsType(resource.provider, stripped)
  return direct !== undefined && KINDS.has(direct) ? direct : undefined
}

/**
 * The kind an RMS plural type takes, given the provider that reported it.
 *
 * RMS names resources in the plural and per service, which is a second
 * vocabulary — not a translation of the first, and not derivable from it. It
 * exists because the inventory is the likeliest thing a caller has to hand, and
 * a caller should not have to translate what it was given.
 *
 * The provider is what makes it unambiguous: `instances` is an RDS database and
 * an APIG gateway, and the same word means neither thing on its own. That is
 * the reason the pair is required rather than either half.
 *
 * A service absent from this table draws nothing, which is the correct failure:
 * the caller is told the resource is outside the picture rather than shown a
 * box whose shape was guessed.
 *
 * @param provider - the RMS provider, or undefined when the caller omitted it.
 * @param type - the RMS type with the terraform prefix already stripped.
 * @returns the kind, or `undefined` when the pair has no box.
 */
function resolveRmsType(
  provider: string | undefined,
  type: string,
): ExistingKind | undefined {
  if (provider === undefined) return undefined
  switch (`${provider}/${type}`) {
    case 'vpc/vpcs': return 'vpc'
    case 'vpc/subnets': return 'subnet'
    case 'vpc/securityGroups': return 'security-group'
    case 'ecs/cloudservers': return 'compute'
    case 'elb/loadbalancers': return 'load-balancer'
    case 'nat/natGateways': return 'gateway'
    case 'cce/clusters': return 'compute'
    case 'cce/nodes': return 'compute'
    case 'rds/instances': return 'database'
    default: return undefined
  }
}