# @huaweidevtools/aishell-dsh-deploy

Huawei Cloud infrastructure tools for DSH. The agent can design a deployment,
price it, write the Terraform, and run it — with a read-only switch and a
credential model that neither the model nor a tool call can bypass.

## What you get

tools registered as `aishell__<name>`:

| Group | Tools | What they do |
|---|---|---|
| Deployment workspace | `create_deployment`, `delete_deployment` | Create or remove a workspace directory; deletion is refused while cloud resources are recorded |
| Design | `validate_design` | Check the network design in the `.tf` files and draw it. Runs `terraform validate` when the provider is installed, then reports what terraform cannot — overlapping subnets, a subnet outside its VPC, a gateway outside its subnet, rules open to the world — and writes `topology.svg`. Accepts the account's existing resources so the picture shows what is already deployed, and so a new subnet is checked against a deployed one. |
| Specs | `lookup_specs` | The flavours and images the region sells in one zone, and a check of every `flavor_id`/`image_id` a design names — including RDS specs, checked against the zones that actually carry them. `terraform validate` accepts any string there |
| Cost | `price_resources` | Read the SAVED PLAN and quote each priceable resource against this account's own on-demand prices via the BSS rating API, then write `cost.json`. The plan, not the `.tf`: `count = 3` is three instances, `for_each` one per key, a module's resources visible. Prices compute instances (Linux and Windows bill separately, from the image), RDS instances, DCS instances, EVS volumes and DMS instances. The usage unit the API needs is learned from its own correction rather than tabulated. A resource it cannot identify is reported as unpriced, never estimated |
| Huawei Cloud | `apiexplorer`, `openapi_request`, `list_existing_resources`, `terraform_examples_export` | Look up API definitions, call any signed API, inventory what already exists, export `.tf` examples |
| Terraform | `provider_schema`, `terraform_install`, `terraform_init`, `terraform_plan`, `terraform_apply`, `terraform_destroy`, `terraform_refresh`, `terraform_state`, `terraform_import` | The full lifecycle. `terraform_plan` computes the change and saves it (or, with `destroy: true`, previews the destruction); `terraform_apply` runs THAT saved plan rather than re-planning, so what executes is what was shown. Design, cost and plan are each gated by a digest of the configuration |

`auth` is not here. It lives in `aishell-credentials`, which owns the AK/SK form
and the store, and registers `aishell__auth` to verify the stored pair and
report the account and its projects.

The prefix exists because this plugin is not the only source of cloud tools in a
deployment. A bare `terraform_apply` in a shared namespace is one collision away
from calling someone else's tool.

## How it fits together

```
apply()
  → opens one credentials store (the aishell-dsh-plugins keyring this whole set shares)
  → registers the 18 tools on ctx.tools
  → registers one Host route for the permission switch
```

A tool call runs in this process. There is no child process, no transport, and
no second credential store — so a credential rotated in the form applies to the
very next call, and a cleared one stops working immediately.

## Credentials

Nothing is collected through a tool call. `aishell-credentials` owns the AK/SK,
the form that collects them, and the store; this plugin only reads, through
`credentials-store/accounts` — the same account names and pairing rule
`aishell-llm` and `aishell-e2b` use.

Mounted without that package, the tools still register, and every call fails
with "not authenticated" until credentials exist in the store. There is nothing
to reload and nothing to restart.

## Read-only mode

The switch is process state, read and written directly by
`api/aishell/permission`. A switch takes effect before the next tool call
starts, not after the one already running.

It is enforced in two places, because the tools reach the cloud two ways:

- **The signed-HTTP funnel.** Every API call goes through one client, so
  `openapi_request`'s arbitrary method and URL are covered without each tool
  having to remember to ask. `GET` and `HEAD` are queries; anything else is
  looked up in a table of known read operations, and an unknown one is denied.
- **The tool registry.** `terraform_apply` and `terraform_destroy` never touch
  the HTTP client, so they are refused by name.

The mode is out-of-band: it appears in no tool description, no tool result, and
nothing in the model's context can change it. While read-only, the model gets a
prompt context explaining the posture, so it works as a reviewer — producing the
plan and the exact commands — rather than stopping early.

