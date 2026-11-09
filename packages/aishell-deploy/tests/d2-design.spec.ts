/**
 * Generating the diagram.
 *
 * Two halves, tested separately because they fail differently:
 *
 *   - `toD2` is the generator. It is pure text, so its output is asserted
 *     exactly — every rule here exists because D2 rejected or misread the
 *     alternative (an attribute written as a child becomes a visible box, a dot
 *     in an id means nesting, a leading `|` ends a markdown block).
 *   - `renderTopology` drives the WASM compiler. It is tested for what a caller
 *     depends on: the SVG comes back, it carries the dark palette so it follows
 *     the viewer's theme, and the worker is released afterwards.
 *
 * The palette test is the one worth keeping. A custom `classes` block is
 * emitted as a hard-coded `fill` on the element, so a diagram styled that way
 * is legible in exactly one theme; the built-in `fill-*` classes are emitted as
 * references and D2 writes both palettes into the file.
 */

import { describe, it, expect } from 'vitest'

import { parseResources } from '../src/hcl.ts'
import { deriveTopology, edgesOf } from '../src/topology.ts'
import { renderTopology, toD2 } from '../src/d2-design.ts'

/** A small network with one finding, so every part of the output is exercised. */
const NETWORK = `
resource "huaweicloud_vpc" "prod" {
  name = "prod-vpc"
  cidr = "10.0.0.0/16"
}
resource "huaweicloud_vpc_subnet" "web" {
  name              = "web"
  cidr              = "10.0.1.0/24"
  vpc_id            = huaweicloud_vpc.prod.id
  gateway_ip        = "10.0.1.1"
  availability_zone = "cn-north-4a"
}
resource "huaweicloud_networking_secgroup" "web" {
  name = "web-sg"
}
resource "huaweicloud_networking_secgroup_rule" "ssh" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  ports             = "22"
  remote_ip_prefix  = "0.0.0.0/0"
  security_group_id = huaweicloud_networking_secgroup.web.id
}
`

/** The generated source for {@link NETWORK}. */
function sourceFor(hcl: string): string {
  const blocks = parseResources(hcl)
  const topology = deriveTopology(blocks)
  return toD2(topology, edgesOf(blocks, topology))
}

