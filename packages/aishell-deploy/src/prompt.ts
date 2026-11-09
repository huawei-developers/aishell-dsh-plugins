/**
 * What the model reads about how to use this plugin's tools.
 *
 * ## What belongs here, and what belongs in a tool description
 *
 * The boundary is one sentence: **a description answers "what happens if I call
 * this tool"; this section answers "what do I do next, and when must I stop and
 * ask".**
 *
 * Three things follow, and they decide where each piece of text lives:
 *
 *   - **No single tool knows the order.** Which call comes before which is a
 *     fact about the set, and a description that restated it would be a second
 *     copy to keep in step — one that reads as authoritative while being the
 *     stale one.
 *   - **No tool can enforce consent.** `plan_gate.ts` says so itself: whether a
 *     person actually looked at the plan is not observable from inside the
 *     process. A description saying "MUST confirm" claims a guarantee the tool
 *     does not have; getting the agreement is the step, so it belongs here.
 *   - **A description must still state what the tool itself refuses**, because
 *     that is behaviour: `terraform_apply`'s five gates, `terraform_destroy`'s
 *     target match, `validate_design`'s refusal to draw a non-network
 *     configuration. A model that cannot predict a refusal reports it as a bug.
 *
 * ## Why the text is assembled rather than fixed
 *
 * DSH sends the full tool list on every request, so both this section and the
 * descriptions are always in context. What decides the design is not frequency
 * but scope: this section describes a workflow across many tools, and an agent
 * whose toolset was narrowed still reads whatever is here.
 *
 * A fixed string can only be shown or hidden as a whole, so hiding it for one
 * missing tool hides it for every tool that is still there. An agent holding
 * `list_existing_resources` and `validate_design` with no instructions is worse
 * off than one holding none at all, because the tools look usable.
 *
 * So each block declares the tools it is about, and a block whose tools are not
 * all present is dropped. Steps renumber themselves, so a shortened workflow
 * still reads as a sequence rather than as missing numbers.
 *
 * ## Why `section()` and not `context()`
 *
 * The policy switch uses `context()`, because a mode change should cost one
 * message when it changes and nothing afterwards. This text is different: it is
 * stable, and it must be present on every turn, not committed once as history.
 * A section is part of the assembled prompt, so it is in front of the model at
 * every step.
 *
 * ## Where it sits in the assembled prompt
 *
 * The assembled prompt is a fixed sequence of ordered slots. The built-in
 * per-tool narration occupies 1000–3000 and the SDK documentation starts at
 * 5000, so 3100 is the gap reserved for guidance contributed by an outside
 * source — which is what a section describing a group of contributed tools is.
 *
 * Anything earlier would read as a built-in tool's own narration; anything
 * later would land among the SDK reference. A section that is policy rather
 * than guidance belongs in `context()` instead, which is what the read-only
 * switch uses.
 *
 * The name is used rather than the number: the framework owns the ordering, and
 * a hard-coded 3100 would drift from it silently the first time a built-in tool
 * section is added.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.systemPrompt merge.
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Name this contribution registers under; unique across the assembled prompt. */
export const WORKFLOW_SECTION_NAME = 'aishell:deploy-workflow'

/** One step of the workflow, with the tools it depends on. */
interface WorkflowStep {
  /**
   * Tools this step is about.
   *
   * Every one must be registered for the step to appear. The list is what the
   * step's text actually names, so a step never describes a call the model
   * cannot make.
   */
  readonly requires: readonly string[]
  /** The step's text. `%n` is replaced with the step's number. */
  readonly text: string
}

/**
 * A tool name as the model sees it.
 *
 * @param name - the tool's own name.
 * @returns the registered name.
 */
function tool(name: string): string {
  return `aishell__${name}`
}

/**
 * The opening paragraph, which needs no particular tool.
 *
 * It names the reason to prefer these tools over shell: the gates. That is true
 * as long as any of them exists.
 */
