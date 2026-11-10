/**
 * `validate_design` — check the network design and draw it.
 *
 * ## Where this sits in the flow
 *
 * The design stage of a deployment is the network: VPCs, subnets, address
 * ranges, security groups. None of it needs a flavour, an image, or a resource
 * id — the things that only make sense once the network exists. So the design
 * stage needs no cloud credentials, and this tool needs none either.
 *
 * That is what makes the ordering work. A model can write the network `.tf`
 * alone, have it checked and drawn, show the picture, and only then begin to
 * fill in compute resources. The alternative — deriving the picture from a
 * `plan` — would require the whole configuration first, including the specs
 * and ids that the network design is what determines.
 *
 * ## What it checks, and what it deliberately does not
 *
 * `terraform validate` is run when the provider is installed, because it is
 * the authoritative check on the configuration: provider attribute names,
 * required arguments, value formats, and reference resolution. Nothing here
 * duplicates it.
 *
 * What it CANNOT check is everything that spans blocks — overlapping subnets,
 * a subnet outside its VPC, a gateway outside its subnet, a rule open to the
 * world. `terraform validate` reports `Success!` for all four. Those come from
 * `network-checks` instead.
 *
 * When the provider is NOT installed, `terraform validate` cannot run, and the
 * tool says so rather than implying the configuration is checked. The diagram
 * is still drawn: it derives from the `.tf` text, which does not need a
 * provider, and a picture with an explicit "not validated" note is more useful
 * than no picture.
 *
 * ## The diagram
 *
 * Written beside the configuration as `topology.svg` and `topology.d2`, and
 * reported by absolute path. An absolute path is what the shell's Markdown
 * image resolution needs: a relative one resolves against the session's
 * workspace, and the deployment directory need not be inside it. The file is
 * served to the browser through the authenticated `/api/file` route, which
 * sends `Content-Security-Policy: sandbox; default-src 'none'` — so an SVG
 * written here cannot act as a document even if its text were attacker-chosen.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/tools/design
 */

import type { ToolRegistrar } from '../types.ts'
import { z } from 'zod'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { READ_ONLY_LOCAL } from './annotations.ts'
import { fail, guard, okJson, type ToolResult } from './errors.ts'
import { deploymentParam } from './index.ts'
import { configurationFiles, parseJsonResources, parseResources } from '../hcl.ts'
import { deriveTopology, edgesOf } from '../topology.ts'
import { ExistingResourceSchema } from '../existing.ts'
import type { ExistingResource } from '../existing.ts'
import type { OmittedResource } from '../topology.ts'
import { renderAccountDiagram } from '../diagram.ts'
import type { Diagram } from '../svg-render.ts'
import { renderDesignDiagram } from '../design-render.ts'
import { runTerraform } from '../terraform-run.ts'
import { providerInstalled } from '../gates/provider_installed.ts'
import { computeTfHash } from '../utils/hash.ts'
import { updateSnapshot } from '../deployment-state.ts'

/** Where the diagram lands, relative to the deployment. */
const TOPOLOGY_FILE = 'topology.svg'

/** The generated D2 source, kept beside the SVG so a reader can see what was drawn. */
const D2_FILE = 'topology.d2'

/** File extensions read as configuration. */
const CONFIG_EXTENSION = '.tf'

/**
 * Register `validate_design`.
 *
 * @param registrar - the capture surface this plugin's tools register into.
 */
