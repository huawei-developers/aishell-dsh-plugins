---
description: "Deep-link transport for DSH — carries aishell:// URLs from the desktop shell to the plugin that claims them."
kind: "package-reference"
---

# @huaweidevtools/aishell-dsh-deeplink

## Summary

Routes `aishell://` URLs from the desktop shell to the plugin that claims their
family. Two halves, no UI: the Host half provides `deepLinks` and streams
incoming URLs to the Page; the Page half provides `aishellDeepLinks`, where a
plugin claims a family and receives its URLs.

The transport never interprets a URL beyond admitting it, and never acts on
one. Routing is the Page's, because that is where families are claimed and
where the UI lives.

## Use this package

### Claiming a family

```ts
ctx.inject(['aishellDeepLinks'], (scope) => {
  ctx.effect(() => scope.aishellDeepLinks.claim('share', (url) => {
    openPreview(url.href)
  }), 'my-plugin: deep link')
})
```

The handler receives the whole URL. The transport does not parse it: the shape of
an `aishell://share/...` belongs to whoever mints those links.

- `family` is the URL's first segment after `//`, lowercased:
  `aishell://share/abc123` → `share`.
- One family has one claimant. A second claim of the same family throws.
- A URL that arrives **before** the claim is replayed on the claim, in arrival
  order.
- The disposer releases the family; a later claim may take it.

### The URL shape

| component | `aishell://share/abc123` |
|---|---|
| `url.protocol` | `aishell:` |
| `url.hostname` | `share` — **the family, not part of the path** |
| `url.pathname` | `/abc123` |
| `url.search` | `` |

The family is compared lowercased on both sides: a non-special scheme keeps the
host case the sender typed.

### For the desktop shell

The shell delivers URLs through the `deepLinks` service and nothing else:

```ts
ctx.deepLinks.deliver('aishell://share/abc123')
```

It passes the string through unparsed. This package admits it (scheme and
family), then hands it to the Page. A URL for a family nobody claims is held for
the next Page connection — the Host cannot see the Page's claims, so it does not
filter by them.

## Understand the implementation

### Why the Page is pushed to

The Page cannot usefully poll. Two cases defeat it:

- **The window already has focus.** Raising a focused window emits no event, so
  a focus-triggered fetch never runs.
- **The IPC hop is asynchronous, focusing is not.** A fetch triggered by focus
  can run before the URL reaches the Host.

So delivery is a server-sent-events stream (`GET /api/aishell/deep-link`), and
the Page keeps one `EventSource` for its lifetime.

### Buffers

| Where | Holds | Covers |
|---|---|---|
| Host half | `pending` (max 8) | no Page is connected yet — the normal cold-start path |
| Page half | `waiting` (max 8) | the plugin owning a family has not claimed yet |

Both bounds keep the newest entries: a user who clicked five links wants the
last one.

### What the transport deliberately does not do

- **No actions on a URL.** A deep link is an invitation; the claiming plugin
  shows a preview and the user decides.
- **No family filtering on the Host.** The claims live in the Page.
- **No replay of a delivered link on Page reload.** The URL was consumed; the
  stream is a delivery channel, not a log.

## Files

```
src/link.ts        admission rules (pure, no cordis)
src/route.ts       the registered path and its Page-relative form
src/index.ts       Host half: deepLinks + the SSE route
src/client/index.ts  Page half: aishellDeepLinks + the EventSource
```

## Further exploration

- [Deep links](../../docs/design/deeplink.md) — the full design: the
  vocabulary, the division of responsibility, the host-side changes, the
  acceptance list, and the reasoning behind each choice.