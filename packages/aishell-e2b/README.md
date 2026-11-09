# @huaweidevtools/aishell-dsh-e2b

Runs throwaway and preview deployments in E2B sandboxes — sandbox lifecycle,
commands, and files, as tools the model calls.

> **Not to be confused with `@deepseek-ai/dsh-e2b`.** That official package
> replaces the harness's execution world: mount it and *all* of the agent's own
> file and command work runs in a remote sandbox. This package instead adds
> *tools*, so the agent keeps working locally and reaches a sandbox only when it
> decides to.
>
> The two can be mounted together. This package registers its tools under the
> `aishell__` prefix (`aishell__sandbox_create`), so a tool name cannot collide
> with the official package's, whichever names it uses.

## Why this exists

Every deployment request currently reaches the same path — the Huawei Cloud
operations server, provisioning real resources with real cost, real credentials,
and real cleanup obligations. A large fraction of requests do not need that: a
static page, a small service, something to look at once. Those need a place to
run and an address to open, and nothing that outlives the task.

This plugin adds that second tier, and contributes a prompt section stating when
each is appropriate. Tools alone would leave the choice to guesswork.

## How it reaches the service

```
POST https://openapi.aishell.openbuildlab.com/e2b/keys   (AK/SK signed)
    → {"api_key": "sk-e2b-…", "expires_at": "…"}   presented as X-API-KEY
```

The key is a **stored credential**, kept under `AISHELL_E2B_API_KEY` in the same
credential store the AK/SK live in:

1. Read it from the store.
2. Missing, past its `expires_at`, **or minted under different credentials** →
   `POST /e2b/keys` once, and store the result.
3. Present the stored key on every sandbox call.
4. If a sandbox call is refused as unauthenticated → discard the key, issue a
   new one, and retry that call once.

A key issued with no expiry records `9999-12-31` as its expiry, so "never
expires" stays one comparison rather than a second shape.

### The key belongs to the credentials that minted it

The key entry also records a **fingerprint of the AK** that requested it, and a
stored key is used only while it matches the credentials in hand. Without that,
clearing or replacing the AK/SK would leave the old key — and so the old tenant,
with all its sandboxes — alive and usable, which is the opposite of what
clearing credentials means.

Three consequences are deliberate:

- **No credentials at all invalidates it too.** Clearing them states that
  nothing granted under them may still be presented.
- **Re-entering the same AK/SK does not rotate the key.** The fingerprint
  answers "which identity minted this", not "when was it written". Re-saving the
  same pair has changed nothing, and throwing away running sandboxes for it
  would be gratuitous.
- **No event listener is needed.** The check is on the read path, so it also
  catches a store changed outside the credential form, or while this plugin was
  not mounted.

A mismatch does **not** delete the stored entry: an empty read is not proof of a
clear (a locked keyring answers `undefined` for entries that are really there),
and deleting on it would rotate the tenant on every keyring hiccup. The entry is
overwritten by the next successful create. A key stored by an older build
carries no fingerprint and is trusted as-is, so upgrading does not orphan
existing sandboxes; the 401 path still catches a key that has really stopped
working.

The key is the tenant: the gateway derives a caller identity from the presented
key and scopes every sandbox to it. That is why it is **persisted rather than
held in memory** — a key re-created on every start would be a new tenant, and
every sandbox made before it would stop being reachable, which surfaces as "no
such sandbox" and points nowhere near the cause. A replacement key is a new
tenant for the same reason, so the 401 path is a recovery for a dead key, not a
routine refresh.

The sandbox protocol itself is spoken by the official `e2b` client library,
pointed at the gateway's domain — the configuration the gateway exists to accept.

## Tools

Registered under `aishell__`, like every tool this plugin set contributes. The
prefix is what makes several packages' tools coexist in one registry: a bare
`sandbox_create` is fine until another package registers the same name, and then
one of the two silently loses.

| Tool | E2B SDK method |
|---|---|
| `aishell__sandbox_create` | `Sandbox.create` |
| `aishell__sandbox_list` | `Sandbox.list` |
| `aishell__sandbox_info` | `getInfo` |
| `aishell__sandbox_kill` | `kill` |
| `aishell__sandbox_set_timeout` | `setTimeout` |
| `aishell__sandbox_commands_run` | `commands.run` |
| `aishell__sandbox_commands_kill` | `commands.kill` |
| `aishell__sandbox_files_write` | `files.write` |
| `aishell__sandbox_files_read` | `files.read` |
| `aishell__sandbox_files_download` | `files.read` → `ctx.fs` |
| `aishell__sandbox_files_list` | `files.list` |
| `aishell__sandbox_get_port_url` | `getHost` |