const PREAMBLE = `Huawei Cloud work goes through the aishell__ tools below, not through shell commands. They carry the safety gates (a plaintext-credential scan, a cost-hash check, a networking check) that a bare \`terraform\` invocation bypasses.`

/**
 * The deployment flow, in the order a deployment is built.
 *
 * Each step names the tools it is about. A step whose tools are absent is
 * dropped and the rest renumber, which is why the text carries `%n` rather than
 * a number.
 */
const FLOW: readonly WorkflowStep[] = [
  {
    requires: ['auth'],
    text: `%n. ${tool('auth')} — verify the account and list its projects. Each project's \`name\` is a region; a region-scoped API (one whose path contains \`{project_id}\`) needs the project id from here.`,
  },
  {
    requires: ['list_existing_resources'],
    text: `%n. ${tool('list_existing_resources')} — what the account already has. This is the first question, not the fifth: a design for an account that already runs a VPC is mostly "what can be reused and what must not collide", and nothing in the .tf can tell you that. Drill into the services the user's request is about (\`service: "vpc"\`, then \`"ecs"\` and so on); the summary alone is counts. On \`service: "vpc"\` the answer also carries the SUBNETS, read from the VPC API because RMS does not report them — pass those on like any other resource.`,
  },
  {
    requires: ['create_deployment', 'validate_design'],
    text: `   ${tool('create_deployment')} — create or reuse the deployment workspace. If the user only wants to SEE what is deployed, skip this and pass the inventory straight to ${tool('validate_design')}, which draws the account as it stands.`,
  },
  {
    requires: ['terraform_install'],
    text: `%n. ${tool('terraform_install')} — ensure a terraform binary is available: \`terraform_path\` if the user has one, else PATH, else the host cache, else a download from \`binary_mirrors\`. Idempotent, so calling it when one is already present costs nothing — call it before \`terraform_init\`, not after it fails with "terraform not found".`,
  },
  {
    requires: ['terraform_init', 'validate_design'],
    text: `   ${tool('terraform_init')} — install the provider. This comes BEFORE the design check, not after: \`terraform validate\` needs the provider to have an opinion about a configuration, and without it \`validate_design\` reports "not validated" — a design nobody checked against the provider schema. The gate here also scans for plaintext credentials and refuses if it finds any.`,
  },
  {
    requires: ['apiexplorer'],
    text: `   ${tool('apiexplorer')} — look up API definitions. With no arguments it lists every service; with a product it lists that service's APIs; with an API name it returns the contract (\`compact: true\` for the condensed form, \`regions: true\` for available regions and project ids).`,
  },
  {
    requires: ['terraform_examples_export'],
    text: `   ${tool('terraform_examples_export')} — write \`.tf\` examples to a directory. That directory is a reference target, not the deployment workspace.`,
  },
  {
    requires: ['validate_design'],
    text: `%n. Write the network \`.tf\`: the VPC, its subnets, the security groups and their rules, and any gateway or load balancer. This stage needs no flavour, no image and no resource id — the network design is what decides those, not the other way round — so it needs no cloud credentials either.
   Write the provider block with the region as a LITERAL: \`provider "huaweicloud" { region = "cn-north-4" }\`. Nothing else carries it. There is no plugin-wide default region, so a provider block without one is a configuration terraform refuses, and a region given as a variable is one the price inquiry cannot read. A deployment may declare several provider blocks with different regions and point resources at each with \`provider = huaweicloud.<alias>\`; the price inquiry prices each resource in its own region.
   ${tool('validate_design')} — check that design and draw it. It runs \`terraform validate\` when the provider is installed, then reports what terraform cannot: overlapping subnet CIDRs, a subnet outside its VPC, a gateway_ip outside its subnet, and rules open to 0.0.0.0/0 on administrative or database ports. It writes \`topology.svg\` beside the configuration and returns its absolute path.
   The drawing is a VIEW, not an inventory. It shows the network and what it carries; a configuration also declares alarm rules, log groups, backups and key pairs, and those come back counted under \`omitted\` and are not drawn. If \`omitted\` is non-empty, say so — do not let the picture read as the whole file. Connections between VPCs (a peering, a VPCEP endpoint, a route) are drawn as LABELLED EDGES rather than boxes, and listed under \`connections\`; an entry with \`unresolved\` means the far network is not declared here, which is normal for an endpoint service published by another account.
   Pass the resources from the inventory that this design is about as \`existing\`, so the picture shows what is already deployed (dashed) next to what would be created. Two things depend on it. An existing subnet is what a new subnet can COLLIDE with, and that collision is invisible to a check that only reads the .tf. And a .tf that reuses a VPC it does not declare (\`vpc_id = huaweicloud_vpc.prod.id\` with no \`huaweicloud_vpc.prod\` block) needs \`address: "huaweicloud_vpc.prod"\` on that existing resource, or the subnet is drawn at the root as if it created a new VPC.
   ★ Show the diagram and the findings, and get explicit agreement before going further. Put the picture in your reply as \`![topology](<the absolute path it returned>)\`. If the user asks for changes, edit the \`.tf\`, call validate_design again, and show the new picture. Do not start any later step before they accept.
   ★ Opening SSH to 0.0.0.0/0 is a risk. The tool reports it; still raise it in your own words and ask the user to restrict the source range. A finding is information, not permission.`,
  },
  {
    requires: ['list_existing_resources'],
    text: `%n. Report the balance summary from the inventory: balance and vouchers.`,
  },
  {
    requires: ['terraform_import', 'terraform_plan', 'lookup_specs'],
    text: `%n. Decide per component: reuse or create.
   - Reuse: the spec and charging are fixed by the existing resource. Write the resource block, then ${tool('terraform_import')} to bring it into state. This needs the provider installed.
     ★ An import does NOT check that the block you wrote matches the resource that exists — it records what the cloud holds. Call ${tool('terraform_plan')} straight after each import and show the user the diff. A non-empty diff means applying would CHANGE a resource they asked you to leave alone, possibly by replacing it. Fix the block until the plan shows no change, or get explicit agreement that the change is wanted.
   - Create: ${tool('lookup_specs')} takes \`region\` and \`availability_zone\` and lists the flavours and images that region actually sells there, with each flavour's vCPUs, memory and disk and each image's OS and minimums. Both are required: a flavour exists per zone in a region, and a catalogue listed for one region says nothing about another. Pass the region from the provider block. Call it BEFORE writing the resource block: \`flavor_id\` and \`image_id\` are values only the region knows, and an invented one passes \`terraform validate\` (it checks only that the value is a string) and fails at apply.
     Pick a flavour and an image whose minimum disk and memory the flavour can meet, and state the choice to the user — this is the decision the price hangs on.`,
  },
  {
    requires: ['terraform_plan'],
    text: `%n. Add the compute, database and other resources to the same \`.tf\` files, from the design agreed above and the flavours chosen. Credentials come from the environment; never write \`access_key\`, \`secret_key\` or \`security_token\` into a \`.tf\` file.
   ${tool('provider_schema')} — the argument contract for a resource type, when you need it.
   ${tool('terraform_plan')} — compute the change and save it to \`plan.tfplan\`. It returns one entry per resource: the action (create / update / **replace** / destroy), the attribute names an update touches, and — for a replace — what forces the rebuild. It also returns the security-group rules the change would create.
   ★ Show the user every resource with its action, and the security-group rules. A **replace** is not an update: terraform destroys the resource and builds it again, so the data on that disk or database is gone. Call it out by name and say what forces it. Do not proceed on "a few things change" — name them. Do not describe the plan as reversible.`,
  },
  {
    requires: ['price_resources', 'terraform_plan'],
    text: `%n. ${tool('price_resources')} — read the SAVED PLAN and quote every priceable resource against this account's own on-demand prices, then write \`cost.json\`. Prices come after the plan, not before, because the plan is the real list: a block with \`count = 3\` is three instances, \`for_each\` is one per key, and a module's resources are visible — none of which the .tf files show. Each figure is a month (730 hours), with the list price and the moment of the inquiry.
   It prices compute instances (Linux and Windows bill separately, from the image), RDS, DCS, EVS volumes, EIPs, NAT gateways, ELB load balancers, APIG instances and VPCEP endpoints. Do NOT walk the .tf yourself to estimate the rest: it reports exactly which resources it could not price and why, and a spec that came from a variable cannot be priced at all. Read that list rather than assuming a type is covered. Say which ones are unpriced — a total that silently omits them understates the bill.`,
  },
  {
    requires: ['price_resources'],
    text: `%n. ★ Report the cost before applying: each resource's spec, its monthly figure, the total, and which resources are unpriced and why, plus the balance and vouchers. Get the user's explicit agreement on the specification and the cost.
   Vouchers are applied automatically at the account level (voucher, then cash coupon, then balance) with nothing to configure in \`.tf\`. Say so: if vouchers exist, the actual monthly increase may come in below the quoted figure. Check each voucher's \`expire_time\` and warn about any nearing expiry.`,
  },
  {
    requires: ['terraform_apply'],
    text: `%n. ${tool('terraform_apply')} — run it. Five gates run first: the design was checked by ${tool('validate_design')}, the cost was quoted by ${tool('price_resources')}, and ${tool('terraform_plan')} computed the saved plan — each of the three recorded against a digest of the configuration, and each refusing when the \`.tf\` has changed since. The fifth is the credential scan. Then it applies THAT saved plan rather than re-planning, so the changes executed are exactly the ones shown in the plan.
   A successful apply SPENDS the plan: terraform will not run the same plan file twice, so the tool clears it and its records. What follows is a new change set — plan, price, then apply again. Expect that rather than treating the cleared plan as a failure.
   A deployment with nothing to charge for — a VPC, subnets, security groups and routes — still gets a cost record saying so. price_resources reports \`nothing_billable\`, and that record satisfies the gate: the absence of a charge is an approval, the absence of a quote is not.`,
  },
]

