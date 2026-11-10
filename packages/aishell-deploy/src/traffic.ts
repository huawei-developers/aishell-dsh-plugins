/**
 * How traffic reaches the account, read from what the inventory reports.
 *
 * ## What a path is, and why these three kinds
 *
 * A path is a chain of resources where each one hands traffic to the next. The
 * inventory reports three such handoffs, and they are the only ones it reports:
 *
 *   - **Public entry** — an EIP names the instance it is attached to
 *     (`associateInstanceId`). That is the point where traffic from outside the
 *     account meets something inside it.
 *   - **Load balancer front end** — a listener names its balancer
 *     (`loadbalancers[].id`) and carries the protocol and port it answers on.
 *     That is where a request picks its port.
 *   - **Balancer back end** — a Kubernetes-managed listener carries the cluster
 *     it fronts in its `description`, as JSON. That is the hop from "a port is
 *     open" to "these pods are behind it".
 *
 * A chain is assembled by matching a resource's id against the ids other
 * resources name — the same rule the rest of the picture uses. Nothing here is
 * keyed by a service name, so a service that reports the same handoff the same
 * way joins a path without a line of code.
 *
 * ## What it deliberately does not claim
 *
 * It does not infer a hop the data does not state. A server with no recorded
 * address is not assumed to sit behind a balancer, and a balancer's pool is not
 * followed to its members: the inventory lists the pool's id but not its
 * members, so the members are a separate query away. A picture that guessed
 * those would show a flow nobody verified.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/traffic
 */

import type { AccountResource } from './account-view.ts'

/** One hop of a path. */
export interface Hop {
  /** What kind of thing this hop is, for the renderer's wording. */
  readonly kind: 'internet' | 'eip' | 'balancer' | 'listener' | 'target'
  /** The resource id, or `undefined` for the internet itself. */
  readonly id: string | undefined
  /** The address or port that makes this hop concrete, when there is one. */
  readonly detail: string | undefined
}

/** A chain from outside the account to something inside it. */
export interface TrafficPath {
  readonly hops: readonly Hop[]
}

/**
 * Read a string-valued property, unwrapping the JSON encoding the inventory
 * uses for some ids.
 *
 * @param value - the property value.
 * @returns the id it holds, or `undefined`.
 */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '' && !trimmed.startsWith('[')) return trimmed
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : undefined
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/**
 * The object an array-valued property's first entry holds.
 *
 * The provider nests one-to-many links this way: `loadbalancers: [{ id }]`,
 * `eips: [{ eip_id, eip_address }]`. Reading the first entry is enough because a
 * listener belongs to exactly one balancer and an EIP has exactly one instance.
 *
 * @param value - the property value.
 * @returns the first entry, when it is an object.
 */
function firstOf(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined
  const first = value[0]
  return first !== null && typeof first === 'object' ? first as Record<string, unknown> : undefined
}

/**
 * The cluster a listener fronts, when the listener says so.
 *
 * A listener created by the Kubernetes integration records its owner as JSON in
 * `description` — `{"cluster_id": "…", "service_id": "…"}`. That is the only
 * place the hop from the load balancer to the cluster is written down.
 *
 * @param resource - a listener.
 * @returns the cluster id, or `undefined` when the listener is not owned by one.
 */
export function clusterBehind(resource: AccountResource): string | undefined {
  const description = resource.properties?.['description']
  if (typeof description !== 'string') return undefined
  const trimmed = description.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const cluster = parsed['cluster_id']
    return typeof cluster === 'string' && cluster !== '' ? cluster : undefined
  } catch {
    // A description that is not JSON is a person's free text, not an owner.
    return undefined
  }
}

/**
 * Every path the inventory states.
 *
 * @param resources - the account's resources.
 * @returns the paths, each starting at the internet.
 */
