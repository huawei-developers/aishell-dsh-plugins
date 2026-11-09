/**
 * What a module tree looks like to the security-group extractor.
 *
 * `terraform show -json` puts a module's resources under that module's
 * `child_modules`, not beside the root's. Reading `root_module.resources`
 * alone therefore returns nothing for a deployment whose network lives in a
 * module — and an empty rule list reads as "there are no rules", which is the
 * opposite of the truth. Verified against a real plan of a two-resource module.
 */

import { describe, it, expect } from 'vitest'

import { extractSecurityGroups } from '../src/security-groups.ts'

/** A resource entry as terraform writes it. */
function resource(type: string, address: string, values: Record<string, unknown> = {}) {
  return { address, type, values }
}

/** A rule, with the fields the extractor reads. */
function rule(address: string, direction = 'ingress', ports = '22') {
  return resource('huaweicloud_networking_secgroup_rule', address, {
    direction,
    protocol: 'tcp',
    ports,
    remote_ip_prefix: '0.0.0.0/0',
  })
}

describe('extractSecurityGroups', () => {
  it('finds the rules declared at the root', () => {
    const rules = extractSecurityGroups({
      planned_values: { root_module: { resources: [rule('huaweicloud_networking_secgroup_rule.ssh')] } },
    })
    expect(rules).toHaveLength(1)
    expect(rules[0]?.ports).toBe('22')
  })

  it('finds the rules a module declares', () => {
    const rules = extractSecurityGroups({
      planned_values: {
        root_module: {
          resources: [],
          child_modules: [{
            address: 'module.net',
            resources: [rule('module.net.huaweicloud_networking_secgroup_rule.web', 'ingress', '80,443')],
          }],
        },
      },
    })
    // An empty list here would say the plan creates no rules, when it creates
    // one — the review step this feeds would silently skip it.
    expect(rules).toHaveLength(1)
    expect(rules[0]?.ports).toBe('80,443')
  })

  it('walks nested modules, not only the first level', () => {
    const rules = extractSecurityGroups({
      planned_values: {
        root_module: {
          resources: [],
          child_modules: [{
            address: 'module.a',
            resources: [],
            child_modules: [{
              address: 'module.a.module.b',
              resources: [rule('module.a.module.b.huaweicloud_networking_secgroup_rule.inner')],
            }],
          }],
        },
      },
    })
    expect(rules.map(entry => entry.address))
      .toEqual(['module.a.module.b.huaweicloud_networking_secgroup_rule.inner'])
  })

  it('reads both module trees a plan and a state use', () => {
    // A plan carries `planned_values`; `terraform show -json` of STATE carries
    // `values`. The same function answers both.
    const rules = extractSecurityGroups({
      values: {
        root_module: {
          resources: [],
          child_modules: [{ address: 'module.net', resources: [rule('module.net.r')] }],
        },
      },
    })
    expect(rules).toHaveLength(1)
  })

  it('returns nothing for a plan with no module tree at all', () => {
    expect(extractSecurityGroups({})).toEqual([])
  })

  it('skips resources that only end in a similar suffix', () => {
    const rules = extractSecurityGroups({
      planned_values: {
        root_module: {
          resources: [
            resource('huaweicloud_networking_secgroup_rule_template', 'huaweicloud_networking_secgroup_rule_template.x'),
            rule('huaweicloud_networking_secgroup_rule.real'),
          ],
        },
      },
    })
    expect(rules.map(entry => entry.address)).toEqual(['huaweicloud_networking_secgroup_rule.real'])
  })
})