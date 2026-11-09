/**
 * Security-group rule extraction from plan or state JSON.
 *
 * After terraform_plan / terraform_state, the tool extracts all
 * secgroup rules from the structured JSON output and surfaces them as a
 * flat list — pulling rules buried deep in the plan to the top for human
 * review. No "reasonableness" judgment (that needs AI); just formatting.
 *
 * The provider spells ports two ways, and both appear in real plans:
 *   - `ports` (string, e.g. "80,443") — networking_secgroup_rule
 *   - `port_range_min`/`port_range_max` (numbers) — vpc_secgroup_rule
 * Extraction prefers `ports`, falls back to the range.
 */

export interface SecgroupRuleView {
  address: string; // e.g. huaweicloud_networking_secgroup_rule.ssh
  rule_local_name: string; // the rule's local name (e.g. "ssh"), extracted from address
  direction: string;
  protocol: string;
  ports: string;
  source: string; // remote_ip_prefix — same field for ingress/egress
}

interface PlanResource {
  address: string;
  type: string;
  /** Field values — present in both planned_values (plan) and values (state). */
  values?: Record<string, unknown>;
}

interface PlanModule {
  resources?: PlanResource[];
  child_modules?: PlanModule[];
}

interface PlanJson {
  planned_values?: { root_module?: PlanModule };
  values?: { root_module?: PlanModule };
}

/**
 * Extract secgroup rules from a `terraform show -json` plan or state output.
 *
 * The argument is `unknown` because both callers hold a value they have only
 * `JSON.parse`d. Declaring the expected shape instead would force each of them
 * to cast — `as never`, which compiles only because it is assignable to
 * everything, so it disables the check exactly where it matters. Narrowing here
 * keeps that boundary in one place, where the field names are known and a
 * mismatch reads as "no rules" rather than as a crash.
 *
 * @param planOrStateJson - the parsed document, of unverified shape.
 * @returns the rules found, empty when the document does not carry any.
 */
export function extractSecurityGroups(planOrStateJson: unknown): SecgroupRuleView[] {
  if (planOrStateJson === null || typeof planOrStateJson !== 'object') return []
  const document = planOrStateJson as PlanJson
  const root = isObject(document.planned_values)
    ? (document.planned_values as { root_module?: PlanModule }).root_module
    : isObject(document.values)
      ? (document.values as { root_module?: PlanModule }).root_module
      : undefined

  const rules: SecgroupRuleView[] = [];
  for (const res of resourcesIn(root)) {
    if (!res.type.endsWith("_secgroup_rule") && !res.type.endsWith("_security_group_rule")) {
      continue;
    }
    const vals = res.values ?? {};
    // Prefer `ports`; fall back to the numeric range.
    const ports = portsToString(vals);
    rules.push({
      address: res.address,
      rule_local_name: extractRuleLocalName(res.address),
      direction: String(vals["direction"] ?? ""),
      protocol: String(vals["protocol"] ?? ""),
      ports,
      source: String(vals["remote_ip_prefix"] ?? ""),
    });
  }
  return rules;
}

/** Whether a value is a non-null object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Every resource in a module tree, depth first.
 *
 * A module's resources live under its `child_modules`, not beside it, so a
 * read of `root_module.resources` alone returns nothing for a deployment that
 * puts its network in a module — and an empty rule list reads as "there are no
 * rules", which is the opposite of the truth. The walk is depth first so the
 * order matches the module tree a reader would walk by hand.
 *
 * @param module - one module node, or `undefined` when there is no state.
 * @returns its resources and its descendants', in tree order.
 */
function resourcesIn(module: PlanModule | undefined): PlanResource[] {
  if (module === undefined) return [];
  const own = module.resources ?? [];
  const descendants = (module.child_modules ?? []).flatMap(resourcesIn);
  return [...own, ...descendants];
}

/** Render ports: prefer `ports` string, else `port_range_min..port_range_max`. */
function portsToString(vals: Record<string, unknown>): string {
  const p = vals["ports"];
  if (typeof p === "string" && p !== "") return p;
  const min = vals["port_range_min"];
  const max = vals["port_range_max"];
  if (typeof min === "number" && typeof max === "number") {
    return min === max ? String(min) : `${min}..${max}`;
  }
  return "";
}

/**
 * Extract the rule's local name from its address.
 * e.g. huaweicloud_networking_secgroup_rule.ssh → "ssh"
 *
 * Plan-time security_group_id is "known after apply" — we CANNOT reliably
 * correlate a rule to its owning secgroup from the plan JSON. So we surface
 * only the rule's local name as a label, not a secgroup resource address.
 */
function extractRuleLocalName(ruleAddress: string): string {
  const dotIdx = ruleAddress.indexOf(".");
  if (dotIdx < 0) return ruleAddress;
  return ruleAddress.slice(dotIdx + 1);
}
