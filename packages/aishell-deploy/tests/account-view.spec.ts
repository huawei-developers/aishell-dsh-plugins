/**
 * Reading the account as the three layers a diagram shows.
 *
 * The distinction under test is the one that makes the picture truthful:
 * placement and attachment are NESTING, guarding is a PROPERTY, and policy is an
 * EDGE. Getting them mixed up produced a diagram where a security group was a
 * peer of the server it protected, and where the actual reachability rules were
 * missing entirely.
 */

import { describe, it, expect } from 'vitest'

import {
  accountView,
  containment,
  guards,
  nestRank,
  policies,
  ruleSummaries,
} from '../src/account-view.ts'
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

describe('nestRank', () => {
  it('ranks a subnet above the VPC that holds it', () => {
    // A server names both. It lives in the subnet, which lives in the VPC.
    expect(nestRank('vpc_id')).toBeLessThan(nestRank('subnet_id'))
  })

  it('reads the spellings the provider uses', () => {
    for (const attribute of ['subnet_id', 'subnetId', 'virsubnet_id', 'networkId', 'elb_virsubnet_ids']) {
      expect(nestRank(attribute), attribute).toBe(2)
    }
    for (const attribute of ['serverID', 'host_id']) {
      expect(nestRank(attribute), attribute).toBe(4)
    }
  })

  it('does not treat a security group as a container', () => {
    // A group is a property of what it guards, not a place to live.
    expect(nestRank('security_group_id')).toBe(0)
    expect(nestRank('clusterSecGroup')).toBe(0)
  })
})

describe('containment', () => {
  it('nests a server inside its subnet, not its VPC', () => {
    // The most specific container wins: both are named, one is inside the other.
    const parentOf = containment([
      resource('vpc-1', 'vpc', 'vpcs'),
      resource('sub-1', 'vpc', 'subnets', { vpc_id: 'vpc-1' }),
      resource('srv-1', 'ecs', 'cloudservers', { subnet_id: 'sub-1', vpc_id: 'vpc-1' }),
    ])
    expect(parentOf.get('sub-1')).toBe('vpc-1')
    expect(parentOf.get('srv-1')).toBe('sub-1')
  })

  it('treats an attachment as nesting too', () => {
    // An EIP belongs to the balancer it answers for; a disk belongs to its
    // server. Both are "part of", which is drawn the same way as "lives in".
    const parentOf = containment([
      resource('lb-1', 'elb', 'loadbalancers'),
      resource('eip-1', 'vpc', 'publicips', { associateInstanceId: 'lb-1' }),
      resource('srv-1', 'ecs', 'cloudservers'),
      resource('vol-1', 'evs', 'volumes', { serverID: 'srv-1' }),
    ])
    expect(parentOf.get('eip-1')).toBe('lb-1')
    expect(parentOf.get('vol-1')).toBe('srv-1')
  })

  it('unwraps an id the inventory shipped JSON-encoded', () => {
    // RMS reports some ids as `"[\"…\"]"`, and a plain comparison never matches.
    const parentOf = containment([
      resource('vpc-1', 'vpc', 'vpcs'),
      resource('sub-1', 'vpc', 'subnets', { vpc_id: '["vpc-1"]' }),
    ])
    expect(parentOf.get('sub-1')).toBe('vpc-1')
  })

  it('ignores a reference to something outside the account', () => {
    const parentOf = containment([
      resource('srv-1', 'ecs', 'cloudservers', { serverID: 'not-in-the-list' }),
    ])
    expect(parentOf.size).toBe(0)
  })

  it('does not nest a resource inside itself', () => {
    const parentOf = containment([
      resource('sg-1', 'vpc', 'securityGroups', { vpc_id: 'sg-1' }),
    ])
    expect(parentOf.has('sg-1')).toBe(false)
  })
})

