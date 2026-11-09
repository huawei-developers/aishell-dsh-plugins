/**
 * Tool risk declarations — what each tool is allowed to do to the account.
 *
 * ## These are HINTS, not a security boundary
 *
 * They do not change what any tool does: every tool still runs through its
 * gates (`denyTerraformMutation`, `denyHttp`, the credential scanner, the
 * cost/tf_hash gate). A declaration only lets a surface describe a call before
 * it runs — "this one may destroy". A wrong `readOnlyHint: true` is therefore
 * the dangerous direction: it invites an unconfirmed call to something that
 * mutates.
 *
 * Nothing enforces these, so a wrong hint is not caught by anything — which is
 * why they are reviewed tool by tool rather than applied in bulk.
 *
 * ## Defaults (why an unset field is the *safe* default)
 *
 *   readOnlyHint   defaults false  → "assume it can modify things"
 *   destructiveHint defaults true  → "assume it may destroy"
 *   idempotentHint  defaults false → "assume a retry has an effect"
 *   openWorldHint   defaults true  → "assume it touches the outside world"
 *
 * Every field is still set explicitly: an implicit default and a deliberate
 * choice look identical to a reader, and this file is where the deliberate
 * choice is recorded.
 *
 * ## Semantics used here
 *
 * `readOnlyHint` = "does not modify **cloud** resources". This project's
 * meaningful line is whether a tool can create/change/delete a billable cloud
 * resource, not whether it writes a local file or syncs tfstate. So
 * `terraform_plan` / `terraform_refresh` / `terraform_import` are marked
 * read-only even though they write state — none of them touch cloud resources.
 * `openapi_request` is the exception that proves the rule: it can issue DELETE,
 * so it is NOT read-only. (`terraform_plan` writing state is a known grey area —
 * see the per-tool note.)
 *
 * `openWorldHint` = "interacts with an external system" (HuaweiCloud APIs, a
 * provider download). Pure local-filesystem tools are false.
 *
 * `destructiveHint` is only meaningful when `readOnlyHint` is false; it says
 * "may destroy/replace". Set alongside for each writable tool.
 */

import type { ToolAnnotations } from "../types.js";

/**
 * Reads HuaweiCloud / the local filesystem, changes nothing.
 * e.g. apiexplorer, list_existing_resources.
 */
export const READ_ONLY_CLOUD: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Reads only local state, no external system, changes nothing.
 * e.g. provider_schema, terraform_state.
 */
export const READ_ONLY_LOCAL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Writes files inside the deployment workspace only; creates nothing, destroys
 * nothing, no external system. Re-running with the same input converges.
 * e.g. create_deployment, validate_design, price_resources.
 */
export const LOCAL_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Removes local data and cannot be undone (delete_deployment `rm -rf`).
 * Re-running is safe (a second delete finds nothing) but the first is final.
 */
export const LOCAL_DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Writes remote state / downloads artifacts; does not create or destroy cloud
 * resources. e.g. terraform_init, terraform_install.
 */
export const CLOUD_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Creates, changes, or destroys cloud resources, and *converges* — a retry
 * with the same input is a no-op. e.g. terraform_apply (re-apply converges),
 * terraform_destroy (re-destroy finds nothing).
 */
export const CLOUD_DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * A raw API call whose effect depends on the argument: `openapi_request` is
 * safe as a GET and destructive as a DELETE.
 *
 * Tool-level annotations cannot vary by argument, so **every** field reflects
 * the worst case:
 *   - readOnlyHint false — it can DELETE. Marking it read-only would let a
 *     client skip confirmation for a call that destroys a resource, the exact
 *     failure this file exists to avoid.
 *   - idempotentHint false — it can POST, and a retried POST may create a
 *     second resource. (Not idempotent even though GET/HEAD are.)
 *   - destructiveHint true — a DELETE is never recoverable.
 *
 * The per-argument nuance cannot live in the annotation; it belongs in the
 * tool description and the gates above.
 */
export const CLOUD_MUTABLE_API: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};