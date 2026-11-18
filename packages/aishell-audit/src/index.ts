/**
 * Audit trail plugin.
 *
 * ## What this exists for
 *
 * Some actions are not conversation but still have to be answerable later: who
 * granted write access to a cloud account, when, and to which account. The
 * session log is the wrong place for them — it is a reconstruction record, and
 * an event type a reader does not recognize makes it refuse the session — so
 * they need a sink of their own.
 *
 * ## How another plugin uses it
 *
 * `ctx.audit.record(...)`. One call, no configuration, no import of this
 * package's internals: the interface is the service, so a plugin that wants to
 * be auditable depends on the service being present and not on how this plugin
 * writes anything.
 *
 * Where the record goes is this plugin's decision, and deliberately not the
 * caller's. A caller that had to choose a destination would be choosing a
 * policy, and two callers choosing differently is how one of them ends up
 * un-recorded.
 *
 * ## Why the sink is a file
 *
 * Cordis's logger writes only through registered exporters. The Host registers
 * one that keeps `warn` and `error` for startup diagnostics and discards the
 * rest, and nothing else is registered for an ordinary run — so a record logged
 * at `info` reaches no file, no stdout, and no collection. It is accepted and
 * dropped, which for an audit trail is the same as not recording.
 *
 * A file under `DSH_HOME` is the sink that actually exists: it is where this
 * plugin set already keeps state, it survives a restart, and whatever collects
 * logs on the machine can read it without the harness cooperating.
 *
 * ## Why the format is JSON lines
 *
 * One record is one line, and each line is a complete JSON object. The values
 * are supplied by callers, so the format has to carry anything they hold: a
 * newline in any value would split one record across two lines under a
 * delimiter-separated format, leaving a second line that is not a record at
 * all, and a key containing a space could not be split back from its value.
 * JSON escaping leaves both cases as ordinary data, so the file stays readable
 * by anything that can parse JSON, without a bespoke reader per field.
 *
 * The file has no retention policy of its own. Rotation is a decision about
 * which records to destroy, and that belongs to whatever collects the file, not
 * to the code writing it.
 *
 * @module @huaweidevtools/aishell-dsh-audit
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHome } from '@huaweidevtools/aishell-dsh-credentials-store/paths'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The audit surface, provided by this plugin.
     *
     * Declared non-optional, like every other Cordis service, because a
     * deployment that mounts this plugin always has it. A caller that must also
     * work where the plugin is absent reads it through `ctx.get('audit')`,
     * whose return type is `T | undefined` — the absence is handled at that
     * call site by the service lookup, not by widening the type here.
     */
    audit: AuditTrail
  }
}

/**
 * One auditable action.
 *
 * The shape is intentionally flat and JSON-serializable: an audit record is
 * read by people and tools that were not present when it was written, so it
 * carries its own values rather than references to state that may since have
 * changed.
 */
export interface AuditEvent {
  /**
   * What happened, as a stable dotted name: `<subsystem>.<action>`.
   *
   * Stable because it is what a query filters on. Changing one is a change to
   * every saved search that used it, so it names the action rather than the
   * implementation that performs it.
   */
  readonly action: string
  /**
   * The subject the action affected, when there is one — an account, a route,
   * a resource. Omitted rather than empty when the action has no subject.
   *
   * Must not carry a secret: this value is written to disk.
   */
  readonly subject?: string
  /** Whether the action granted or removed a capability, when it did. */
  readonly outcome?: 'granted' | 'revoked' | 'changed' | 'denied' | 'failed'
  /**
   * Who or what acted, when it is known: a person, a route, a policy.
   *
   * Omitted when the deployment cannot attribute the action; a fabricated
   * attribution is worse than an honest gap.
   */
  readonly actor?: string
  /** Free-form detail for this action. Values must be JSON-safe and non-secret. */
  readonly detail?: Readonly<Record<string, string | number | boolean | undefined>>
}

/** The audit surface. */
export interface AuditTrail {
  /**
   * Record one action.
   *
   * Never throws and never fails the action it describes: the action has
   * already happened by the time this is called, and reporting a failure here
   * would describe one that did not occur. A caller may therefore record
   * unconditionally.
   *
   * @param event - the action to record.
   */
  record(event: AuditEvent): void
}

/** Plugin name, used as the Loader row id. */
export const name = 'aishell-audit'

/** The file audit records are appended to, under the host's data directory. */
export const AUDIT_FILE_NAME = 'audit.jsonl'

/**
 * One record as the single line written to the log.
 *
 * Absent fields are written as `null` rather than omitted: a reader has to tell
 * "this action had no actor" from "the writer was an older version that did not
 * record actors", and a missing key cannot distinguish them.
 *
 * See the module header for why the line is JSON rather than delimited fields.
 *
 * @param event - the action to describe.
 * @param time - when it happened, epoch milliseconds.
 * @returns the line, without a trailing newline.
 */
export function formatAuditRecord(event: AuditEvent, time: number): string {
  return JSON.stringify({
    action: event.action,
    subject: event.subject ?? null,
    outcome: event.outcome ?? null,
    actor: event.actor ?? null,
    time: new Date(time).toISOString(),
    ...event.detail === undefined ? {} : { detail: event.detail },
  })
}

/** Where this plugin appends records. */
export interface AuditFileOptions {
  /** Override the data directory; the host's `DSH_HOME` by default. */
  readonly dir?: string
}

/**
 * The file a trail appends to.
 *
 * @param options - directory override, for a test.
 * @returns the resolved path.
 */
export function auditFilePath(options: AuditFileOptions = {}): string {
  return join(options.dir ?? dshHome(), AUDIT_FILE_NAME)
}

/**
 * Register the audit service.
 *
 * One file, appended to. See the module header for why it is a file, why the
 * format is JSON lines, and why it is not rotated.
 *
 * @param ctx - the plugin's context.
 * @param options - directory override, for a test.
 */
export function apply(ctx: Context, options: AuditFileOptions = {}): void {
  const log = ctx.logger('aishell-audit')
  const file = auditFilePath(options)

  // Reported once: an unwritable trail would otherwise fail on every record,
  // and a warning per record is one an operator learns to skip. Saying it once
  // is what keeps the condition visible without making it noise.
  let reported = false

  ctx.provide('audit', {
    record(event: AuditEvent): void {
      // Containment is part of the contract: `record` is documented never to
      // throw, so a caller can record after completing an action without having
      // to wrap the call.
      try {
        // `dirname` and not a separator search: this runs on Windows too, where
        // the separator is not `/`.
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, `${formatAuditRecord(event, Date.now())}\n`, { mode: 0o600 })
      } catch (error: unknown) {
        if (reported) return
        reported = true
        // `warn`, because the Host retains warnings and discards `info`: a
        // trail that cannot write is exactly the condition an operator has to
        // learn about.
        log.warn(`audit trail cannot write ${file}: ${String(error)}; records are being lost`)
      }
    },
  })
}