describe('guards', () => {
  it('records which groups protect a resource', () => {
    const guardsOf = guards([
      resource('sg-1', 'vpc', 'securityGroups', {}, 'sg-api'),
      resource('apig-1', 'apig', 'instances', { security_group_id: 'sg-1' }),
    ])
    expect(guardsOf.get('apig-1')).toEqual(['sg-api'])
  })

  it('sorts the names so two runs agree', () => {
    const guardsOf = guards([
      resource('sg-b', 'vpc', 'securityGroups', {}, 'bravo'),
      resource('sg-a', 'vpc', 'securityGroups', {}, 'alpha'),
      resource('srv', 'ecs', 'cloudservers', { security_group_id: 'sg-b', clusterSecGroup: 'sg-a' }),
    ])
    expect(guardsOf.get('srv')).toEqual(['alpha', 'bravo'])
  })

  it('says nothing about a resource with no group', () => {
    const guardsOf = guards([resource('srv', 'ecs', 'cloudservers')])
    expect(guardsOf.has('srv')).toBe(false)
  })
})

describe('policies', () => {
  /** Two groups, one admitting the other on 5432. */
  const account = [
    resource('sg-app', 'vpc', 'securityGroups', {
      security_group_rules: [
        {
          direction: 'ingress', protocol: 'tcp', port_range_min: 5432, port_range_max: 5432,
          remote_group_id: 'sg-db', security_group_id: 'sg-app',
        },
      ],
    }, 'sg-app'),
    resource('sg-db', 'vpc', 'securityGroups', {}, 'sg-db'),
  ]

  it('reads a rule that admits another group as an edge', () => {
    // This is the only relationship in the account that expresses reachability,
    // and the only one where direction and port carry meaning.
    expect(policies(account)).toEqual([
      { from: 'sg-db', to: 'sg-app', direction: 'ingress', protocol: 'tcp', ports: '5432' },
    ])
  })

  it('collapses rules that say the same thing', () => {
    // The provider repeats a rule; a reader comparing the picture to the console
    // should not have to work out which arrow is which duplicate.
    const repeated = [
      resource('sg-app', 'vpc', 'securityGroups', {
        security_group_rules: [
          { direction: 'ingress', protocol: 'tcp', port_range_min: 5432, port_range_max: 5432, remote_group_id: 'sg-db' },
          { direction: 'ingress', protocol: 'tcp', port_range_min: 5432, port_range_max: 5432, remote_group_id: 'sg-db' },
        ],
      }, 'sg-app'),
      resource('sg-db', 'vpc', 'securityGroups', {}, 'sg-db'),
    ]
    expect(policies(repeated)).toHaveLength(1)
  })

  it('ignores a group admitting itself', () => {
    // That is the default "members may talk to each other" and says nothing
    // about a relationship between two groups.
    const self = [
      resource('sg-1', 'vpc', 'securityGroups', {
        security_group_rules: [
          { direction: 'ingress', remote_group_id: 'sg-1' },
        ],
      }, 'sg-1'),
    ]
    expect(policies(self)).toEqual([])
  })

  it('ignores a rule pointing at something that is not a group', () => {
    // An address range (`remote_ip_prefix`) is not an edge: it is the internet,
    // and the picture has no box for it.
    const byCidr = [
      resource('sg-1', 'vpc', 'securityGroups', {
        security_group_rules: [
          { direction: 'ingress', protocol: 'tcp', port_range_min: 443, remote_ip_prefix: '0.0.0.0/0' },
        ],
      }, 'sg-1'),
    ]
    expect(policies(byCidr)).toEqual([])
  })

  it('records the port range when the two ends differ', () => {
    const range = [
      resource('sg-app', 'vpc', 'securityGroups', {
        security_group_rules: [
          { direction: 'ingress', protocol: 'tcp', port_range_min: 8000, port_range_max: 8010, remote_group_id: 'sg-db' },
        ],
      }, 'sg-app'),
      resource('sg-db', 'vpc', 'securityGroups', {}, 'sg-db'),
    ]
    expect(policies(range)[0]?.ports).toBe('8000-8010')
  })

  it('says "any" when a rule names no protocol or port', () => {
    const anyRule = [
      resource('sg-app', 'vpc', 'securityGroups', {
        security_group_rules: [{ direction: 'ingress', remote_group_id: 'sg-db' }],
      }, 'sg-app'),
      resource('sg-db', 'vpc', 'securityGroups', {}, 'sg-db'),
    ]
    expect(policies(anyRule)[0]).toMatchObject({ protocol: 'any', ports: undefined })
  })
})

