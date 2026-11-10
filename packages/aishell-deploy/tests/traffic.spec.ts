/**
 * The chains traffic follows into the account.
 *
 * What is worth pinning is that each hop is one the inventory actually states.
 * A path built from a guess would read exactly as authoritative as a real one,
 * and a reader would follow it to a resource that is not in the flow at all.
 */

import { describe, it, expect } from 'vitest'

import { clusterBehind, pathTarget, policyContinuations, trafficPaths } from '../src/traffic.ts'
import { accountView } from '../src/account-view.ts'
import type { AccountResource } from '../src/account-view.ts'

/** A resource, with only the fields these functions read. */
function resource(
  id: string,
  provider: string,
  type: string,
  properties: Record<string, unknown> = {},
  name?: string,
): AccountResource {
  return { id, provider, type, properties, ...(name === undefined ? {} : { name }) }
}

describe('clusterBehind', () => {
  it('reads the cluster a Kubernetes-managed listener fronts', () => {
    // The only place this hop is written down: the integration records its owner
    // as JSON in the listener's description.
    const listener = resource('lis-1', 'elb', 'listeners', {
      description: '{"cluster_id":"c-1","service_id":"s-1"}',
    })
    expect(clusterBehind(listener)).toBe('c-1')
  })

  it('does not read a person-written description as an owner', () => {
    // Free text is not JSON, and treating it as one would invent a hop.
    const listener = resource('lis-1', 'elb', 'listeners', {
      description: 'main https listener',
    })
    expect(clusterBehind(listener)).toBeUndefined()
  })

  it('ignores JSON without a cluster id', () => {
    const listener = resource('lis-1', 'elb', 'listeners', {
      description: '{"service_id":"s-1"}',
    })
    expect(clusterBehind(listener)).toBeUndefined()
  })

  it('ignores a listener with no description', () => {
    expect(clusterBehind(resource('lis-1', 'elb', 'listeners'))).toBeUndefined()
  })
})

describe('trafficPaths', () => {
  it('starts a path at the internet when an EIP is attached to something', () => {
    const paths = trafficPaths([
      resource('eip-1', 'vpc', 'publicips', {
        associateInstanceId: 'lb-1',
        publicIpAddress: '113.44.205.243',
      }, '113.44.205.243'),
      resource('lb-1', 'elb', 'loadbalancers', {}, 'elb'),
    ])
    expect(paths).toHaveLength(1)
    expect(paths[0]!.hops.map(hop => hop.kind)).toEqual(['internet', 'eip', 'target'])
    // The address makes the hop concrete; a path that said only "an EIP" would
    // not tell a reader which entry point it is.
    expect(paths[0]!.hops[1]!.detail).toBe('113.44.205.243')
  })

  it('does not invent a path for an EIP attached to nothing', () => {
    // A reserved address is real and carries no traffic; drawing a chain from it
    // would claim a flow nobody established.
    const paths = trafficPaths([
      resource('eip-1', 'vpc', 'publicips', {}, '113.44.205.243'),
    ])
    expect(paths).toEqual([])
  })

  it('joins a balancer, its listener, and the cluster behind it', () => {
    const paths = trafficPaths([
      resource('lb-1', 'elb', 'loadbalancers', {}, 'elb'),
      resource('lis-1', 'elb', 'listeners', {
        loadbalancers: [{ id: 'lb-1' }],
        protocol: 'HTTPS',
        protocol_port: 443,
        description: '{"cluster_id":"c-1"}',
      }, 'k8s_HTTPS_443'),
      resource('c-1', 'cce', 'clusters', {}, 'cce'),
    ])
    const path = paths.find(entry => entry.hops.some(hop => hop.kind === 'listener'))!
    expect(path.hops.map(hop => hop.kind)).toEqual(['balancer', 'listener', 'target'])
    // The port belongs on the listener hop, where it is a fact about that hop.
    expect(path.hops[1]!.detail).toBe('HTTPS:443')
  })

  it('stops at the listener when no cluster is recorded', () => {
    const paths = trafficPaths([
      resource('lb-1', 'elb', 'loadbalancers', {}, 'elb'),
      resource('lis-1', 'elb', 'listeners', {
        loadbalancers: [{ id: 'lb-1' }],
        protocol: 'HTTP',
        protocol_port: 80,
      }),
    ])
    const path = paths.find(entry => entry.hops.some(hop => hop.kind === 'listener'))!
    expect(path.hops.map(hop => hop.kind)).toEqual(['balancer', 'listener'])
  })

  it('does not follow a balancer whose pool members are not in the inventory', () => {
    // The inventory lists a pool's id but not its members. Following that would
    // need a second query, so the picture says nothing rather than guessing.
    const paths = trafficPaths([
      resource('lb-1', 'elb', 'loadbalancers', { pools: [{ id: 'pool-1' }] }, 'elb'),
    ])
    expect(paths).toEqual([])
  })

  it('ignores a listener that names no balancer', () => {
    const paths = trafficPaths([
      resource('lis-1', 'elb', 'listeners', { protocol: 'HTTPS', protocol_port: 443 }),
    ])
    expect(paths).toEqual([])
  })
})