/**
 * Destroying and resynchronising.
 *
 * Its own block because it is a different task, reached from a different place
 * in a conversation, and because each bullet is about a different tool.
 */
const DESTROYING: readonly WorkflowStep[] = [
  {
    requires: ['terraform_destroy', 'terraform_plan', 'terraform_state'],
    text: `- ${tool('terraform_destroy')} applies the teardown ${tool('terraform_plan')} saved. It refuses when the state is empty, when the .tf holds plaintext credentials, or when the saved teardown covers different targets from the ones this call names.
  ★ Call ${tool('terraform_plan')} with \`destroy: true\` first, passing the SAME \`target\` list you intend to destroy. It returns every resource that would be removed, one entry each — show that list, then call terraform_destroy with the same targets. The saved plan is what destroy runs, so the resources that go away are exactly the ones the user saw. Destruction cannot be undone.
  If the deployment also imported existing resources, destroy only what this deployment created: pass their addresses as \`target: [...]\` and leave the imported ones in state. ${tool('terraform_state')} lists the addresses; terraform_plan with destroy: true says which ones the deployment would remove.`,
  },
  {
    requires: ['terraform_refresh', 'terraform_plan'],
    text: `- ${tool('terraform_refresh')} — when the cloud changed outside terraform (edited in the console, a resource deleted by hand), refresh state and then plan to see the difference.`,
  },
  {
    requires: ['terraform_state'],
    text: `- ${tool('terraform_state')} — read state. Without \`address\` it returns the INVENTORY: one entry per managed resource with its address, type and module. Those addresses are what \`terraform_import\`, \`destroy: true\` and \`target: [...]\` all take. With \`address\` it returns that one resource in full. The attributes of every resource at once are deliberately not returned — a real deployment runs to megabytes of them. Both forms also return the security-group rules the state records.`,
  },
]

