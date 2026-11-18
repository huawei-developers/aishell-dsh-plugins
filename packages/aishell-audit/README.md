# @huaweidevtools/aishell-dsh-audit

Provides `ctx.audit`, the audit trail other aishell plugins record non-conversational
actions through. One host-only row: no browser half, no network access, no
credential.

## What belongs in an audit trail

Some things are not conversation but still have to be answerable later: who
granted write access to a cloud account, when, and to which account. The session
log cannot hold them. It is a reconstruction record, and a reader that meets an
event type it does not recognize refuses the session rather than resuming
something it cannot interpret — so a custom event type carrying audit data makes
a deployment without this plugin unable to open the sessions it wrote.

An audit record is also not conversation: its audience is an auditor reading
backwards, not a replay fold building forwards. The two have different
lifetimes, which is why they have different sinks.

## How another plugin uses it

```ts
ctx.inject(['audit'], (auditCtx) => {
  auditCtx.audit.record({
    action: 'permission.mode',
    outcome: 'granted',
    subject: 'prod-account(AKID****WXYZ)',
    actor: 'user',
    detail: { to: 'read_write' },
  })
})
```

`record` never throws and never fails the action it describes. The action has
already happened by the time it is called, so a failure here would report one
that did not occur; a caller may record unconditionally, after the fact, without
wrapping the call.

`ctx.inject` rather than `ctx.get` at mount when the caller is a separate row:
the bundle decides row order, and this plugin may load after the one recording.
`inject` runs the callback when the service exists, whenever that is, which
keeps the trail wired without making it a requirement — a deployment without
this plugin still runs its plugins, just without an audit trail.

## The record

| Field | Meaning |
|---|---|
| `action` | Stable dotted name, `<subsystem>.<action>`. It is what a query filters on, so it names the action rather than the implementation. |
| `subject` | What the action affected — an account, a route, a resource. Omitted when there is none. Must not carry a secret. |
| `outcome` | `granted`, `revoked`, `changed`, `denied`, or `failed`, when the action had a direction. |
| `actor` | Who acted, when the deployment can say. Omitted rather than guessed: a wrong attribution is worse than an absent one. |
| `detail` | Free-form, JSON-safe, non-secret. |
| `time` | Added by the trail at record time. |

Absent fields are written as `null`, so a reader can tell "this action had no
actor" from "the writer was an older version that did not record actors".

## Where records go

`$DSH_HOME/audit.jsonl`, one JSON object per line, appended with owner-only
permissions. The directory is created on demand.

A file rather than the Host logger, because the logger writes only through
registered exporters: the Host registers one that keeps `warn` and `error` for
startup diagnostics and discards the rest, so a record logged at `info` reaches
no file, no stdout, and no collection. It is accepted and dropped, which for an
audit trail is the same as not recording.

JSON lines rather than delimited fields, because a newline in any value would
split one record across two lines and leave a second line that is not a record
at all, and a key containing a space could not be split back from its value.
JSON escaping leaves both as ordinary data.

```json
{"action":"permission.mode","subject":"prod-account(AKID****WXYZ)","outcome":"granted","actor":"user","time":"2026-11-18T08:19:12.903Z","detail":{"to":"read_write"}}
```

The file has no retention policy of its own. Rotation is a decision about which
records to destroy, and that belongs to whatever collects the file, not to the
code writing it.

**A trail that cannot write reports itself once**, at `warn` — the level the Host
retains. It does not retry per record, and it does not fail the action. Records
lost after that point are lost silently, so a deployment that needs to know
should watch the file's modification time or its size, not the log.

## Install

```sh
# On its own.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-audit

# Or with the rest of the aishell plugin set.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-base
```

## What it does NOT touch

- No network. Records are written to a local file and nothing else.
- No session state. Records never enter the conversation, the model-visible
  surface, or the session format.
- No credential. The trail stores what callers tell it; it never reads the
  credential store.

## License

Apache License 2.0.
