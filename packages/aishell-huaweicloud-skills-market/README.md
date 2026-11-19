# @huaweidevtools/aishell-dsh-huaweicloud-skills-market

Browses Huawei Cloud's official agent skills from inside AI Shell and installs
the ones you choose. One tab on the Plugins page, beside **Installed** and
**Discover**.

## What this is, and what it is not

A skill is a directory of instructions the model can load on demand: a
`SKILL.md` plus whatever references, scripts, and templates it needs. The
harness already discovers skills from `<host home>/skills` and watches that
directory, so a bundle written there becomes an ordinary local skill — no
provider registration, no restart, no second lifecycle.

This package is only the part in front of that: a catalogue of what upsteam
publishes, and the two operations that change which bundles are on disk.

| The market does | The market does not |
|---|---|
| List what `huaweicloud/huaweicloud-skills` publishes | Read, validate, or filter what a skill says |
| Copy a chosen bundle into the skills root | Install the tools a skill happens to call |
| Remove the bundles it installed | Touch a skill it did not install |
| Show name, description, category, and the `SKILL.md` body | Interpret a skill's frontmatter beyond `name` and `description` |

The distinction is deliberate. Whether a skill's instructions are good, or
whether the CLI it names exists on this machine, is not a question this package
answers — and a market that tried to answer it would need to know every skill's
subject.

## Where the catalogue comes from

The upstream repository has no index document. It is a tree of
`skills/<category>/<product>/<skill>/SKILL.md` bundles, and a skill's name and
description exist only in its own `SKILL.md`. So the market keeps a **working
copy** of the repository and reads the catalogue out of that.

```sh
gitcode.com/huaweicloud/huaweicloud-skills.git   ← tried first
github.com/huaweicloud/huaweicloud-skills.git    ← tried when the first fails
```

Both serve the same commit. The mirror is first because it is reachable where
GitHub is not; GitHub is second so a deployment that cannot or will not contact
the mirror still works.

The clone goes through [isomorphic-git](https://isomorphic-git.org), not the
`git` executable:

- **No `git` on `PATH` is required.** A host without it would otherwise have a
  market that does nothing.
- **No subprocess, no quoting.** Paths with spaces, Windows separators, and an
  editor's `GIT_*` environment never reach this code.

Measured against the real repository (2026-11-19): the first read is ~14 s and
198 skills; a refresh fetches only the changed objects and completes in ~3 s.
The working copy is ~90 MB and lives at
`<host home>/cache/aishell-skills-market/repository`.

### When it reads

Once, when the tab is opened, and again when **Refresh** is pressed. Nothing
here is on a timer: the catalogue changes when a skill author pushes, which is
neither predictable nor urgent, and a periodic read would spend a network round
trip on every launch for a tab most sessions never open.

A refresh that fails keeps the catalogue already on screen — you lose the newest
skills, not the list you were reading. A first read that fails says so and offers
a retry, because "could not load" and "there are no skills" lead a person to do
different things.

## Installing

An install copies the bundle out of the working copy:

```
<skills root>/
  .market-staging/<name>-<pid>-<ts>/   ← assembled; not a skill (no SKILL.md yet)
  <name>/                              ← moved into place with one rename
    SKILL.md
    references/…
    .market-install.json               ← "this one is mine"
```

Three properties follow:

- **A bundle is never observable half-written.** The watcher sees the old
  bundle, then the new one, or for one scheduling tick neither.
- **A skill you wrote yourself is never overwritten.** A directory of that name
  without the marker is refused, and the refusal is reported on the row.
- **Uninstall only removes what install created.** Same marker, same rule.

The name is taken from the frontmatter, not the directory, because the skill
registry keys on the frontmatter: a bundle whose directory and frontmatter
disagreed would otherwise install under a name the model cannot load. Measured
across the upstream repository, all 198 agree (one only after YAML resolves a
quoted spelling).

Installing needs no confirmation — the uninstall button beside it is the undo.
Uninstalling does, because it is the one step with nothing behind it.

### What an install does not do

- **No restart.** The harness discovers the bundle from the skills root on its
  own. It appears in a new session's catalogue, and in the next step of an
  existing one.
- **No tool installation.** A skill that names `hcloud` commands needs that CLI
  on `PATH`, and a skill that names tools needs those tools mounted. The market
  installs instructions, not capabilities.
- **No credential.** Skills do not receive the AK/SK; a skill that signs cloud
  calls reads them the way any other shell command would.

## The list

One page of 24 skills at a time, with a pager under it. Measured against the real
catalogue: 198 cards in one column is about fifteen screens of DOM, and every
keystroke in the search field rebuilt all of them. A page keeps the DOM at
twenty-four cards whatever the catalogue size.

Two filters compose: an install-state switch (**all / installed / not installed**)
and the category rail, which is derived from what the catalogue actually contains
rather than hard-coded — upstream adds and removes categories.

Each card leads with the skill's name minus the vendor prefix (every upstream name
opens with `huawei-cloud-`, which carries nothing on a page that is entirely
Huawei Cloud), then a three-line description, then its tags and its one action. A
card with a short description still puts its footer on the row's line, because the
cards in a row share a height.

