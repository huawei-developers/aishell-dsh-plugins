# @huaweidevtools/aishell-dsh-credentials-store

Credential storage for aishell DSH plugins, plus the vocabulary they share: the
account names, the credential bundle, and IAM verification.

The store keeps **one** record — `aishell-credential` — holding the Huawei Cloud
pair and the e2b API key as one base64-encoded JSON bundle. One write, so a
credential set can never be left half-replaced; one read, so a new AK can never
pair with an old SK.

Upper layers call `createCredentialsStore()` and receive a `CredentialsStore` —
they never learn which backend is serving. The factory probes backends in
priority order and returns the first that answers.

This is a **tool library**, not a DSH plugin — no `dsh.client`, no `cordis.patch.yml`, no `apply`.

## Backends

| Priority | Backend | Durable? | Requirement |
|---|---|---|---|
| 1 | `KeyringBackend` | Yes (cross-process, survives reboot) | OS keyring reachable (macOS Keychain / Linux Secret Service / Windows Credential Manager) |
| 2 | `FingerprintBackend` | Yes (same-machine, survives reboot) | `node-machine-id` can resolve a machine UUID |
| 3 | `MemoryBackend` | No (process-scoped) | None — always available, last resort |

When the OS keyring is unavailable (headless Linux without D-Bus, keychain locked, container), the factory falls back to the fingerprint backend — a machine-fingerprint-bound AES-256-GCM encrypted file, `$DSH_HOME/credentials/<scope>.credentials.enc` (`<DSH_HOME>` falls back to `~/.aishell`). The encryption key is derived from the machine UUID via scrypt; the ciphertext is useless on a different machine. If the machine UUID is also unavailable, the factory falls back to the in-memory backend so a single DSH session still works.

### Linux: the store is required, not preferred

`@napi-rs/keyring` picks its own Linux store when none is named: the Secret Service first, then — silently — the **kernel keyutils keyring**. That fallback is wrong for credentials, as the binding's own README states: the kernel keyring is "completely in-memory and will not persist across reboots". A container or CI job would accept credentials, report them stored, and lose them at the next reboot.

`KeyringBackend` therefore passes `{ linux: { store: 'secret-service' } }`, which makes an unavailable Secret Service **throw** from the construction probe instead of falling back — so the factory's next backend is the fingerprint encrypted file, which is durable. Without the pin the absent-service case does not throw; see the module comment in `src/backends/keyring.ts`.

Note that this is the D-Bus Secret Service protocol (`org.freedesktop.secrets`), not `libsecret` — the binding does not link libsecret, and the platform binary is prebuilt, so no development headers are needed.

## Write failover

The construction probe can only detect a keyring that cannot be *read*. A GNOME login keyring whose collection is locked passes the probe — reads answer `null` rather than throwing — and then rejects every write (`Secret Service: no result found`, or a system unlock prompt that blocks until dismissed). So a keyring that passes the probe is wrapped in a `FailoverStore`, which covers the write side:

- The first failed `set`/`delete` fails over, **stickily**, to the fingerprint backend for the life of that store instance. Sticky because a locked collection fails every write; retrying per call would surface the same error — or the same unlock prompt — once per account a save writes. `delete` trips it too, because the save route deletes the old set before writing the new one.
- **Which copy wins.** A locked collection reports `null` for entries that really exist, so its copy can be arbitrarily stale; once it unlocks, that copy would otherwise outrank the value saved in the meantime — resurrecting a credential the user had rotated or cleared. The two backends cannot be compared by recency, so the fallback is authoritative for any account it has an opinion about: a value there wins (it got there by a failover write, which is newer by definition), a tombstone there means deleted, and otherwise the keyring answers. A failed-over clear writes a tombstone because it has no value to shadow the keyring's copy with.
- A successful keyring write or delete clears the fallback value *and* the tombstone, handing authority back to the keyring — a leftover tombstone would make a good keyring credential read as absent.
- Reads before any failure fall through to the fallback after a keyring miss, so a credential stored by a previous session's failover stays visible.

The record lives in the fallback backend — the encrypted file in practice — so it survives the restart the failure mode requires: the keyring is locked *now*, and the read that would resurrect the credential happens in a later session, after it has unlocked. On a machine whose keyring has never failed the fallback has written nothing, and each read pays a sub-millisecond check against an absent file.

## Credential scope

One build-time constant decides where credentials live, and it decides both
names at once:

| | default |
|---|---|
| keyring service | `aishell-dsh-plugins` |
| encrypted file | `plugins.credentials.enc` |

```sh
AISHELL_CREDENTIAL_SCOPE=staging pnpm run build
# → keyring service `aishell-dsh-staging`, file `staging.credentials.enc`
```

It is **not** a runtime setting, and not a plugin config option. A scope set on
a reader but not on the writer stores credentials in one namespace and looks for
them in another: the form says "saved" while every tool says "not
authenticated". A build-time constant cannot be set on one side only, and two
deployments that should not see each other's credentials differ by being built
differently — which is the honest place for a persistence boundary.

## Usage

```typescript
import { createCredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store'
import { readStoredPair, writeHuaweiCloud } from '@huaweidevtools/aishell-dsh-credentials-store/accounts'

const store = createCredentialsStore()          // probes keyring → fingerprint → memory

// Read the pair: one snapshot of one record.
const pair = readStoredPair(store)              // { ak, sk, securityToken? } | undefined

// Write it: one atomic replacement. A save without a token drops the old one.
writeHuaweiCloud(store, { ak, sk })
```

Other entries:

| Subpath | What it is |
|---|---|
| `.` | The store factory and backend chain |
| `./accounts` | Account names, the credential bundle, the pair reader/writer |
| `./verify` | IAM verification (`GET /v3/projects`), one answer for one credential set |
| `./signer` | SDK-HMAC-SHA256 request signing |
| `./scope` | The build scope, and the two names derived from it |

## Security properties

- **No plaintext files**: nothing on disk is readable with `cat`.
- **OS-encrypted at rest**: Keychain, Secret Service (GNOME keyring / KWallet — the OS owns the encryption), Credential Manager.
- **Machine-bound encryption (FingerprintBackend)**: AES-256-GCM with a scrypt-derived key from the machine UUID. The ciphertext is useless on a different machine; the key never touches disk.
- **Per-operation read**: no cache; a credential removed from the keyring is immediately absent on the next `get`.
- **A reachable store that lacks the credential reads as absent, not as an error** — `get` answers `undefined`, so the caller's auth flow fails the same way whether the credential was never stored or was cleared.
- **An unreachable store is a construction failure, not a read failure.** With the Linux store required (above), no `KeyringBackend` is built at all when the Secret Service cannot be reached: the constructor throws and the factory moves to a durable backend. Once constructed, a store that later becomes unreachable has `get`/`has` answer `undefined`/`false` (reads degrade) while `set`/`delete` throw (writes cannot be silently lost).

## Platform support (KeyringBackend)

| Platform | Backend | Requirement |
|---|---|---|
| macOS | Keychain | None (built in) |
| Linux | Secret Service over D-Bus | `gnome-keyring`, `kwalletd`, or KeePassXC running on the session bus (no libsecret, no build headers — the platform binary ships prebuilt) |
| Windows | Credential Manager | None (built in) |

## License

Apache License 2.0. See [LICENSE](../../LICENSE).