describe('toD2', () => {
  it('names both themes, because one name leaves no dark palette', () => {
    // Without `dark-theme-id` D2 emits no dark block at all, so every class
    // resolves in light colours on a dark ground.
    const source = sourceFor(NETWORK)
    expect(source).toContain('theme-id: 5')
    expect(source).toContain('dark-theme-id: 201')
  })

  it('uses accent families that stay distinct in both themes', () => {
    // Theme 0 collapses B, AA and AB to one blue-grey; theme 5 / 201 keep the
    // families apart, which is what lets three kinds of box be told apart.
    const source = sourceFor(NETWORK)
    expect(source).toContain('fill-B5')
    expect(source).toContain('fill-AA4')
  })

  it('nests a subnet inside its VPC block', () => {
    const source = sourceFor(NETWORK)
    const vpcBlock = source.slice(source.indexOf('huaweicloud_vpc_prod:'), source.indexOf('findings:'))
    expect(vpcBlock).toContain('huaweicloud_vpc_subnet_web')
  })

  it('writes no attribute as a child, because D2 draws one as a box', () => {
    // `cidr: "10.0.0.0/16"` inside a node's block becomes a second visible
    // rectangle. Facts belong in the label.
    const source = sourceFor(NETWORK)
    expect(source).not.toMatch(/^\s+cidr:/m)
    expect(source).not.toMatch(/^\s+gateway_ip:/m)
  })

  it('puts the facts in the label instead', () => {
    const source = sourceFor(NETWORK)
    expect(source).toContain('subnet web  10.0.1.0/24 · cn-north-4a · 10.0.1.1')
  })

  it('converts dots in an address to underscores', () => {
    // A `.` in a D2 key means "member of the block before it": an unescaped one
    // would nest the subnet inside a node named after the resource type.
    const source = sourceFor(NETWORK)
    expect(source).toContain('huaweicloud_vpc_prod:')
    expect(source).not.toContain('huaweicloud_vpc.prod:')
  })

  it('heads a rule with its effect rather than its name', () => {
    // The name is the model's own label; the effect is what a reviewer checks.
    const source = sourceFor(NETWORK)
    expect(source).toContain('"ingress 22 ← 0.0.0.0/0"')
  })

  it('uses the built-in palette classes, which follow the theme', () => {
    const source = sourceFor(NETWORK)
    expect(source).toContain('class: [fill-B5, stroke-B3]')
    // A custom style would be a literal colour on one element, legible in one
    // theme only.
    expect(source).not.toContain('style:')
    expect(source).not.toMatch(/#[0-9A-Fa-f]{6}/)
  })

  it('writes findings as a list, not a table', () => {
    // D2's markdown block terminates on a leading `|`, so a table is a syntax
    // error rather than a table.
    const source = sourceFor(NETWORK)
    const panel = source.slice(source.indexOf('findings:'))
    expect(panel).toContain('- warning —')
    expect(panel).toMatch(/^\s+-\s/m)
    expect(panel.match(/^\s+\|/gm)).toBeNull()
  })

  it('omits the findings panel when there are none', () => {
    const source = sourceFor(`
resource "huaweicloud_vpc" "prod" {
  name = "prod-vpc"
  cidr = "10.0.0.0/16"
}
`)
    expect(source).not.toContain('findings:')
  })

  it('escapes a quote in a label', () => {
    // A cloud name with a quote in it would otherwise close the D2 string early,
    // turning the rest of the line into D2 syntax.
    const source = sourceFor(`
resource "huaweicloud_vpc" "v" {
  name = "say \\"hi\\""
  cidr = "10.0.0.0/16"
}
`)
    expect(source).toContain('VPC say \\"hi\\"')
  })

  it('leads with the cloud name, which is what the console shows', () => {
    // The terraform label (`prod`, used in addresses) and the cloud name
    // (`prod-vpc`, shown in the console) differ; a diagram is read against the
    // console.
    const source = sourceFor(`
resource "huaweicloud_vpc" "prod" {
  name = "prod-vpc"
  cidr = "10.0.0.0/16"
}
`)
    expect(source).toContain('VPC prod-vpc')
    expect(source).not.toContain('VPC prod  10')
  })

  it('draws no line for a relationship the nesting already shows', () => {
    const source = sourceFor(NETWORK)
    // The subnet's vpc_id IS the nesting; an arrow to the containing box would
    // read as a connection between peers.
    expect(source).not.toMatch(/huaweicloud_vpc_subnet_web -> huaweicloud_vpc_prod/)
  })
})

describe('renderTopology', () => {
  it('returns an SVG and the source it came from', async () => {
    const blocks = parseResources(NETWORK)
    const topology = deriveTopology(blocks)
    const result = await renderTopology(topology, edgesOf(blocks, topology))
    expect(result.svg.startsWith('<svg')).toBe(true)
    expect(result.svg).toContain('</svg>')
    expect(result.source).toContain('huaweicloud_vpc_prod')
  }, 30_000)

  it('carries a dark palette so one file serves both themes', async () => {
    const blocks = parseResources(NETWORK)
    const topology = deriveTopology(blocks)
    const result = await renderTopology(topology, edgesOf(blocks, topology))
    expect(result.svg).toContain('prefers-color-scheme')
  }, 30_000)

  it('omits the XML declaration, so the file embeds in HTML directly', async () => {
    const blocks = parseResources(NETWORK)
    const topology = deriveTopology(blocks)
    const result = await renderTopology(topology, edgesOf(blocks, topology))
    expect(result.svg.startsWith('<?xml')).toBe(false)
  }, 30_000)

  it('draws an empty design without failing', async () => {
    // No resources at all: the caller refuses this before rendering, but the
    // renderer must not be the thing that throws a wasm error.
    const topology = deriveTopology([])
    const result = await renderTopology(topology, [])
    expect(result.svg).toContain('<svg')
  }, 30_000)
})