The tags are the card's own two facts — category and product — followed by the
skill's authored tags. Of those, the card drops the vendor name, anything the card
has already said, and any phrase over 24 characters (measured upstream: the
longest single tag is 69 characters, which is a sentence). It shows at most four.
The skill's page lists the authored tags in full.

## Configuration

```yaml
- id: aishell-huaweicloud-skills-market
  name: '@huaweidevtools/aishell-dsh-huaweicloud-skills-market'
  config:
    skillsRoot: /custom/skills   # default: <host home>/skills
    mirrors:                     # default: the two above, in that order
      - https://gitcode.com/huaweicloud/huaweicloud-skills.git
    branch: master               # default: master
```

`skillsRoot` is resolved through the same helper the filesystem skill provider
uses. An explicit value must name the directory that provider scans, or installs
will land where nothing looks.

## The route

One POST, discriminated by an `op` field — the Host's fetch registry is a
`path → route` map, so a second registration on one path throws:

```
POST /api/aishell/huaweicloud-skills-market
  { "op": "catalog" }
  { "op": "detail",    "name": "huawei-cloud-obs-upload" }
  { "op": "install",   "name": "huawei-cloud-obs-upload" }
  { "op": "uninstall", "name": "huawei-cloud-obs-upload" }
```

`install` and `uninstall` answer with the catalogue as it stands afterwards, so
the Page never re-reads to learn what it just did.

Failures carry a stable `code` — `catalog-unavailable`, `unknown-skill`,
`name-taken`, `not-installed-here`, `write-failed`, `bad-request` — so the Page
words them in the active language instead of parsing a message.

## Audit

When `@huaweidevtools/aishell-dsh-audit` is mounted, installs and uninstalls are
recorded there as `skill.install` and `skill.uninstall`, with the bundle path as
detail. Without it, nothing is recorded and nothing else changes: the trail is
optional, so this plugin works on its own.

## Install

```sh
# On its own.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-huaweicloud-skills-market

# Or with the rest of the aishell plugin set.
dsh plugin --profile <name> add @huaweidevtools/aishell-dsh-base
```

The tab appears on the **Plugins** page. It sorts before the shipped Discover
tab and before `dshmarket`'s own tab, so the row reads Installed, HuaweiCloud
Skills, then whatever else the profile contributes.

## What it does NOT touch

- **No `ctx.skills`.** The plugin never registers a provider and never reads the
  registry; an installed skill is discovered by the harness's own filesystem
  provider.
- **No session state.** Nothing here writes a session event or a projection.
- **No credentials, no cloud API.** The catalogue is a public git repository and
  the write target is a local directory.
- **No skill the market did not install.** Every write and every delete checks
  the marker first.

## License

Apache License 2.0.