/** The rules that hold whenever the tools are present at all. */
const HARD_LINES = `## Hard lines

- Cloud resources are created and destroyed **only** through aishell__terraform_apply and aishell__terraform_destroy. Do not use \`POST\`/\`PUT\`/\`DELETE\` on aishell__openapi_request to create or destroy resources unless the user explicitly asks for the API route and understands the consequences: it skips the cost gate, never enters tfstate, and leaves no trace.
- Before applying or destroying, name the resources involved and get the user's explicit agreement. Never run these silently.
- A \`.tf\` file must never contain a plaintext \`access_key\`, \`secret_key\` or \`security_token\`. The scan runs before init and apply and refuses the run.
- \`cost.json\` must exist and its \`tf_hash\` must match before apply. Editing a \`.tf\` file invalidates it; recompute the cost.
- Other \`POST\`/\`DELETE\` calls (issuing a voucher, adjusting a quota — not resource lifecycle) do run, and return a warning. Pass that warning to the user.`

/** Region advice that is independent of which tools are present. */
const REGION_FILING = `## Mainland region filing

In mainland regions (cn-north-1, cn-north-4, cn-east-3 and others), serving web traffic on ports 80/443 requires ICP filing. Traffic is blocked without it. If the user wants a web port, ask about their filing status first.`

