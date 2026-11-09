# @huaweidevtools/aishell-dsh-huaweicloud-docs

Tells DSH's model where to read Huawei Cloud product documentation. One system-prompt section; no tools, no browser half, no other dependency.

## What it injects

```
Huawei Cloud product documentation — for what a product is, what it supports,
its quotas and limits, or its billing model — is indexed at
https://support.huaweicloud.com/llms.txt

That index lists every Huawei Cloud product by category, each entry naming the
product's own llms.txt. Read it to find the product, then read that product's
file for the detail. Do not answer questions about a product's capabilities or
limits from memory; they change between releases, and the documentation is the
authority.
```

## Why only a pointer

The index itself is ~35 KB of product names — real value, but a per-turn cost of roughly 9k tokens, of which any one task needs a single entry. So the section carries the pointer, and the model fetches the index — and then the one product under it — with the web-fetch tool it already has. That is the shape `llms.txt` exists for.

## Where it sits in the prompt

Early — immediately after the deployment persona prefix, ahead of every policy and tool section. Background knowledge belongs before the model starts planning, rather than arriving once it has already reached the tool list.

Measured against the real `SystemPrompt` service, the assembled prompt reads:

```
harness:identity            -1000
deployment:persona-prefix       0
aishell:huaweicloud-docs      100   ← this plugin
plan:policy                   500
tool:*                    1000+
deployment:persona-suffix   10200
```

So it lands inside the persona envelope (the prefix opens at `0`, the suffix closes at `10200`) and before every policy and tool slot.

The position is a number (`HUAWEICLOUD_DOCS_ORDER = 100`) rather than one of the framework's named slots, because its placement table is closed: `PromptSectionOrderName` is `keyof` a fixed constant, so a `HUAWEICLOUD_DOCS` name has nowhere to go. The table leaves the gap between `0` and `500` empty, and `100` sits inside it. The orders bracketing that gap are the only two available — below `0` is before the persona opens, and at or above `500` is inside the policy band, where background reads as an instruction.

A section rather than a runtime context because the URL never changes. `context()` is for facts that flip — the read-only policy uses it for exactly that reason — and a constant belongs in a section.

## Install

```sh
# On its own.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-huaweicloud-docs

# Or with the rest of the aishell plugin set.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-base
```

## What it does NOT touch

- No tools. The model uses its existing web-fetch tool; this plugin adds none.
- No credentials, no network calls of its own.
- No browser half — nothing to render.

## License

Apache License 2.0.