describe('pathTarget', () => {
  it('names what the chain ends at', () => {
    const resources = [
      resource('eip-1', 'vpc', 'publicips', { associateInstanceId: 'lb-1' }, '113.44.205.243'),
      resource('lb-1', 'elb', 'loadbalancers', {}, 'elb-aishell-e2b'),
    ]
    expect(pathTarget(trafficPaths(resources)[0]!, resources)).toBe('elb-aishell-e2b')
  })

  it('is empty when the path ends at nothing named', () => {
    expect(pathTarget({ hops: [{ kind: 'internet', id: undefined, detail: undefined }] }, []))
      .toBe('')
  })
})
describe('policyContinuations — continuing a chain past its last box', () => {
  /** A cluster guarded by one group, a database guarded by another. */
  const account = () => [
    resource('cce-1', 'cce', 'clusters', { clusterSecGroup: 'sg-pods' }, 'cluster'),
    resource('sg-pods', 'vpc', 'securityGroups', {}, 'sg-pods'),
    resource('rds-1', 'rds', 'instances', { security_group_id: 'sg-db' }, 'database'),
    resource('sg-db', 'vpc', 'securityGroups', {
      security_group_rules: [
        { direction: 'ingress', protocol: 'tcp', port_range_min: 5432, port_range_max: 5432, remote_group_id: 'sg-pods' },
      ],
    }, 'sg-db'),
  ]

  it('follows the one rule that admits the source group', () => {
    // The inventory does not say which pods talk to which database. What it
    // does say is that one group admits another on a port, and what each group
    // guards — which together is a flow the account states.
    const resources = account()
    const view = accountView(resources)
    const continuations = policyContinuations(resources, view)
    expect(continuations.get('cce-1')).toMatchObject({ id: 'rds-1', detail: 'tcp 5432' })
  })

  it('draws nothing when two groups could be the source', () => {
    // A choice this module cannot make. A guess drawn as a flow is the defect
    // the module exists to avoid.
    const resources = [
      ...account(),
      resource('cce-2', 'cce', 'clusters', { clusterSecGroup: 'sg-pods' }, 'second cluster'),
    ]
    const continuations = policyContinuations(resources, accountView(resources))
    expect(continuations.size).toBe(0)
  })

  it('draws nothing when the admitting group has no carrier in the account', () => {
    // The pod group protects pods, and pods are not inventory resources. With
    // no box to start from, the chain ends rather than beginning nowhere.
    const resources = [
      resource('rds-1', 'rds', 'instances', { security_group_id: 'sg-db' }, 'database'),
      resource('sg-db', 'vpc', 'securityGroups', {
        security_group_rules: [
          { direction: 'ingress', protocol: 'tcp', port_range_min: 5432, remote_group_id: 'sg-ghost' },
        ],
      }, 'sg-db'),
    ]
    expect(policyContinuations(resources, accountView(resources)).size).toBe(0)
  })

  it('ignores an egress rule', () => {
    // A rule permitting outbound traffic says nothing about what arrives.
    const resources = [
      resource('cce-1', 'cce', 'clusters', { clusterSecGroup: 'sg-pods' }, 'cluster'),
      resource('sg-pods', 'vpc', 'securityGroups', {
        security_group_rules: [
          { direction: 'egress', protocol: 'tcp', port_range_min: 5432, remote_group_id: 'sg-db' },
        ],
      }, 'sg-pods'),
      resource('rds-1', 'rds', 'instances', { security_group_id: 'sg-db' }, 'database'),
      resource('sg-db', 'vpc', 'securityGroups', {}, 'sg-db'),
    ]
    expect(policyContinuations(resources, accountView(resources)).size).toBe(0)
  })
})