export function registerDesignTool(registrar: ToolRegistrar): void {
  registrar.registerTool(
    'validate_design',
    {
      title: 'Validate the network design and draw it',
      description:
        'Check the network design this deployment declares (.tf: VPCs, subnets, security '
        + 'groups and rules, gateways, load balancers, compute and managed databases) and '
        + 'draw it. It runs `terraform validate` when the provider is installed — the '
        + 'authoritative check on attribute names, required arguments and references — then '
        + 'the checks terraform cannot do: subnet CIDRs overlapping, a subnet outside its '
        + 'VPC, a gateway_ip outside its subnet, and security-group rules open to '
        + '0.0.0.0/0 on administrative or database ports. Findings are REPORTED, not '
        + 'enforced: a design with findings still gets its diagram. '
        + 'Writes topology.svg and topology.d2 into the deployment and returns their '
        + 'absolute paths. No cloud credentials are needed and no resource is created. '
        + 'The drawing is a VIEW, not an inventory. Resources outside a network picture — '
        + 'alarm rules, log groups, backups, key pairs, parameter templates — come back '
        + 'counted under `omitted` by type and are not drawn; a configuration declaring only '
        + 'those gets a refusal naming them rather than an empty picture. Connections '
        + 'between VPCs (a peering, a VPCEP endpoint, a route) are labelled EDGES rather '
        + 'than boxes, listed under `connections` with `unresolved` when the far network is '
        + 'not declared here. '
        + 'A local module (`source = "./..."`) is part of the design and is read, drawn and '
        + 'hashed like the workspace files. A downloaded module is not — it is a '
        + 'dependency. Module paths come from terraform\'s own record, so a design written '
        + 'inside one is read after `terraform_init` and not before. '
        + 'With `existing` and no .tf at all it draws the account as it stands instead, and '
        + 'reports validation as skipped. See the `existing` parameter for what those have '
        + 'to carry.',
      annotations: READ_ONLY_LOCAL,
      inputSchema: z.object({
        deployment: deploymentParam,
        existing: z.array(ExistingResourceSchema).optional().describe(
          'Cloud resources that already exist and that this design reuses or works '
          + 'around, as reported by list_existing_resources. Pass only the ones the design '
          + 'is about — the whole account is usually the wrong picture. '
          + 'Copy `id`, `type`, `provider`, `properties` and `name` verbatim from the '
          + 'inventory; do not translate its vocabulary into terraform type names, which '
          + 'produces names that do not exist. `properties` is what carries the '
          + 'relationships — with no .tf it is this tool\'s only input, and a resource '
          + 'without one is drawn as an isolated box. '
          + 'An existing resource the .tf references without declaring it (a subnet cut '
          + 'from a VPC that already exists) also needs `address`, the terraform address '
          + 'the reference resolves to. '
          + 'Passing `existing` with no .tf at all draws the account as it stands, and '
          + 'validation reports itself as skipped.',
        ),
      }),
    },
    guard(async (args) => handleValidateDesign(args.deployment, args.existing ?? [])),
  )
}

/**
 * Read the design, check it, draw it.
 *
 * @param deployment - the deployment workspace directory.
 * @returns the tool result.
 */
