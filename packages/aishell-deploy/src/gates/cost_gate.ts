/**
 * The gate `terraform_apply` runs on the cost record.
 *
 * ## Two questions, both about the record's honesty
 *
 * **Was anything priced?** `cost.json` exists and carries either a quote or a
 * statement that the plan holds nothing to charge for. A deployment with
 * neither has no approved cost, and applying it spends money nobody agreed to.
 *
 * An empty quote list alone is not an answer: a network of VPCs, subnets and
 * security groups has no items and costs nothing, while a deployment of
 * unpriced databases has no items and costs something nobody established. The
 * record's `nothing_billable` flag is what separates them.
 *
 * **Is the record current?** The record stores the digest of the configuration
 * it was priced against. This gate recomputes that digest from the files on
 * disk and refuses when they differ. A price is a property of the
 * configuration: edit a flavour, an image or a resource count and the old total
 * describes something that will not be built.
 *
 * ## What the record is now
 *
 * `cost.json` is written by `price_resources` from the BSS rating API, so every
 * figure in it came from an inquiry. It is not a form the model fills in — the
 * tool that writes it is the only writer, which is why there is no separate
 * "did you cost it" step to enforce. This gate guards the two ways a correct
 * record can still be wrong at apply time: absent, and stale.
 *
 * ## Why it does not re-price
 *
 * Re-pricing here would make apply depend on a live billing call — a rate limit
 * or a catalogue hiccup would block a deployment that was fully reviewed five
 * minutes earlier. The digest answers "was this configuration priced", which is
 * the question that matters; a price that has moved since is a difference the
 * user accepted when they approved that number.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/gates/cost_gate
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { computeTfHash } from '../utils/hash.ts'

/** The file `price_resources` writes. */
const COST_FILE = 'cost.json'

/**
 * The cost record, as `price_resources` writes it.
 *
 * Only the fields the gate reads are named. The rest of the file is the record
 * of the quotes themselves, and typing all of it here would mean this module
 * knows the billing model — which it deliberately does not.
 */
interface CostRecord {
  readonly priced_at?: unknown
  readonly tf_hash?: unknown
  readonly total_monthly?: unknown
  readonly items?: unknown
  /**
   * Set by `price_resources` when the plan holds nothing that carries a charge
   * of its own — a network of VPCs, subnets and security groups.
   *
   * Without it the record is indistinguishable from "everything was unpriced",
   * because both have no items. That distinction decides whether an empty
   * record is an approval or a gap, so the writer states which one it is rather
   * than leaving the gate to infer it from an absence.
   */
  readonly nothing_billable?: unknown
}

/**
 * Read the cost record, or say why it is not usable.
 *
 * @param dir - the deployment workspace directory.
 * @returns the record, or a message naming the remedy.
 */
async function readCostRecord(dir: string): Promise<CostRecord> {
  let raw: string
  try {
    raw = await readFile(join(dir, COST_FILE), 'utf8')
  } catch {
    throw new Error(
      `no ${COST_FILE} in this deployment. Call price_resources — it reads the .tf and quotes `
      + 'each priceable resource against this account\'s own on-demand prices. Applying '
      + 'without a quote spends money nobody approved.',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `${COST_FILE} is not valid JSON, so the recorded cost cannot be read. `
      + 'Call price_resources again; it rewrites the file from a fresh inquiry.',
    )
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(
      `${COST_FILE} does not hold a cost record. Call price_resources to write one.`,
    )
  }
  return parsed as CostRecord
}

/**
 * Refuse an apply whose cost record is absent, empty, or stale.
 *
 * @param dir - the deployment workspace directory.
 * @throws when the record is unusable.
 */
export async function runCostGate(
  dir: string,
  hashConfiguration: (directory: string) => Promise<string> = computeTfHash,
): Promise<void> {
  const record = await readCostRecord(dir)

  const items = Array.isArray(record.items) ? record.items : []
  if (items.length === 0 && record.nothing_billable !== true) {
    throw new Error(
      `${COST_FILE} records no priced resource. price_resources found nothing it could quote `
      + '— check the unpriced entries it reported and give those resources concrete specs, '
      + 'or remove them from the configuration. An empty cost is not an approved one.',
    )
  }

  if (record.priced_at === undefined) {
    throw new Error(
      `${COST_FILE} carries no inquiry timestamp, so there is no telling when its figures were `
      + 'true. Call price_resources to record a dated quote.',
    )
  }

  const recorded = typeof record.tf_hash === 'string' ? record.tf_hash : undefined
  if (recorded === undefined) {
    // The record is one `price_resources` writes, and it always writes the
    // digest. A file without one was not produced here — hand-edited, truncated,
    // or copied from elsewhere — so it names no configuration this gate can
    // check. The remedy is the same either way: quote again.
    throw new Error(
      `${COST_FILE} does not record which configuration it priced. Call price_resources to `
      + 're-quote the current .tf.',
    )
  }

  const current = await hashConfiguration(dir)
  if (current !== recorded) {
    throw new Error(
      'the .tf files changed after they were priced. The recorded total describes a '
      + 'configuration that will not be built. Call price_resources again and show the user '
      + 'the new figure before applying.',
    )
  }
}
