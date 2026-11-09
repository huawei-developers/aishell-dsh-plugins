/**
 * Reading `terraform show -json` into the changes a person has to approve.
 *
 * ## Why this is not the raw plan
 *
 * A plan for a small deployment is a few kilobytes; one for a real network runs
 * to megabytes, and almost all of it is provider defaults for attributes nobody
 * asked about. Handing that to the model spends its context on values the user
 * never chose, and buries the handful that matter — which resource is created,
 * replaced or destroyed.
 *
 * So the plan is read into the two things an approval turns on:
 *
 *   - **What happens to each resource** — create, update, replace, destroy —
 *     keyed by its terraform address.
 *   - **Which attributes change** — the names only, for an update. The values
 *     are in the plan; a reader who needs them can look, and a model that gets
 *     the names knows where to look.
 *
 * ## Why replacement is its own action
 *
 * `actions: ["delete", "create"]` means terraform will DESTROY and rebuild the
 * resource. Reported as "update" — which is what a reader who only saw "something
 * changes" would conclude — it hides the one fact that matters: the data on that
 * volume or database is going away. Terraform marks it; this module keeps that
 * mark.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/plan
 */

/** What terraform will do to one resource. */
export type ChangeAction = 'create' | 'update' | 'replace' | 'destroy' | 'read' | 'no-op'

/** One resource's entry in the plan. */
export interface PlannedResource {
  /** The terraform address, e.g. `huaweicloud_compute_instance.web`. */
  readonly address: string
  readonly action: ChangeAction
  /**
   * What forces a replacement, when there is one — terraform attributes the
   * delete to specific arguments (`~ image_id`, `-/+ force_new`). Empty for
   * anything but a replace.
   */
  readonly replacedBecause: readonly string[]
  /** Attribute names that change, for an update. Empty otherwise. */
  readonly changes: readonly string[]
}

/** The plan, reduced to what approval needs. */
export interface PlanSummary {
  readonly counts: { readonly create: number, readonly change: number, readonly destroy: number }
  /** Every resource the plan touches, in the order terraform listed them. */
  readonly resources: readonly PlannedResource[]
  /** Terraform's own output changes, by name. */
  readonly outputs: readonly { readonly name: string, readonly action: ChangeAction }[]
}

/**
 * Read a plan into its summary.
 *
 * @param planJson - the parsed `terraform show -json` document.
 * @returns the summary, or `undefined` when the document is not a plan.
 */
export function summarizePlan(planJson: unknown): PlanSummary | undefined {
  if (planJson === null || typeof planJson !== 'object') return undefined
  const document = planJson as {
    resource_changes?: unknown
    output_changes?: unknown
  }
  if (!Array.isArray(document.resource_changes)) return undefined

  const resources: PlannedResource[] = []
  const counts = { create: 0, change: 0, destroy: 0 }

  for (const raw of document.resource_changes) {
    const entry = readResourceChange(raw)
    if (entry === undefined) continue
    resources.push(entry)
    // Terraform's own summary counts a replace as one destroy and one create;
    // counted the same way here so the numbers agree with its output.
    if (entry.action === 'create') counts.create += 1
    else if (entry.action === 'replace') {
      counts.destroy += 1
      counts.create += 1
    } else if (entry.action === 'destroy') counts.destroy += 1
    else if (entry.action === 'update') counts.change += 1
  }

  const outputs = readOutputChanges(document.output_changes)
  return { counts, resources, outputs }
}

/**
 * One `resource_changes` entry.
 *
 * @param raw - the entry as terraform wrote it.
 * @returns the reduced entry, or `undefined` when it is not one.
 */
function readResourceChange(raw: unknown): PlannedResource | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = raw as {
    address?: unknown
    change?: {
      actions?: unknown
      replace_paths?: unknown
    }
    // Terraform explains WHAT forces a replacement through this field on the
    // resource, not the change, in some versions; both are read.
    action_reason?: unknown
  }
  if (typeof entry.address !== 'string') return undefined
  const actions = Array.isArray(entry.change?.actions) ? entry.change.actions : []
  const action = actionOf(actions)
  if (action === undefined) return undefined

  const replacedBecause = action === 'replace'
    ? readReplacePaths(entry.change?.replace_paths)
    : []
  const changes = action === 'update' || action === 'replace'
    ? readChangedAttributes(raw)
    : []

  return { address: entry.address, action, replacedBecause, changes }
}

/**
 * The action a list of terraform verbs denotes.
 *
 * @param actions - e.g. `["create"]`, `["delete", "create"]`, `["no-op"]`.
 * @returns the action, or `undefined` for a list this module does not model.
 */
function actionOf(actions: readonly unknown[]): ChangeAction | undefined {
  const verbs = actions.filter((verb): verb is string => typeof verb === 'string')
  if (verbs.length === 0) return undefined
  if (verbs.includes('create') && verbs.includes('delete')) return 'replace'
  const [first] = verbs
  switch (first) {
    case 'create':
      return 'create'
    case 'update':
      return 'update'
    case 'delete':
      return 'destroy'
    case 'read':
      return 'read'
    case 'no-op':
      return 'no-op'
    default:
      return undefined
  }
}

/**
 * The attribute paths that force a replacement.
 *
 * Terraform writes them as arrays of path components (`["image_id"]`, or
 * `["network", 0, "uuid"]`), one entry per forcing attribute. They are joined
 * into a readable path so a finding can name what to change to avoid the
 * rebuild.
 *
 * @param replacePaths - the field as terraform wrote it.
 * @returns the paths, as readable strings.
 */
function readReplacePaths(replacePaths: unknown): string[] {
  if (!Array.isArray(replacePaths)) return []
  const paths: string[] = []
  for (const path of replacePaths) {
    if (!Array.isArray(path)) continue
    const parts = path.map(part => (typeof part === 'string' || typeof part === 'number' ? String(part) : ''))
    const joined = parts.filter(part => part !== '').join('.')
    if (joined !== '') paths.push(joined)
  }
  return paths
}

/**
 * The attribute names an update touches.
 *
 * Only the top-level names: a change to `network.0.uuid` is reported as
 * `network`, because that is the argument a reader edits. Descending into
 * every nested path would reproduce the plan one level down.
 *
 * @param raw - the `resource_changes` entry.
 * @returns the names, deduplicated.
 */
function readChangedAttributes(raw: unknown): string[] {
  const entry = raw as { change?: { before?: unknown, after?: unknown } }
  const before = entry.change?.before
  const after = entry.change?.after
  if (before === null || typeof before !== 'object') return []
  if (after === null || typeof after !== 'object') return []
  const names = new Set<string>()
  const fields = new Set([
    ...Object.keys(before as Record<string, unknown>),
    ...Object.keys(after as Record<string, unknown>),
  ])
  for (const name of fields) {
    const was = (before as Record<string, unknown>)[name]
    const is = (after as Record<string, unknown>)[name]
    if (JSON.stringify(was) !== JSON.stringify(is)) names.add(name)
  }
  return [...names].sort()
}

/**
 * The output changes a plan would make.
 *
 * @param raw - the `output_changes` field.
 * @returns one entry per output, in terraform's order.
 */
function readOutputChanges(raw: unknown): { readonly name: string, readonly action: ChangeAction }[] {
  if (raw === null || typeof raw !== 'object') return []
  const outputs: { name: string, action: ChangeAction }[] = []
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const actions = (value as { actions?: unknown }).actions
    if (!Array.isArray(actions)) continue
    const action = actionOf(actions)
    if (action === undefined) continue
    outputs.push({ name, action })
  }
  return outputs
}