# @huaweidevtools/aishell-dsh-llm

OpenAI-compatible LLM adapter for DSH. Registers the `aishell` provider route on `ctx.llm`, routing model calls through the aishell gateway with direct AK/SK signing.

Besides the live route, the plugin declares `aishell` in the configurable-provider directory (`ctx.llm.registerConfigurableProviders`) — the directory the Models page joins with live routes, so the route shows up as a configurable provider row with its own settings address. The plugin also carries a Config schema; the settings mirror only lists namespaces whose plugin declares one, so without it the Models page would not show the row.

## The Models-page row

The row itself is read-only: the profile has no fields the host editor knows how to write, and credentials are entered through the form the `aishell-credentials` chips open (the account chip beside the chat input, or the chip on a New Session page). The browser half therefore does not extend the row with a card — it shadows the row's header at runtime (`src/client/provider-row-shadow.ts`, the same approach `aishell-brand` uses for its digest-protected host residues): a status dot after the row's name (green when AK/SK are stored, warn when they are not, with the readiness copy as its hover title) and the header's Edit button hidden, because there is nothing to edit. A MutationObserver keeps the shadow applied across the page's re-renders; the shadow is re-installed on a locale switch so the hover copy follows the active language; disabling the plugin restores the official row exactly.

## How it works

```
User selects aishell/<model>
  → GatewayAdapter.stream(options)

  Every request is signed directly with AK/SK (SDK-HMAC-SHA256):
    → credential store reads the AK/SK pair (one record; optional STS token)
    → sign(POST, host, /chat/completions, query, body) → signed headers
    → POST {baseUrl}/chat/completions  (signed headers, OpenAI wire format)
    → parseSse → translate → StreamChunks

  Model listing:
    → GET {baseUrl}/models  (AK/SK signed)
    → returns OpenAI-compatible model list
```

No intermediate API-key exchange or config fetch — every request is signed with the user's AK/SK. The credential store (OS keyring with fingerprint + memory fallback) holds the AK/SK; this adapter only reads them.

## Image input

The adapter carries images for models whose gateway catalog entry lists `image` in `modalities`. A model the catalog describes as text-only never receives one: `dsh-llm` projects such an image to a stable placeholder before the adapter sees it.

For an image-capable model the pipeline is:

```
harness history (durable image *references*, not bytes)
  → prepareRequestImages: one request version per attachment, via ctx.attachments
  → byte budget check → IMAGE_OFFLOAD_REQUIRED when over
  → projectOffloaded: occurrences an earlier offload decision marked
  → serialize: [handle text, base64 data URL] parts on the user message
```

Two properties are worth knowing:

- **Bytes are read from the attachment service, not the block.** An image block holds an opaque `attachmentId` that is deliberately neither a path nor a URL, so the adapter resolves bytes through `ctx.attachments.readImageRequest`, which also normalizes and re-encodes to the route's target size. A deployment without that service fails image requests with `UNSUPPORTED_CONTENT` rather than sending an empty turn.
- **Tool-result images ride a separate user turn.** OpenAI's `tool` message takes text only, so an image a tool returned is hoisted into a following `user` message — the same shape the ecosystem's OpenAI-path serializer produces.

Over-budget requests fail with `IMAGE_OFFLOAD_REQUIRED` and are retried by `@deepseek-ai/dsh-compaction-image-offload`, which `dsh-base` mounts: it marks the oldest occurrences offloaded, after which they travel as placeholder text. This adapter never offloads on its own.

Image token accounting uses the token meter's structural estimate — this adapter implements no `imageRequestPricing`, matching `dsh-llm-pi-ai`. Image-heavy sessions are therefore approximated rather than priced per model.

## What it does NOT touch

- `ctx.credentials` — DSH's own credential provider stays `dsh-credentials-local`. User-configured models and `.credentials.yaml` keep working.
- `llm-deepseek` / other adapters — user's existing providers are unchanged.
- No tools, commands, or session behavior is modified.

## Install

```sh
# Standalone (LLM adapter only — no credentials UI):
dsh plugin --profile <name> add link:<repo>/packages/aishell-llm

# Or via the aishell-base bundle (full stack):
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-base
```

## Config

| Field | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string?` | `https://openai.aishell.openbuildlab.com/v1` | Chat API base URL. `/chat/completions` and `/models` are appended, so a base carrying its own path segment is signed and requested in full. |
| `requestImagePixelBudget` | `number?` | `4194304` | Total-pixel cap one request image is scaled into. |
| `requestImageMaxBytes` | `number?` | `1048576` | Encoded-byte target for one request image. |
| `maxRequestImageBytes` | `number?` | `20971520` | Accumulated base64 image bytes one request accepts before the oldest images must be offloaded. |

The three image fields share `dsh-llm-pi-ai`'s defaults: the gateway publishes no image budget of its own, so the route supplies one.

## Storing credentials

**Web UI (recommended):** Install `aishell-credentials` (or the `aishell-base` bundle) — clicking the credentials button beside the chat input (or the one on a New Session page) opens a form with AK/SK/SecurityToken fields. Values are verified against Huawei Cloud IAM and transferred to the credential store; the button flips to the account name when they are stored.

**CLI fallback:**

```sh
node --input-type=module -e "
import { createCredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store';
import { writeHuaweiCloud } from '@huaweidevtools/aishell-dsh-credentials-store/accounts';

// One record, one write. The pair and its optional STS token go in together.
writeHuaweiCloud(createCredentialsStore(), {
  ak: 'your-ak',
  sk: 'your-sk',
  // securityToken: 'your-token',   // only for temporary credentials
});
"
```

## License

Apache License 2.0.
