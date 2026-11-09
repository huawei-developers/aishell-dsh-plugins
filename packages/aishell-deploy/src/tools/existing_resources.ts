import type { CallToolResult, ToolRegistrar } from "../types.js";
import { z } from "zod";

import { fail, guard, okJson } from "./errors.js";
import { queryBalanceSummary } from "./balance_summary.js";
import { signedHttp } from "../auth-http.js";
import { READ_ONLY_CLOUD } from "./annotations.js";
import { loadAccount } from "../credentials.js"
import { subnetsInRegion } from "../inventory-subnets.js";

/**
 * list_existing_resources.
 *
 * Lists HuaweiCloud resources the user already owns, for reuse in a deployment.
 * Two-stage query against RMS (Resource Management Service) — the unified
 * inventory API that covers ALL services (ECS, RDS, EIP, VPC, ELB, ...):
 *
 *   Stage 1 (default, no service/region/detail args): CollectAllResourcesSummary.
 *     Returns a lightweight grouped count: provider → type → region → count.
 *     Cross-region by default — the user sees where resources live before
 *     drilling in. Cheap call, small response, ideal for the "what do I have?"
 *     first question.
 *
 *   Stage 2 (service, region, or detail=true): ListAllResources. Returns the
 *     actual resource list (id/name/provider/type/region/status/properties).
 *     Service + region narrow the query. Use after the summary tells you which
 *     service/region to drill into — avoids pulling a large list blindly.
 *
 * Also returns balance_summary (BSS balances + coupons) for the full cost
 * context at the reuse/budget decision point. Balance is best-effort.
 *
 * Verified: both RMS APIs accept AK/SK signing (despite swagger
 * marking PkiTokenAuth) and return 200. domain_id in the path IS the
 * account_id (resolved at auth, stored alongside credentials). RMS host is
 * global (rms.myhuaweicloud.com, no region prefix).
 */
export function registerExistingResourcesTool(registrar: ToolRegistrar): void {
  registrar.registerTool(
    "list_existing_resources",
    {
      title: "List existing cloud resources",
      description:
        "List HuaweiCloud resources the user already owns (for reuse in a " +
        "deployment) via RMS (Resource Management Service). Two stages: " +
        "by default returns a SUMMARY (provider→type→region→count, cheap, " +
        "cross-region) so you see what exists before drilling in. Pass " +
        "service, region, or detail=true to get the full resource list " +
        "(id/name/properties — use after the summary to narrow down). Detail " +
        "mode is paginated: if the response has next_marker, pass it back as " +
        "marker to fetch the next page. Also returns balance_summary " +
        "(balances + coupons). What the account already has decides what a design can " +
        "reuse and what it must not collide with, and nothing in a configuration can " +
        "tell you that. Reuse eligibility is a judgment call, " +
        "not decided here. " +
        "NOTE: RMS data may lag — resources recently created or destroyed may " +
        "not reflect immediately. When timing matters (e.g. verifying cleanup " +
        "after destroy), be aware this data source is not real-time.",
      annotations: READ_ONLY_CLOUD,
      inputSchema: z.object({
        service: z.string().optional().describe('Filter by RMS provider in detail mode: "vpc"|"ecs"|"rds"|"elb"|...'),
        region: z.string().optional().describe("Filter by region in detail mode. If omitted, details span all regions."),
        detail: z.boolean().optional().describe("Force detail mode (full resource list) even without service/region. Default: summary mode."),
        limit: z.number().int().min(1).max(200).optional().describe("Page size in detail mode (default 100, max 200). Ignored in summary mode."),
        marker: z.string().optional().describe("Pagination cursor from a previous detail-mode response's next_marker. Fetches the next page."),
      }),
    },
    guard(async (args) =>
      handleListExistingResources(args.service, args.region, args.detail, args.limit, args.marker),
    ),
  );
}

interface RmsSummaryEntry {
  provider: string;
  types: Array<{
    type: string;
    regions: Array<{ region_id: string; count: number }>;
  }>;
}

interface RmsResource {
  id: string;
  name: string;
  provider: string;
  type: string;
  region_id: string;
  project_id: string;
  project_name: string;
  ep_id: string;
  ep_name: string;
  created: string;
  updated: string;
  provisioning_state: string;
  tags: Record<string, unknown>;
  properties: Record<string, unknown>;
}

interface RmsListResponse {
  resources: RmsResource[];
  page_info?: { next_marker?: string; current_count?: number };
}

/**
 * Resolve the account_id (== RMS domain_id) for the RMS path param.
 * Credentials for signing are loaded separately by signedHttp at call time.
 *
 * @throws when the identity cannot be had. A rejected credential is the
 *   person's to fix, so it is named that way; a failure to *reach* IAM
 *   propagates from `loadAccount` with its own message rather than being
 *   restated here as a credential problem.
 */