describe('accountView', () => {
  it('resolves the three layers together', () => {
    const view = accountView([
      resource('vpc-1', 'vpc', 'vpcs'),
      resource('sg-app', 'vpc', 'securityGroups', {
        security_group_rules: [{ direction: 'ingress', remote_group_id: 'sg-db' }],
      }, 'sg-app'),
      resource('sg-db', 'vpc', 'securityGroups', {}, 'sg-db'),
      resource('rds', 'rds', 'instances', { vpc_id: 'vpc-1', security_group_id: 'sg-app' }),
    ])
    expect(view.parentOf.get('rds')).toBe('vpc-1')
    expect(view.guardsOf.get('rds')).toEqual(['sg-app'])
    expect(view.policies).toHaveLength(1)
    // Both ends of a policy belong in the policy band; a group with no policy
    // relationship does not.
    expect([...view.policyGroups].sort()).toEqual(['sg-app', 'sg-db'])
  })
})
describe('containment — a resource that states no placement of its own', () => {
  it('inherits the container of the thing that names it', () => {
    // A NAT gateway reports only its spec. The EIP attached to it carries the
    // gateway's VPC in `vnic.vpcId` — the same VPC the gateway is in, recorded
    // on the other side of the relationship.
    const parentOf = containment([
      resource('vpc-1', 'vpc', 'vpcs'),
      resource('nat-1', 'nat', 'natGateways', { spec: 2 }),
      resource('eip-1', 'vpc', 'publicips', {
        associateInstanceId: 'nat-1',
        vnic: { vpcId: 'vpc-1', deviceId: 'nat-1' },
      }),
    ])
    expect(parentOf.get('eip-1')).toBe('nat-1')
    expect(parentOf.get('nat-1')).toBe('vpc-1')
  })

  it('does not place a container inside its own contents', () => {
    // The VPC is named by everything it holds, including the EIP above. Reading
    // that as "this VPC belongs inside one of them" would invert the nesting.
    const parentOf = containment([
      resource('vpc-1', 'vpc', 'vpcs'),
      resource('nat-1', 'nat', 'natGateways', {}),
      resource('eip-1', 'vpc', 'publicips', {
        associateInstanceId: 'nat-1',
        vnic: { vpcId: 'vpc-1' },
      }),
      resource('sub-1', 'vpc', 'subnets', { vpc_id: 'vpc-1' }),
    ])
    expect(parentOf.has('vpc-1')).toBe(false)
  })

  it('counts a source once even when it names the target twice', () => {
    // An EIP names its NAT gateway through both `vnic.deviceId` and
    // `associateInstanceId`. Counting attributes rather than sources made a
    // single attachment look like a container everything points at, and the
    // gateway was then refused a placement of its own.
    const parentOf = containment([
      resource('vpc-1', 'vpc', 'vpcs'),
      resource('nat-1', 'nat', 'natGateways', {}),
      resource('eip-1', 'vpc', 'publicips', {
        associateInstanceId: 'nat-1',
        vnic: { vpcId: 'vpc-1', deviceId: 'nat-1' },
      }),
    ])
    expect(parentOf.get('nat-1')).toBe('vpc-1')
  })
})

describe('containment — the direction of every attribute', () => {
  it('does not read structure out of a description', () => {
    // A Kubernetes-managed ELB listener carries the cluster it fronts in
    // `description` as JSON. Reading that as "the listener belongs to the
    // cluster" puts a balancer's front end inside a container it merely serves.
    expect(nestRank('description')).toBe(0)
    expect(nestRank('description.cluster_id')).toBe(0)
  })

  it('nests a listener in its balancer', () => {
    // The provider writes `loadbalancers: [{ id }]`; flattening makes it
    // `loadbalancers.id`.
    const parentOf = containment([
      resource('lb-1', 'elb', 'loadbalancers'),
      resource('lis-1', 'elb', 'listeners', { loadbalancers: [{ id: 'lb-1' }] }),
    ])
    expect(parentOf.get('lis-1')).toBe('lb-1')
  })

  it('nests the balancer in its subnet, not in its own EIP', () => {
    // A balancer lists the EIPs attached to it (`eips[].eip_id`), which reads
    // like a container listing a member. The EIP's own `associateInstanceId` is
    // the property that says where the EIP belongs, and the direction runs that
    // way — a balancer placed inside its own address is upside down.
    const parentOf = containment([
      resource('sub-1', 'vpc', 'subnets'),
      resource('lb-1', 'elb', 'loadbalancers', {
        elb_virsubnet_ids: ['sub-1'],
        eips: [{ eip_id: 'eip-1' }],
      }),
      resource('eip-1', 'vpc', 'publicips', { associateInstanceId: 'lb-1' }),
    ])
    expect(parentOf.get('lb-1')).toBe('sub-1')
    expect(parentOf.get('eip-1')).toBe('lb-1')
  })

  it('does not let a member list override a placement', () => {
    // The same guard as above, stated as the rule: `eips.eip_id` is not a
    // container attribute at all, so it outranks nothing.
    expect(nestRank('eips.eip_id')).toBe(0)
    expect(nestRank('elb_virsubnet_ids')).toBe(2)
  })
})