## Config

| Field | Type | Default | Description |
|---|---|---|---|
| `defaultRegion` | `string?` | unset | A fallback for a plan that names no region, and the `HW_REGION_NAME` terraform runs under. Unset means each resource's provider block decides. |
| `toolCallTimeoutMs` | `number?` | 10 minutes | Per-call budget. A real `terraform_apply` runs for minutes, so the default is above that rather than the seconds a lookup tool would want. |

There is no built-in region. A region belongs to each resource, read from the
provider block its plan names, so a deployment-wide default would have to be
right for every resource at once — and setting one applies it to pricing as well
as to terraform, which is what keeps the two from disagreeing.

The region is not verified — see below.

### Why the region is not verified

IAM is a global service. The region in a verification URL only routes to a
regional replica; it does not scope the result. A wrong region still answers 200
with the same account, and the mismatch surfaces at the first region-scoped
call. Conflating the two would report "invalid credentials" for a typo'd region
setting and send the reader to check the wrong thing.

## The data files

Two artifacts ship beside the bundle and are read at call time:

| File | Source | In the repository? |
|---|---|---|
| `permission-registry.json` | Committed | yes |
| `terraform-examples.zip` | `pnpm run fetch-examples` | no |

- `permission-registry.json` — the table that decides whether an arbitrary URL
  is a query. Without it, read-only mode refuses every non-`GET`, which is the
  safe direction.
- `terraform-examples.zip` — the `examples/` tree of the official
  `terraform-provider-huaweicloud` repository, which
  `aishell__terraform_examples_export` unpacks for the model to read.

Both land in `lib/data/` at build time, which is where `src/data-paths.ts` looks.
They are deliberately not resolved from the working directory — a workspace file
must not be able to choose what this plugin considers read-only.

### Fetching the examples

The archive is derived from a public repository, so it is fetched rather than
committed: a committed copy looks current forever, and 1650 files nobody edits
would be rewritten by every refresh.

```sh
pnpm run fetch-examples
```

That clones only the provider's `examples/` directory — a blobless sparse
checkout — and packs it. It tries the GitCode mirror first and GitHub second;
the mirror exists because the primary host is often unreachable from mainland
networks.

Run it once after cloning, and again whenever the provider's examples should be
refreshed. `build:bundle` refuses to run without the archive and names this
command, so a missing file cannot produce a package that builds clean and fails
on its first call.

## Layout

```
src/
  index.ts               entry: tools, permission route, credential source
  bridge.ts              tool declaration → DSH tool definition
  types.ts               the tool ↔ harness contract
  credentials.ts         store read + account identity
  permission.ts          the wire vocabulary the browser sends
  permission/
    mode.ts              the switch
    gate.ts              enforcement
    registry.ts          the query table
  permission-route.ts    the Host route the chip calls
  permission-context.ts  the read-only prompt context
  hcl.ts                 reading the configuration
  topology.ts            the network as a tree
  network-checks.ts      what terraform validate cannot see
  d2-engine.ts           the D2 renderer: source in, SVG out
  d2-design.ts           drawing what a .tf declares
  d2-inventory.ts        drawing the account as it stands
  existing-topology.ts   the account's own graph shape
  catalog.ts             what the region sells: flavours, images, RDS specs
  rating-map.ts          terraform type → BSS service + spec/capacity attributes
  bss.ts                 the rating inquiry, including its usage-unit self-correction
  tools/pricing.ts       plan → quote → cost.json
  tools/                 the 18 tools
  existing.ts            cloud resources the design reuses
  gates/                 pre-run safety gates (design, cost, credential, env)
  schemas/               the cost schema
  auth-*.ts              request signing and the signed HTTP client
  utils/                 zip extraction, hashing
  data/                  shipped artifacts
  data-paths.ts          where those artifacts live at runtime
  version.ts             the version a deployment snapshot records
```

## Install

```sh
# Standalone: reads the store but has no form to write it,
# so mount aishell-credentials alongside.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-deploy

# Or the full set:
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-base
```

## License

Apache License 2.0.