async function handleValidateDesign(
  deployment: string,
  existing: readonly ExistingResource[],
): Promise<ToolResult> {
  const configFiles = await configurationFiles(deployment)
  if (configFiles.length === 0 && existing.length === 0) {
    return fail(
      `no ${CONFIG_EXTENSION} files in ${deployment}, and no \`existing\` resources were passed. `
      + 'There is nothing to draw. Either write the network design — VPC, subnets, security '
      + 'groups — or, to picture an account as it already stands, call '
      + 'list_existing_resources first and pass what it returns as `existing`.',
    )
  }

  // A deployment with no configuration but with `existing` resources is the
  // "draw my account as it is" case, and it is a first-class one rather than an
  // error: nothing is being created, and the picture is of what already exists.
  //
  // That case takes its own path because it asks a different question. A design
  // is a configuration; an account is a set of resources and the references
  // between them. Deriving the second from the first would need a table of
  // service vocabulary that grows with every service — so the inventory's own
  // shape is read instead.
  if (configFiles.length === 0) {
    return await handleInventoryOnly(deployment, existing)
  }

  // Parse every file before drawing anything: a syntax error in the third file
  // must not produce a diagram built from the first two.
  //
  // The file set is the shared one — workspace files plus the `.tf` of any local
  // module the configuration calls — so a design written in a module is checked
  // and drawn like one written inline.
  //
  // This reads the files itself rather than using `parseConfiguration`, because
  // it is the tool that REPORTS a broken file: it needs to know which file
  // failed and whether the failure was reading or parsing, and it names that in
  // the result. The shared reader drops a broken file silently, which is right
  // for a gate that must not mistake it for absence, and wrong here.
  const sources: { readonly file: string, readonly text: string }[] = []
  for (const file of configFiles) {
    try {
      sources.push({ file, text: await readFile(join(deployment, file), 'utf8') })
    } catch (error) {
      return fail(
        `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const blocks = []
  for (const source of sources) {
    try {
      // Both syntaxes terraform reads. A `.tf.json` is the same configuration
      // in JSON form, and terraform plans it identically — so a design written
      // that way must be checked and drawn like any other.
      blocks.push(...(source.file.endsWith('.tf.json')
        ? parseJsonResources(source.text)
        : parseResources(source.text)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(`${source.file}: ${message}`)
    }
  }

  if (blocks.length === 0) {
    return fail(
      `the ${CONFIG_EXTENSION} files declare no resource blocks, so there is nothing to draw. `
      + 'A network design is at least one huaweicloud_vpc and the subnets cut from it.',
    )
  }

  const topology = deriveTopology(blocks, existing)
  if (topology.nodes.length === 0) {
    // Everything passed was outside the network picture — an alarm rule, a log
    // group, a backup. Rendering that as an empty SVG would present "there is
    // nothing here" about an account that says a great deal; the reader is owed
    // the reason and the types.
    const types = topology.omitted
      .slice(0, 8)
      .map(entry => `${entry.type}${entry.count > 1 ? ` ×${entry.count}` : ''}`)
      .join(', ')
    const supplied = blocks.length + existing.length
    return fail(
      `all ${supplied} resource(s) supplied are outside the network picture, so there is no `
      + `topology to draw. They are: ${types}`
      + `${topology.omitted.length > 8 ? ', and others' : ''}. `
      + 'The picture shows the network and what it carries: VPCs, subnets, security groups and '
      + 'their rules, gateways, load balancers, compute instances and managed databases.',
    )
  }
  const edges = edgesOf(blocks, topology)

  // Render before validating: a provider download is slow and may be skipped,
  // while the picture is what the user is asked to review. Failing the whole
  // call because validation was skipped would withhold the picture for a
  // reason that has nothing to do with it.
  let svg: string
  let d2: string
  try {
    // Both pictures — the design and the account — go through the same layout
    // and renderer, so they can be compared side by side. See `design-render.ts`.
    const rendered = renderDesignDiagram(topology, edges)
    svg = rendered.svg
    d2 = rendered.source
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(
      `the topology could not be rendered: ${message}. `
      + 'This is a defect in this tool rather than in the configuration — '
      + 'the resources were read successfully, so the design itself parsed.',
    )
  }

  try {
    await writeFile(join(deployment, D2_FILE), d2, 'utf8')
    await writeFile(join(deployment, TOPOLOGY_FILE), svg, 'utf8')
  } catch (error) {
    return fail(
      `the diagram could not be written into ${deployment}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const validation = await runValidation(deployment)
  // Record what was checked, not just that something ran.
  //
  // The digest is of the configuration as it stands now; the apply gate
  // recomputes it and refuses when they differ, so a design edited after this
  // ran is not treated as checked. `ok` records whether validation passed, so a
  // failed run cannot be read later as an approval.
  //
  // This is bookkeeping rather than the tool's subject: a directory that is not
  // a deployment workspace still gets its diagram and its findings, and a
  // failure to record must not discard that work. But the apply gate READS this
  // record, so a silent failure would surface later as "this deployment's
  // network design has never been checked" — an answer that names neither the
  // cause nor this run. It is reported instead.
  let recordFailure: string | undefined
  const tfHash = await computeTfHash(deployment).catch((error: unknown) => {
    recordFailure =
      `the configuration digest could not be computed (${error instanceof Error ? error.message : String(error)}), `
      + 'so this check was not recorded and terraform_apply will not see it.'
    return undefined
  })
  if (tfHash !== undefined) {
    const recorded = await updateSnapshot(deployment, {
      last_operation: 'validate_design',
      design_check: {
        tf_hash: tfHash,
        ok: validation.state === 'passed',
        checked_at: new Date().toISOString(),
      },
    }).then(() => undefined, (error: unknown) => String(error))
    if (recorded !== undefined) {
      recordFailure =
        `the design was checked, but the deployment could not record it (${recorded}). `
        + 'terraform_apply reads that record and will refuse this design until validate_design '
        + 'succeeds at writing it.'
    }
  }

  const diagramPath = resolve(deployment, TOPOLOGY_FILE)

  return okJson({
    deployment,
    diagram: {
      svg: diagramPath,
      d2: resolve(deployment, D2_FILE),
      note:
        `Show the user the picture by writing this into your reply as a Markdown image: `
        + `![topology](${diagramPath})`,
    },
    validation,
    findings: topology.findings,
    resources: topology.nodes.map(node => ({
      address: node.address,
      kind: node.kind,
      parent: node.parent ?? null,
    })),
    // How the VPCs reach each other. Reported separately from the resources
    // because a peering or an endpoint is a relationship, not a device: the
    // picture draws it as a labelled edge, and a reader listing the design
    // needs to see that "these two are joined" explicitly.
    connections: topology.connections.map(connection => ({
      address: connection.address,
      kind: connection.kind,
      from: connection.from ?? null,
      to: connection.to ?? null,
      // An endpoint whose service lives in another account has no far side here.
      // Drawn as nothing, and said so, rather than pointed at an invented box.
      ...(connection.to === undefined || connection.from === undefined
        ? { unresolved: 'the other network is not declared in this configuration' }
        : {}),
    })),
    // What the picture does NOT show. A deployment declares alarm rules,
    // backups and key pairs beside its network, and a reader must know the
    // diagram is not the whole file without being shown forty irrelevant boxes.
    omitted: topology.omitted,
    summary: {
      drawn: topology.nodes.length,
      omitted: topology.omitted.reduce((sum, entry) => sum + entry.count, 0),
      errors: topology.findings.filter(finding => finding.severity === 'error').length,
      warnings: topology.findings.filter(finding => finding.severity === 'warning').length,
      validation: validation.state,
      verified: validation.state === 'passed',
    },
    ...(recordFailure === undefined ? {} : { warning: recordFailure }),
    next: nextStep(validation, topology.omitted),
  })
}

/**
 * What the model should do next, given how validation went.
 *
 * `summary.verified` is the field that matters, and these sentences say what it
 * means. A diagram of a design that failed `terraform validate` looks exactly
 * as convincing as a diagram of one that passed — the picture is drawn from
 * the configuration either way — so the model must not describe the first as
 * checked. The same applies to a design validation never saw.
 *
 * @param validation - the outcome of the check.
 * @param omitted - the resource types the picture leaves out.
 * @returns guidance for the model.
 */
function nextStep(
  validation: ValidationOutcome,
  omitted: readonly OmittedResource[] = [],
): string {
  // The diagram is not the whole file, and saying so is part of reading it
  // correctly. Stated once, with the count, rather than per resource: the
  // reader needs to know the picture is a view, not an inventory.
  const omission = omitted.length === 0
    ? ''
    : ` The picture shows the network and what it carries; ${omitted.reduce((sum, entry) => sum + entry.count, 0)}`
      + ` resource(s) of ${omitted.length} other type(s) are listed under \`omitted\` and not drawn`
      + ' (alarm rules, backups, keys and the like). Mention that the diagram is a view of the'
      + ' design, not a full inventory.'
  const show = 'Show the diagram with ![...](<the svg path>) and report the findings.'
  if (validation.state === 'failed') {
    return `${show} Validation FAILED: fix the diagnostics listed under \`validation\` `
      + 'before showing this design as ready, then call this tool again. '
      + 'Do not add compute resources until the configuration validates.'
  }
  if (validation.state === 'skipped') {
    return `${show} The configuration was NOT checked against the provider schema — `
      + 'say so when you present it, and do not describe it as validated. '
      + `Call terraform_init, then call this tool again to run the check.${omission}`
  }
  return `${show} Validation passed.${omission} Get the user's explicit agreement before adding `
    + 'compute resources, and call this tool again after any design change.'
}

/** What happened when `terraform validate` was attempted. */
interface ValidationOutcome {
  /** `passed`, `failed`, or `skipped` with the reason in {@link detail}. */
  readonly state: 'passed' | 'failed' | 'skipped'
  /** The diagnostics, when validation ran and found something. */
  readonly diagnostics?: readonly ValidationDiagnostic[]
  /** Why validation did not run, when it was skipped. */
  readonly detail?: string
}

/**
 * One problem `terraform validate` reported.
 *
 * `file` and `line` come from the diagnostic's range and are carried
 * separately from the text: the summary alone ("Unsupported argument") does
 * not say which file or which argument, and a reader has to open the
 * configuration to find out. Naming the position is what turns a diagnostic
 * into an edit.
 */
interface ValidationDiagnostic {
  readonly severity: string
  readonly summary: string
  /** `main.tf:29`, when the diagnostic carried a range. */
  readonly at?: string
  readonly detail?: string
}

/**
 * Run `terraform validate` when it can run.
 *
 * The check is skipped, not failed, when the provider is not installed. Terraform
 * refuses to validate a configuration whose provider is absent (verified: it
 * answers "requires provider … but that provider isn't available"), so running
 * it would report the provider's absence as if it were the configuration's
 * fault. Saying "not validated, run terraform_init" is the accurate statement.
 *
 * `-json` is used rather than scraping the human output: the diagnostics carry
 * `severity`, `summary` and `detail` as fields, and the ranges name the file
 * and line, which is what a reader fixes.
 *
 * @param deployment - the deployment workspace directory.
 * @returns what validation reported.
 */
async function runValidation(deployment: string): Promise<ValidationOutcome> {
  if (!(await providerInstalled(deployment))) {
    return {
      state: 'skipped',
      detail:
        'The huaweicloud provider is not installed in this deployment, so `terraform validate` '
        + 'could not run and the configuration has not been checked against the provider schema. '
        + 'Call terraform_init to install it, then call this tool again.',
    }
  }

  let result
  try {
    result = await runTerraform(deployment, ['validate', '-json'])
  } catch (error) {
    return {
      state: 'skipped',
      detail: `terraform validate could not be launched: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const parsed = parseValidateJson(result.stdout)
  if (parsed === undefined) {
    // A non-zero exit with no parseable JSON means terraform itself failed —
    // not that the configuration is invalid. Reporting it as a design error
    // would send the reader to the wrong file.
    return {
      state: 'skipped',
      detail:
        `terraform validate did not produce a JSON report (exit ${result.exitCode}). `
        + `Its output was: ${(result.stderr || result.stdout).trim().slice(0, 800)}`,
    }
  }

  if (parsed.valid) return { state: 'passed' }
  const diagnostics = parsed.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  return {
    state: 'failed',
    diagnostics: diagnostics.length > 0 ? diagnostics : parsed.diagnostics,
  }
}

/**
 * Read `terraform validate -json` output.
 *
 * @param stdout - the command's stdout.
 * @returns the parsed report, or `undefined` when it was not JSON.
 */
function parseValidateJson(
  stdout: string,
): { valid: boolean, diagnostics: ValidationDiagnostic[] } | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object') return undefined
  const report = raw as {
    valid?: unknown
    diagnostics?: {
      severity?: unknown
      summary?: unknown
      detail?: unknown
      range?: { filename?: unknown, start?: { line?: unknown } }
    }[]
  }
  if (typeof report.valid !== 'boolean') return undefined
  const diagnostics = (report.diagnostics ?? []).flatMap((diagnostic): ValidationDiagnostic[] => {
    if (typeof diagnostic.summary !== 'string') return []
    const filename = diagnostic.range?.filename
    const line = diagnostic.range?.start?.line
    const at = typeof filename === 'string' && typeof line === 'number'
      ? `${filename}:${line}`
      : undefined
    return [{
      severity: typeof diagnostic.severity === 'string' ? diagnostic.severity : 'error',
      summary: diagnostic.summary,
      ...(at === undefined ? {} : { at }),
      ...(typeof diagnostic.detail === 'string' ? { detail: diagnostic.detail } : {}),
    }]
  })
  return { valid: report.valid, diagnostics }
}
/**
 * Draw an account that already exists, from the inventory's own shape.
 *
 * ## Why this does not go through the design path
 *
 * A design is a configuration, and its picture is derived from resource blocks.
 * An account is a set of resources and the references between them, reported by
 * the inventory with the properties each service attaches. Those are different
 * inputs, and reading the second through the first would need a table mapping
 * every service's vocabulary onto the diagram's — the kind of table that grows
 * with every service and is wrong the first time one is missing.
 *
 * So this path asks the inventory what it saw: ids, types, names, properties.
 * Relationships come from ids appearing in properties, and containment from the
 * direction references flow. No service is named anywhere.
 *
 * @param deployment - the deployment workspace directory, used only for output.
 * @param existing - the resources the caller reported.
 * @returns the tool result.
 */
async function handleInventoryOnly(
  deployment: string,
  existing: readonly ExistingResource[],
): Promise<ToolResult> {
  // `properties` carries the relationships, so a resource without one can only
  // be drawn as an isolated box. Counting them is worth reporting: a caller who
  // dropped the field gets an unconnected picture and a reason.
  const withProperties = existing.filter(
    resource => resource.properties !== undefined && Object.keys(resource.properties).length > 0,
  )
  if (withProperties.length === 0) {
    return fail(
      'none of the `existing` resources carried a `properties` object, so there are no '
      + 'relationships to derive — the diagram would be a list of unconnected boxes. '
      + 'Pass each resource\'s `properties` from list_existing_resources verbatim; that is '
      + 'where the ids that connect resources live.',
    )
  }

  let svg: string
  let d2: string
  let diagram: Diagram
  try {
    // The account is drawn by this plugin's own layout and renderer rather than
    // by a graph engine: its structure is nested regions, and a graph layout
    // puts sibling containers side by side whatever they hold. See `layout.ts`.
    //
    // The resources go in as the caller sent them, `properties` included — that
    // object is where every relationship lives, and a derivation that dropped it
    // would leave the picture a list of unconnected boxes.
    const resources = withProperties.map(resource => ({
      id: resource.id,
      provider: resource.provider ?? '',
      type: resource.type,
      ...(resource.name === undefined ? {} : { name: resource.name }),
      ...(resource.region === undefined ? {} : { region: resource.region }),
      properties: resource.properties ?? {},
    }))
    const rendered = renderAccountDiagram(resources)
    diagram = rendered.diagram
    svg = rendered.svg
    d2 = rendered.source
  } catch (error) {
    return fail(
      `the topology could not be rendered: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  try {
    // `mkdir` first: this path is the one a caller reaches without ever having
    // created a deployment — "draw my account as it stands" needs no
    // configuration, and `create_deployment` would be a call with nothing to
    // put in it. Writing into a directory that is not there fails with ENOENT,
    // which reads as a broken tool rather than as a missing step.
    await mkdir(deployment, { recursive: true })
    await writeFile(join(deployment, D2_FILE), d2, 'utf8')
    await writeFile(join(deployment, TOPOLOGY_FILE), svg, 'utf8')
  } catch (error) {
    return fail(
      `the diagram could not be written into ${deployment}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const diagramPath = resolve(deployment, TOPOLOGY_FILE)
  const provided = existing.length - withProperties.length

  return okJson({
    deployment,
    mode: 'inventory',
    diagram: {
      svg: diagramPath,
      d2: resolve(deployment, D2_FILE),
      note:
        'Show the user the picture by writing this into your reply as a Markdown image: '
        + `![topology](${diagramPath})`,
    },
    validation: {
      state: 'skipped' as const,
      detail:
        'There is no configuration to validate — this picture is of resources that already '
        + 'exist. Write a network .tf and call this tool again to have it checked.',
    },
    resources: diagram.boxes.map(box => ({
      id: box.id,
      type: diagram.roles.get(box.id) === 'container' ? 'container' : 'resource',
      label: box.label,
      depth: box.depth,
    })),
    edges: diagram.edges.map(edge => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      label: edge.label,
    })),
    summary: {
      drawn: diagram.boxes.length,
      edges: diagram.edges.length,
      nested: diagram.boxes.filter(box => box.depth > 0).length,
      ...(provided === 0 ? {} : { without_properties: provided }),
      validation: 'skipped',
    },
    next:
      'Show the diagram and name what it shows: the VPCs, what sits inside them, and the '
      + 'connections between resources. The nesting comes from references between ids, so a '
      + 'resource at the root is one nothing in the account names as its container.'
      + (provided === 0
        ? ''
        : ` ${provided} resource(s) carried no properties and are not in the picture — `
          + 'say so rather than presenting the diagram as the whole account.'),
  })
}