/** Answers to the questions that map onto one call each. */
const TYPICAL_REQUESTS: readonly WorkflowStep[] = [
  {
    requires: ['list_existing_resources'],
    text: `- "How many ECS instances do I have?" → aishell__list_existing_resources with \`service: "ecs"\``,
  },
  {
    requires: ['openapi_request'],
    text: `- "What did I spend this month?" → aishell__openapi_request("GET", <BSS bill API>)`,
  },
  {
    requires: ['list_existing_resources'],
    text: `- "How many vouchers do I have?" → the \`balance_summary\` field of aishell__list_existing_resources`,
  },
  {
    requires: ['provider_schema'],
    text: `- "What arguments does this resource take?" → aishell__provider_schema(deployment, "huaweicloud_compute_instance")`,
  },
  {
    requires: ['terraform_destroy'],
    text: `- "Tear this deployment down" → aishell__terraform_destroy, after listing the resources for confirmation`,
  },
  {
    requires: ['terraform_refresh', 'terraform_plan'],
    text: `- "The cloud changed, resync" → aishell__terraform_refresh, then aishell__terraform_plan for the difference`,
  },
  {
    requires: ['terraform_state'],
    text: `- "What is deployed right now?" → aishell__terraform_state`,
  },
  {
    requires: ['terraform_import'],
    text: `- "Bring this existing instance under management" → write the resource block, then aishell__terraform_import`,
  },
]

/** Where to read about a product, and what not to answer from memory. */
const PRODUCT_DOCS = `## Product documentation

For what a Huawei Cloud product *is* — features, quotas, limits, charging models — read the index at https://support.huaweicloud.com/llms.txt. It lists every product's documentation entry point by category; read it to locate the product, then that product's own \`llms.txt\` for detail.

Do not answer questions about a product's feature boundaries, quotas or charging rules from memory — they change between releases. For API contracts use aishell__apiexplorer; for what exists in the account use aishell__list_existing_resources; this index is for "what is this product and what are its limits".`

/**
 * Whether every tool a block names is registered for this render.
 *
 * @param requires - the tool names, without the `aishell__` prefix.
 * @param present - the lookup bound to the current render scope.
 * @returns whether the block applies.
 */
function allPresent(
  requires: readonly string[],
  present: (name: string) => boolean,
): boolean {
  return requires.every(name => present(tool(name)))
}

/**
 * Render an ordered list of steps, numbering only the ones that apply.
 *
 * A step whose text begins with indentation is a continuation of the step
 * before it, and keeps that step's alignment rather than taking a number — the
 * distinction is carried by the text, because `requires` differs between a
 * parent step and its continuation.
 *
 * @param steps - the steps to consider.
 * @param present - the lookup bound to the current render scope.
 * @returns the rendered lines.
 */
