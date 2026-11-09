# aishell-dsh-plugins

DSH (DeepSeek Harness) plugin packages for Huawei Cloud AI Shell.

## What is this

This repository hosts plugin packages that extend [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — an all-plugin Cordis agent harness. Each plugin package contributes tools, capability providers, commands, or profile bundles to the DSH runtime.

For the full DSH architecture and plugin authoring reference, see [docs/deepseek-harness-0.2.x.md](docs/deepseek-harness-0.2.x.md).

## Repository layout

```
aishell-dsh-plugins/
├── packages/
│   └── <pkg>/              one plugin package (flat: packages/*)
│       ├── package.json    @huaweidevtools/aishell-dsh-<name>, publishable, type: module
│       ├── tsconfig.json   extends ../../tsconfig.base.json
│       ├── src/
│       │   ├── index.ts    name, inject, apply, Config
│       │   └── types.ts    Session event / projection key declarations
│       ├── tests/          *.spec.ts behavior tests
│       └── README.md       Package API and extension points
├── docs/                  Developer documentation
├── scripts/               Repo tooling (aggregate, version bump, pack check, commit-msg hook)
├── package.json           Root workspace manifest
├── pnpm-workspace.yaml    Workspace: packages/*
├── tsconfig.base.json     Shared strict TS config
├── vitest.config.ts       Test runner config
├── lefthook.yml           Git hooks (lint staged, commit-msg)
└── .oxlintrc.json         Linter config
```

## Prerequisites

- Node.js `^22.19` or `>=24`
- pnpm `11` (`corepack enable && corepack prepare pnpm@11 --activate`)

## Getting started

```sh
pnpm install          # install dev dependencies
pnpm run typecheck    # tsc -b, then tsc -b packages/*/tsconfig.test.json
pnpm run test         # vitest run
pnpm run lint         # oxlint
pnpm run build        # tsdown bundles, then tsc -b (types), then the aggregate patch
```

`build` runs the bundles **before** `tsc -b` on purpose. tsdown writes `lib/`
with `clean: true`, so running it last would delete the `lib/types/` tree that
`tsc -b` had just produced — and every manifest's `types` and
`exports[*].types` points there. `scripts/check-packages.mjs` (run in CI) packs
each package and fails if anything a manifest promises is missing from the
tarball, which is how that class of defect is caught before publish.

### Typechecking spans two config graphs

`tsc -b` reads the root `tsconfig.json` `references`, and every project in that
list has `include: ["src"]` — so on its own it never looks at a test file, while
vitest transpiles without checking types. Each package that has a `tests/`
directory therefore also carries a `tsconfig.test.json` that extends its own
config, adds `tests/` to `include`, and sets `noEmit` (it is a checker, not a
build). `pnpm run typecheck` runs both graphs; turning the second one on
surfaced several real errors across the suites.

Two compiler options in `tsconfig.base.json` are set deliberately and are worth
knowing before changing either:

- **`target: "es2023"` with `lib: ["ES2024"]`** — syntax and API surface are
  separate settings. The target is what the toolchain can consume: vite 5's
  bundled esbuild rejects `es2024` and warns on every file it transforms. The
  library stays at ES2024 because the code uses `Promise.withResolvers`, and an
  omitted `lib` does not mean "the target's libraries" — it means the target's
  `.full` variant, which for `es2024` includes the entire DOM. Leaving it unset
  let Node-only packages typecheck against `document` and `localStorage`.
- **No implicit DOM.** A package that needs browser types says so in its own
  config (`aishell-brand` and `aishell-credentials` list `DOM`); everything else
  is Node plus the library above.

## Installing

```sh
# The whole set — one bundle row per plugin.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-base

# A single plugin, when you want to compose your own profile.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-deploy
```

Every plugin package declares its own `cordis.patch.yml` and a matching
`dsh.bundle` entry, so a package installed on its own is activated by the
loader rather than landing as an inert dependency.

### Pin the DSH dependency while its `latest` tag lags

Every plugin accepts exactly the vetted DSH hosts (see
[DSH version compatibility](#dsh-version-compatibility)), but the `latest`
dist-tag on `@deepseek-ai/dsh-base` still points at `0.0.1-rc.1`, which the
enumeration excludes. A plain install therefore resolves the `aishell-dsh-base`
peer to a version it cannot use, and npm reports
`ERESOLVE overriding peer dependency` for each plugin. The vetted builds are
published — only the tag is behind — so name the version once and the warnings
disappear:

```sh
npm install @deepseek-ai/dsh-base@0.2.1-rc.2
```

This is a statement about the upstream tags, not about these packages: nothing
here needs changing once `latest` catches up.

## Publishing

```sh
git add -A && git commit
pnpm run bump:version 0.0.1-beta.1    # bump, rebuild, verify
git add -A && git commit -m "chore: bump version to 0.0.1-beta.1"
pnpm run publish:beta                 # pnpm -r publish --tag beta --publish-branch main
```

`bump:version` is a script rather than a documented command sequence because two
of its three steps fail silently: `pnpm -r version` also rewrites the private
root manifest unless the root is filtered out, and each client bundle bakes its
version in at build time, so a bump without a rebuild leaves the UI showing the
previous version while the manifest shows the new one.

Two constraints on publishing:

- **Publish with pnpm only.** The internal dependencies use the `workspace:`
  protocol, which only pnpm rewrites at pack time. `npm publish` would ship
  `workspace:*` verbatim and the packages would be uninstallable
  (`EUNSUPPORTEDPROTOCOL`). Each package's `prepublishOnly` refuses to run under
  npm and says so.
- **`--publish-branch main` is required** — pnpm's default publish branch is
  `master`, and publishing from any other branch is refused.

Use `--tag beta` while the version is a prerelease, so it does not become
`latest`.

## Adding a new plugin package

1. Create `packages/<pkg>/` with `package.json`, `tsconfig.json`, `src/index.ts`.
2. Package name: `@huaweidevtools/aishell-dsh-<name>`.
3. Add the package to the root `tsconfig.json` `references`, or `tsc -b` skips it and its `lib/types/` never lands in the tarball.
4. `peerDependencies`: declare the `@deepseek-ai/dsh-*` packages you inject.
5. To ship it in the base bundle, add the directory to `patchFrom` **and** `deps` in
   `packages/aishell-base/aggregate.yml`, then run `node scripts/aggregate.mjs`. Both lists
   are required: `patchFrom` merges the package's `cordis.patch.yml` row into the bundle,
   `deps` writes it into the bundle's `dependencies` — with only one of the two the row
   resolves to a package that was never installed.
6. Follow the plugin authoring guide: [docs/deepseek-harness-0.2.x.md](docs/deepseek-harness-0.2.x.md) §25.

## DSH version compatibility

DSH is in developer preview — APIs may break between releases. Every plugin
package declares its `@deepseek-ai/dsh-*` dependencies (peer and dev alike) as
an explicit enumeration of the four hosts this set has been vetted against:

```
0.2.0-rc.1 || 0.2.1-rc.1 || 0.2.1-rc.2
```

When upgrading DSH, run `pnpm run typecheck` to catch API changes.

## License

Apache License 2.0. See [LICENSE](LICENSE).