async function resolveDomainId(): Promise<string> {
  const account = await loadAccount();
  if (account?.account_id) return account.account_id;
  // `undefined` means IAM rejected the credentials — a transient failure
  // throws instead, so this message is only ever about the credential.
  throw new Error(
    "The stored credentials were rejected by IAM, so account_id is not available. "
    + "Re-authenticate, then retry.",
  );
}

async function handleListExistingResources(
  serviceFilter?: string,
  regionFilter?: string,
  detail?: boolean,
  limit = 100,
  marker?: string,
): Promise<CallToolResult> {
  let domainId: string;
  try {
    domainId = await resolveDomainId();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  // Credentials: loadCredentials reads the plugin store per call
  // call — if account resolved, credentials resolved too. If signing fails
  // later, signedHttp throws a clear error; no need to pre-check here.

  // Stage selection: detail mode if explicitly requested OR a filter is given
  // (service/region imply "drill in"). Default (no args) → summary.
  const wantDetail = detail === true || serviceFilter !== undefined || regionFilter !== undefined;

  // Best-effort balance summary — independent of stage, always useful at the
  // reuse/budget decision point.
  let balanceSummary = null;
  try {
    balanceSummary = await queryBalanceSummary();
  } catch {
    // BSS unreachable — balance stays null, resources still useful.
  }

  if (!wantDetail) {
    return await summaryStage(domainId, balanceSummary);
  }
  return await detailStage(domainId, serviceFilter, regionFilter, limit, marker, balanceSummary);
}

/** Stage 1: CollectAllResourcesSummary — grouped counts, cross-region. */
async function summaryStage(
  domainId: string,
  balanceSummary: Awaited<ReturnType<typeof queryBalanceSummary>> | null,
): Promise<CallToolResult> {
  const url = new URL(`https://rms.myhuaweicloud.com/v1/resource-manager/domains/${domainId}/all-resources/summary`);
  try {
    const resp = await signedHttp("GET", url, "");
    if (resp.status !== 200) {
      return fail(`RMS summary failed (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`);
    }
    const entries = JSON.parse(resp.body) as RmsSummaryEntry[];
    // Reshape into a compact form: provider → [{type, total, regions:[{region,count}]}]
    const summary = entries.map((e) => ({
      provider: e.provider,
      types: e.types.map((t) => ({
        type: t.type,
        total: t.regions.reduce((sum, r) => sum + r.count, 0),
        regions: t.regions.map((r) => ({ region: r.region_id, count: r.count })),
      })),
    }));
    const totalResources = summary.reduce(
      (sum, p) => sum + p.types.reduce((s, t) => s + t.total, 0),
      0,
    );
    return okJson({
        mode: "summary",
        providers: summary,
        total_resources: totalResources,
        hint: "Pass service, region, or detail=true to list specific resources.",
        balance_summary: balanceSummary,
      });
  } catch (err) {
    return fail(`RMS summary failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Stage 2: ListAllResources — one page of the resource list.
 *
 * Pagination is caller-controlled: the caller passes
 * `marker` from a previous response's `next_marker` to fetch the next page.
 * This tool does NOT auto-paginate or truncate — that would either hide
 * resources behind a cap (deployment-decision bug) or fetch unboundedly
 * (slow, large response). The caller decides whether to keep paging.
 *
 * service filter is client-side (RMS v1 `type` param requires "provider.type"
 * format, no provider-only filter). When a service filter is given WITHOUT a
 * region filter, RMS returns mixed-service pages that may contain zero
 * matching resources — the caller would see `count: 0, has_more: true` and
 * waste turns paging through empty pages. To avoid this, the tool
 * auto-advances through empty pages (up to MAX_AUTO_PAGES) when filtering by
 * service without region, collecting matching resources until the page has
 * results or RMS is exhausted.
 */
const MAX_AUTO_PAGES = 10;

async function detailStage(
  domainId: string,
  serviceFilter: string | undefined,
  regionFilter: string | undefined,
  limit: number,
  marker: string | undefined,
  balanceSummary: Awaited<ReturnType<typeof queryBalanceSummary>> | null,
): Promise<CallToolResult> {
  // When filtering by service without region, auto-advance through empty
  // pages. With a region filter (or no service filter), return the page as-is
  // — the density is high enough that empty pages are rare.
  const autoAdvance = Boolean(serviceFilter) && !regionFilter;

  let collected: RmsResource[] = [];
  let nextMarker = marker;
  let pagesFetched = 0;
  let exhausted = false;

  try {
    do {
      const url = new URL(`https://rms.myhuaweicloud.com/v1/resource-manager/domains/${domainId}/all-resources`);
      url.searchParams.set("limit", String(limit));
      if (regionFilter) url.searchParams.set("region_id", regionFilter);
      if (nextMarker) url.searchParams.set("marker", nextMarker);

      const resp = await signedHttp("GET", url, "");
      if (resp.status !== 200) {
        return fail(`RMS list failed (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`);
      }
      const data = JSON.parse(resp.body) as RmsListResponse;
      const pageResources = data.resources ?? [];
      nextMarker = data.page_info?.next_marker;
      pagesFetched++;

      const matching = serviceFilter
        ? pageResources.filter((r) => r.provider === serviceFilter)
        : pageResources;
      collected.push(...matching);

      // Stop if: no more pages, or we have results (auto-advance only seeks
      // past empty pages, not past pages with matches).
      if (!nextMarker) { exhausted = true; break; }
      if (!autoAdvance || matching.length > 0) break;
    } while (autoAdvance && pagesFetched < MAX_AUTO_PAGES);
  } catch (err) {
    return fail(`RMS list failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Normalize: flatten RMS fields. properties is passed through raw — it's
  // service-specific (ECS has flavor/vpc/subnet, VPC has cidr, EIP has
  // public_ip, etc.). LLM reads properties to judge reuse eligibility — we
  // don't over-normalize and lose info.
  //
  // `provider` and `type` are emitted exactly as RMS reported them. They are
  // NOT translated into terraform types: RMS says `securityGroups`, terraform
  // says `huaweicloud_networking_secgroup`, and any bridge between the two is a
  // vocabulary table. Reporting the raw pair keeps this tool a window onto the
  // account rather than a second opinion about it; a consumer that needs the
  // terraform name resolves it where the design vocabulary lives.
  const normalized = collected.map((r) => ({
    id: r.id,
    name: r.name,
    provider: r.provider,
    type: r.type,
    region: r.region_id,
    project_id: r.project_id,
    enterprise_project: r.ep_name,
    status: r.provisioning_state,
    created: r.created,
    updated: r.updated,
    tags: r.tags,
    properties: r.properties,
  }));

  // Subnets, which RMS does not report.
  //
  // They are added on a `vpc` query because that is when the caller is building
  // a network picture, and a network picture is two levels: the network and its
  // subdivisions. Without them nothing can be placed in a subnet, and a server
  // ends up drawn inside its VPC with its subnet absent — see
  // `inventory-subnets.ts` for why this is the one gap worth filling and why
  // others are not.
  const subnets: Awaited<ReturnType<typeof subnetsInRegion>> =
    { subnets: [] };
  if (serviceFilter === 'vpc') {
    const regions = regionFilter !== undefined
      ? [regionFilter]
      : [...new Set(collected.filter(r => r.type === 'vpcs').map(r => r.region_id))]
    const failures: string[] = [];
    for (const listed of await listSubnets(regions)) {
      subnets.subnets.push(...listed.subnets);
      if (listed.failure !== undefined) failures.push(listed.failure);
    }
    if (failures.length > 0) {
      // Reported, not fatal: the rest of the inventory is still usable, and a
      // caller who wants the subnets needs to know they are not in it.
      process.stderr.write(`list_existing_resources: ${failures.join('; ')}\n`);
    }
  }

  const hitAutoPageLimit = autoAdvance && pagesFetched >= MAX_AUTO_PAGES && !exhausted;
  return okJson({
      mode: "detail",
      resources: [...normalized, ...subnets.subnets],
      count: normalized.length + subnets.subnets.length,
      region: regionFilter ?? "(all regions)",
      ...(serviceFilter ? { service_filter: serviceFilter } : {}),
      ...(subnets.subnets.length > 0
        ? {
            subnet_note:
              `${subnets.subnets.length} subnet(s) were added to this page from the VPC API; `
              + 'RMS does not report them. They are listed with provider "vpc" and type '
              + '"subnets", the same shape as the rest, and carry `vpc_id` in properties, '
              + 'which is what places them inside their VPC.',
          }
        : {}),
      ...(nextMarker && !exhausted ? {
        next_marker: nextMarker,
        has_more: true,
        ...(autoAdvance ? { note: `auto-skipped ${pagesFetched} empty page(s); pass next_marker as marker to continue` } : { note: "pass next_marker as marker to fetch the next page" }),
      } : { has_more: false }),
      ...(hitAutoPageLimit ? { warning: `stopped after ${MAX_AUTO_PAGES} pages — narrow with region to reduce scope` } : {}),
      balance_summary: balanceSummary,
    });
}

/**
 * Read the subnets of several regions, sequentially.
 *
 * Sequential rather than concurrent for the same reason the catalogue lookup
 * is: these are a handful of calls against the same signed client, and flooding
 * one host buys nothing a short wait does not.
 *
 * @param regions - the regions to list.
 * @returns one result per region, each carrying its own failure if it has one.
 */
async function listSubnets(
  regions: readonly string[],
): Promise<Awaited<ReturnType<typeof subnetsInRegion>>[]> {
  const results: Awaited<ReturnType<typeof subnetsInRegion>>[] = [];
  for (const region of regions) results.push(await subnetsInRegion(region));
  return results;
}