export function trafficPaths(resources: readonly AccountResource[]): TrafficPath[] {
  const byId = new Map(resources.map(resource => [resource.id, resource]))
  const paths: TrafficPath[] = []

  // ── Public entry ────────────────────────────────────────────────────────
  //
  // An EIP attached to something is where outside traffic lands. The chain
  // continues from whatever it is attached to, which is why this builds the
  // first two hops here and leaves the rest to the balancer pass below.
  for (const resource of resources) {
    if (resource.type !== 'publicips') continue
    const attached = idOf(resource.properties?.['associateInstanceId'])
    if (attached === undefined || !byId.has(attached)) continue
    const address = typeof resource.properties?.['publicIpAddress'] === 'string'
      ? resource.properties['publicIpAddress']
      : resource.name
    paths.push({
      hops: [
        { kind: 'internet', id: undefined, detail: undefined },
        { kind: 'eip', id: resource.id, detail: address },
        { kind: 'target', id: attached, detail: undefined },
      ],
    })
  }

  // ── Balancer front end and back end ─────────────────────────────────────
  //
  // A listener names its balancer and its own port; a Kubernetes-managed one
  // also names the cluster behind it. Both are joined into one path, so a
  // reader following it sees the port AND the destination rather than two
  // unrelated facts.
  for (const resource of resources) {
    if (resource.type !== 'listeners') continue
    const owner = firstOf(resource.properties?.['loadbalancers'])
    const balancer = owner === undefined ? undefined : idOf(owner['id'])
    if (balancer === undefined || !byId.has(balancer)) continue

    const protocol = typeof resource.properties?.['protocol'] === 'string'
      ? resource.properties['protocol']
      : undefined
    const port = resource.properties?.['protocol_port']
    const detail = protocol !== undefined && (typeof port === 'number' || typeof port === 'string')
      ? `${protocol}:${String(port)}`
      : protocol

    const cluster = clusterBehind(resource)
    const hops: Hop[] = [
      { kind: 'balancer', id: balancer, detail: undefined },
      { kind: 'listener', id: resource.id, detail },
    ]
    if (cluster !== undefined && byId.has(cluster)) {
      hops.push({ kind: 'target', id: cluster, detail: undefined })
    }
    paths.push({ hops })
  }

  return paths
}


/**
 * Continue a chain past its last box, through the policy that admits it.
 *
 * ## The gap this closes, and the limit of closing it
 *
 * A Kubernetes listener records the cluster it fronts, and nothing further: the
 * inventory does not say which pods talk to which database. What it DOES say is
 * that one group admits another on a port, and which resources each group
 * guards — so a cluster guarded by group A, where A's peer group B admits the
 * database, is a flow the account actually states.
 *
 * That is a hop through a rule rather than through a resource, and it is the
 * only continuation the data supports. It is added only when exactly one group
 * admits exactly one guarded target: with several candidates the chain would be
 * a guess, and a guess drawn as a flow is the defect this module exists to
 * avoid.
 *
 * @param resources - the account's resources.
 * @param view - the resolved layers.
 * @returns extra hops, keyed by the resource a chain currently ends at.
 */
export function policyContinuations(
  resources: readonly AccountResource[],
  view: { readonly guardsOf: ReadonlyMap<string, readonly string[]>, readonly policies: readonly { readonly from: string, readonly to: string, readonly direction: string, readonly protocol: string, readonly ports: string | undefined }[] },
): Map<string, Hop> {
  const continuations = new Map<string, Hop>()
  const byId = new Map(resources.map(resource => [resource.id, resource]))

  // Which resource carries which group. A cluster guards its pods with a group
  // of its own, and `clusterSecGroup` is how the inventory says so — that is
  // the link from "a rule names this group" back to a box in the picture.
  const carrierOf = new Map<string, string[]>()
  for (const [resourceId, names] of view.guardsOf) {
    for (const name of names) {
      const group = resources.find(resource => resource.name === name && resource.type === 'securityGroups')
      if (group === undefined) continue
      carrierOf.set(group.id, [...(carrierOf.get(group.id) ?? []), resourceId])
    }
  }

  for (const policy of view.policies) {
    if (policy.direction !== 'ingress') continue

    // The rule says: traffic from `from` may reach `to`. The SOURCE side is
    // whoever carries the admitting group; the DESTINATION is whoever the
    // admitted group guards. A group nobody carries — a pod group, whose pods
    // are not inventory resources — has no source box, and the hop is skipped
    // rather than drawn from nowhere.
    const carriers = carrierOf.get(policy.from) ?? []
    const destination = byId.get(policy.to)
    if (carriers.length !== 1) continue
    if (destination === undefined) continue

    // The admitted group's own guarded resource: the group `to` protects.
    const guardedResources = resources.filter(resource => (
      (view.guardsOf.get(resource.id) ?? []).includes(destination.name ?? '')
      && resource.id !== carriers[0]
    ))
    if (guardedResources.length !== 1) continue
    const target = guardedResources[0]!

    continuations.set(carriers[0]!, {
      kind: 'target',
      id: target.id,
      detail: policy.ports === undefined
        ? undefined
        : `${policy.protocol === 'any' ? 'tcp' : policy.protocol} ${policy.ports}`,
    })
  }
  return continuations
}


/**
 * The name of what a path ends at, for a caption.
 *
 * @param path - the path.
 * @param resources - the account's resources.
 * @returns the last hop's name, or an empty string when it names nothing.
 */
export function pathTarget(
  path: TrafficPath,
  resources: readonly AccountResource[],
): string {
  const last = [...path.hops].reverse().find(hop => hop.kind === 'target')
  if (last?.id === undefined) return ''
  return resources.find(resource => resource.id === last.id)?.name ?? ''
}