function renderSteps(
  steps: readonly WorkflowStep[],
  present: (name: string) => boolean,
): string[] {
  const lines: string[] = []
  let number = 0
  for (const step of steps) {
    if (!allPresent(step.requires, present)) continue
    if (step.text.startsWith('   ')) {
      // A continuation: no number of its own, and no advance.
      lines.push(step.text)
      continue
    }
    number += 1
    lines.push(step.text.replace('%n', String(number)))
  }
  return lines
}

/**
 * The workflow text for one render scope.
 *
 * @param present - whether a tool with the given name is registered here.
 * @returns the section's text, empty when nothing it describes is available.
 */
export function buildDeployWorkflow(present: (name: string) => boolean): string {
  // Everything in this section is guidance ABOUT some tool. With none of them
  // registered there is nothing to guide, and the section renders empty rather
  // than advising on calls the model cannot make.
  const flow = renderSteps(FLOW, present)
  const destroying = renderSteps(DESTROYING, present)
  const typical = renderSteps(TYPICAL_REQUESTS, present)

  const lifecyclePresent = allPresent(['terraform_apply'], present)
    || allPresent(['terraform_destroy'], present)
  const docsPresent = allPresent(['apiexplorer'], present)
    || allPresent(['list_existing_resources'], present)

  if (
    flow.length === 0 && destroying.length === 0 && typical.length === 0
    && !lifecyclePresent && !docsPresent
  ) {
    return ''
  }

  // Assembled in the order a reader moves through: why these tools, then the
  // build, then teardown, then the rules that hold throughout, then the
  // shortcuts and the background reading.
  const blocks: string[] = [PREAMBLE]

  if (flow.length > 0) {
    blocks.push([
      '## Deployment flow',
      '',
      'Steps marked ★ require the user\'s explicit agreement before you continue.',
      '',
      ...flow,
    ].join('\n'))
  }

  if (destroying.length > 0) {
    blocks.push(['## Destroying and resynchronising', '', ...destroying].join('\n'))
  }

  if (lifecyclePresent) blocks.push(HARD_LINES)

  // Region advice holds for any deployment work, so it follows the tools rather
  // than depending on a particular one. It is a caveat about the region a
  // design chose, not a step, so it sits after the flow rather than inside it.
  blocks.push(REGION_FILING)

  if (typical.length > 0) {
    blocks.push(['## Typical requests', '', ...typical].join('\n'))
  }

  if (docsPresent) blocks.push(PRODUCT_DOCS)

  return blocks.join('\n\n')
}

/**
 * Where this section sits among the assembled prompt's sections.
 *
 * DSH concatenates sections in ascending order. The built-in per-tool
 * narration occupies 1000–3000 and the SDK documentation starts at 5000, so
 * 3100 is the gap between them. This workflow describes a contributed group of
 * tools, which is what belongs there: after every built-in tool's narration,
 * before the SDK reference.
 */
const WORKFLOW_SECTION_ORDER = 3100

/**
 * Register the workflow section.
 *
 * Deferred behind `ctx.inject` rather than declared in this plugin's own
 * `inject`: the workflow is an enhancement, and a deployment without a system
 * prompt should lose the guidance rather than fail to mount.
 *
 * @param ctx - host context.
 */
export function registerDeployWorkflow(ctx: Context): void {
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: WORKFLOW_SECTION_NAME,
      order: WORKFLOW_SECTION_ORDER,
      // Prose, not a template. An unknown `{{` in a section's text makes
      // assembly throw inside the agent step, where nothing catches it.
      interpolate: false,
      // Assembled per render: a narrowed toolset keeps the guidance for the
      // tools it still has, rather than losing all of it. The rendering scope
      // is passed through because a tool restricted away for *this* agent is
      // exactly the case this lookup exists to see — an unscoped one would
      // still find the global registration and describe a call that is not
      // available.
      text: ({ scope: renderScope }) =>
        buildDeployWorkflow(
          name => ctx.tools.get(name, renderScope) !== undefined,
        ),
    })
  })
}