# @huaweidevtools/aishell-dsh-brand

AI Shell brand reskin for DSH web. Replaces the default DeepSeek fish mark in the sidebar and blank-session hero with the AI Shell icon and wordmark, and shadows the browser/window product title, tab favicon, and running-status whale + copy at runtime.

## How it works

Registers occupants for three `single` brand slots:

- `sidebar.brand.mark` — the icon in the expanded sidebar brand row and collapsed rail
- `sidebar.brand.name` — the wordmark beside the expanded mark
- `conversation.hero.brand.mark` — the icon on the blank-session first screen

All three are `kind: 'single'` slots, so this plugin replaces whatever occupied them before. In a default (non-official) DSH build those slots are empty (the shell renders a fish fallback), so aishell-brand simply fills them. In an official build it overrides `ui-brand-official`.

SVG assets are inlined as CSS `background-image` data URIs via lightningcss CSS Modules — no runtime fetch, no flash of missing image.

## Window title shadow

The product title "DeepSeek Harness" is baked into the dsh tree at build time (`DSH_CLIENT_TITLE` → both the served `dsh-web-frontend/dist/index.html` and the ui-layout `DocumentTitle` component), and that tree is covered by the desktop-runtime digest — the asar shell-layer swap cannot reach it. The plugin therefore shadows the title at runtime (`src/client/title-shadow.ts`): an own `title` property on the document intercepts every write and rewrites the product name to "AI Shell" in flight, covering both the initial page title and the repeated writes `DocumentTitle` performs on each session/panel change. The Electron main process never calls `setTitle` on the main window, so the window title follows `document.title` and this single seam covers both.

Shadowing is a default, not a force: the effect's disposer removes the own property and restores the official title, so disabling the plugin returns the shell to its official behavior.

## Favicon and manifest shadow

The browser tab icon comes from the dist's `favicon.svg` / `favicon-dark.svg` (a DeepSeek whale, one fixed fill per theme, selected by `media="(prefers-color-scheme: …)"` links) — digest-protected like the title. `src/client/favicon-shadow.ts` repoints every `link[rel~="icon"]` at the AI Shell mark data URI (`src/client/aishell-mark.ts`, pinned byte-for-byte against `assets/aishell.svg`), dropping the media qualifier because the mark's gradient reads on both themes. A MutationObserver re-shadows links re-inserted into the head. The web manifest's display names ("DeepSeek Harness" / "DSH") are rebranded to "AI Shell" through a Blob URL when the manifest is reachable; a manifest that cannot be fetched or parsed is left exactly as found, so the install prompt never breaks over a display name. The disposer restores every touched link and revokes the Blob URL.

## Running-status shadows

The thinking line under an active turn ("深度求索中，用时 X ···" / "Deep diving for X ···") carries two DeepSeek residues, both in ui-chat with no slot to occupy, so both are shadowed at runtime:

- **The whale tail icon** (`src/client/running-mark-shadow.ts`) — the same CSS-patch approach the hero headline uses, anchored on the row's stable literal attribute `[data-chat-running]`. The patch hides the animated APNG mask and the static SVG fallback and repaints the 14px `runningIcon` box with the AI Shell mark plus a gentle bob; under `prefers-reduced-motion` the mark is static, matching the official whale's own degradation.
- **The copy** (`src/client/running-text-shadow.ts`) — `locale.register` throws on the claimed `chat` namespace, so the rendered text is rewritten instead. One substring replacement per language covers both keys ("深度求索中" → "思考中", "Deep diving" → "Thinking"; the duration forms share the prefix). The line re-renders every second, so a MutationObserver (characterData + childList + the `data-shimmer-text` attribute — TextShimmer paints its highlight through `content: attr()`, so a stale attribute would flash the official copy on every sweep) keeps it covered for as long as the row exists. The row's aria status span sits in the same subtree and is covered by the same sweep.

Both disposers restore the official whale and copy exactly.

## Install

```sh
# Standalone:
dsh plugin --profile <name> add link:<repo>/packages/aishell-brand

# Or via the aishell-base bundle:
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-base
```

## What it does NOT touch

- Navigation, settings, panels, conversation — only the three brand slots, the product title, the tab icon/manifest names, and the running-status icon/copy.
- DSH default plugins — no rows disabled.
- Session titles in the browser title — the part before the product name passes through unchanged.
- Duration units and the "···" tail in the running line — the harness's own words, not product branding.

## License

Apache License 2.0.