### One conversation, one sandbox

A conversation works in at most one sandbox. No tool but `aishell__sandbox_create` takes a
`sandboxId` — there is nothing to choose between, so there is no parameter to get
wrong and no way for a call to land somewhere the model did not mean.

`aishell__sandbox_create` binds the sandbox to the conversation; creating a second one
replaces the binding, and the first keeps running until its lifetime expires, so
`aishell__sandbox_kill` is how it is released.

**The binding is never created implicitly.** A tool called with no sandbox fails
and names `aishell__sandbox_create`. A tool that quietly created one would have to pick
the template and the lifetime, and those are the two decisions the create tool's
parameters exist to put in the conversation.

**The binding survives a restart.** The sandbox is tagged with its conversation
in its own `metadata` at creation, and a process that has no binding rebuilds it
by querying for that tag — so a plugin reload does not orphan a running sandbox.
A paused sandbox is not adopted, because using it would mean resuming it and
restarting its clock.

### Three conventions worth knowing

- **`timeoutMs` is milliseconds.** The TypeScript SDK counts milliseconds where
  the Python one counts seconds. The service caps a lifetime at 24 hours for a
  pro account and 1 hour for a hobby account.
- **A sandbox that has expired is distinguished from one that never existed.**
  The first means the previous sandbox's contents are gone and a replacement
  starts empty; the error says so, because the model has to know that before it
  decides to carry on.
- **A non-zero exit is a result, not a failure.** `aishell__sandbox_commands_run` reports
  the exit code and both streams, so a failing test or a compile error reads as
  an outcome to reason about rather than a broken tool.

## Config

| Field | Default | Meaning |
|---|---|---|
| `apiBaseUrl` | `https://openapi.aishell.openbuildlab.com` | The key provisioning service |
| `domain` | `aishell.openbuildlab.com` | The sandbox gateway's domain (an E2B client's `E2B_DOMAIN`) |
| `requestTimeoutMs` | `60,000` | Per-request timeout, key fetch and SDK calls alike |

Credentials are the same Huawei Cloud AK/SK pair the other plugins in this set
use, read from the same store. Store them through the credential button in the
composer — the Huawei Cloud chip under the input bar, or the same chip on the
New-Session row. Clicking it opens the credential form in the current
conversation; there is no Settings section to find.

## What it does NOT do

- **It does not provision cloud resources.** Persistent infrastructure belongs to
  the operations server; nothing here survives a sandbox's lifetime.
- **It does not move the agent's own work into a sandbox.** Files the agent reads
  and commands it runs stay local unless it calls one of these tools. For the
  other arrangement, mount the official `@deepseek-ai/dsh-e2b`.
- **It does not gate destructive calls behind approval.** `aishell__sandbox_kill` and
  `aishell__sandbox_commands_run` run without an approval prompt in this version.
- **It cannot write a binary file to the local workspace.** The sandbox side
  supports it — `files.read` returns bytes, and `sandbox.downloadUrl` issues a
  presigned URL — but the harness filesystem (`ctx.fs`) accepts UTF-8 text only,
  with no binary write on either the abstract provider or the local backend. So
  `aishell__sandbox_files_download` writes text as text and, for a binary file, returns
  base64 and says so rather than writing a mangled copy.
- **It does not adopt a paused sandbox.** Recovery only takes a sandbox the
  gateway reports as running. A paused one would have to be resumed to be used,
  which restarts its clock — a billing decision left to `aishell__sandbox_create`.
- **It does not tag pre-existing sandboxes.** A sandbox created outside this
  plugin carries no conversation tag, so `aishell__sandbox_list` shows it but no
  conversation adopts it.

## Install

```sh
# Standalone
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-e2b

# Or as part of the set
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-base
```

## Known gaps

- **Public reachability of a port URL is not yet settled.** `aishell__sandbox_get_port_url`
  returns `https://<port>-<sandboxId>.<domain>`, following the E2B SDK, whose
  `getHost` composes exactly that hostname. Whether that address is open to
  anyone or requires the sandbox's traffic token is decided by the gateway's
  network configuration, and has not been verified against a live deployment.
- **`files.write` feature gates depend on the sandbox's `envd` version.** In
  particular `useOctetStream` needs envd ≥ 0.5.7 — below that the SDK silently
  falls back to multipart. The text writes this plugin performs are unaffected.

## License

Apache License 2.0. See [LICENSE](../../LICENSE).