describe('ruleSummaries — the rules worth drawing', () => {
  /** Two groups, one admitting the other on a port, plus the usual defaults. */
  const account = () => [
    resource('sg-app', 'vpc', 'securityGroups', {
      security_group_rules: [
        // The rule that says something: a peer group on a port.
        { direction: 'ingress', protocol: 'tcp', port_range_min: 5432, port_range_max: 5432, remote_group_id: 'sg-db' },
        // The defaults every group has, which distinguish nothing.
        { direction: 'ingress', remote_group_id: 'sg-app' },
        { direction: 'egress', remote_ip_prefix: '0.0.0.0/0' },
      ],
    }, 'sg-app'),
    resource('sg-db', 'vpc', 'securityGroups', {}, 'sg-db'),
  ]

  it('keeps the rule that says something and drops the defaults', () => {
    // Measured on a live account: 13 groups carry 65 rules, and listing them
    // all makes the picture three times taller for information that is the same
    // in every group. The summarisation took that account from 65 to 14.
    const summaries = ruleSummaries(account())
    expect(summaries.get('sg-app')?.ingress).toEqual([
      { direction: 'ingress', protocol: 'tcp', ports: '5432', source: 'sg-db' },
    ])
    expect(summaries.get('sg-app')?.egress).toEqual([])
  })

  it('splits the two directions apart', () => {
    // In and out answer different questions, and a reader checks one of them.
    const summaries = ruleSummaries([
      resource('sg-1', 'vpc', 'securityGroups', {
        security_group_rules: [
          { direction: 'ingress', protocol: 'tcp', port_range_min: 22, remote_ip_prefix: '10.0.0.0/8' },
          { direction: 'egress', protocol: 'tcp', port_range_min: 443, remote_ip_prefix: '10.1.0.0/16' },
        ],
      }, 'sg-1'),
    ])
    expect(summaries.get('sg-1')?.ingress).toHaveLength(1)
    expect(summaries.get('sg-1')?.egress).toHaveLength(1)
  })

  it('collapses a duplicated rule', () => {
    // The provider repeats rules; a reader should not see the same line twice.
    const summaries = ruleSummaries([
      resource('sg-1', 'vpc', 'securityGroups', {
        security_group_rules: [
          { direction: 'ingress', protocol: 'tcp', port_range_min: 80, remote_ip_prefix: '10.0.0.0/8' },
          { direction: 'ingress', protocol: 'tcp', port_range_min: 80, remote_ip_prefix: '10.0.0.0/8' },
        ],
      }, 'sg-1'),
    ])
    expect(summaries.get('sg-1')?.ingress).toHaveLength(1)
  })

  it('names a source group rather than showing its id', () => {
    // An id in a box is unreadable; the group's name is what the picture uses
    // everywhere else.
    const summaries = ruleSummaries(account())
    expect(summaries.get('sg-app')?.ingress[0]?.source).toBe('sg-db')
  })

  it('says nothing about a group whose rules are all defaults', () => {
    const summaries = ruleSummaries([
      resource('sg-default', 'vpc', 'securityGroups', {
        security_group_rules: [
          { direction: 'ingress', remote_group_id: 'sg-default' },
          { direction: 'egress', remote_ip_prefix: '0.0.0.0/0' },
        ],
      }, 'sg-default'),
    ])
    expect(summaries.has('sg-default')).toBe(false)
  })
})
