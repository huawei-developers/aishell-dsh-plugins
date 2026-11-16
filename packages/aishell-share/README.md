---
description: "Session sharing for AI Shell — the `aishell://share` link family, claimed and rendered."
kind: "package-reference"
---

# @huaweidevtools/aishell-dsh-share

## Summary

Owns the `aishell://share` link family, and both ends of a shared conversation:
uploading one and writing an imported one into this machine's session store.

The family has exactly one claimant. A second registration of `share` throws,
which is what keeps two plugins from silently splitting a URL space users see.

## How it works

```ts
ctx.aishellDeepLinks.claim(FAMILY, (url: URL) => {
  if (readShareId(url) === undefined) return
  machine.openLink(url.href)
})
```

The claim itself is what gives the plugin its entry point; what follows is
decided by the dialog, not by the link.

`readShareId` is the whole admission — family and kind — and both entry points
use it: the claim, and the field a reader pastes a link into. The distinction
matters at the second one. A parser that only read the path would take `b` out
of `https://example.com/a/b` and look it up as a share id; checking the family
first is what keeps a stray URL from becoming a lookup for a resource nobody
named.

| half | responsibility |
|---|---|
| Page | claim the family; host the dialog in `shell.overlay`; the "Share session" menu row |
| Node | read a session to share it; write an imported package as a stored session |

### Why each half does what it does

`ctx.aishellDeepLinks` is provided by the transport **in the Page**, so the
claim can only happen there. Reading and writing a session log needs the
session store and the persistence backend, which only the Host has. Neither
half can do the other's work.

The Node entry is also what the loader scans the package's `dsh.client` block
from; without it the browser bundle is never discovered.

## Sharing

The dialog asks before anything leaves the machine. It names what is being sent
— the whole conversation, tool calls included — and the button the reader
presses is the one that uploads. There is no filter and no separate privacy
switch; see the design document's §7.1 for why.

A package carries the events that make a conversation and nothing else.
References between them (`surfaceOp` ranges, `sourceEventSeqs`, and a title's
`messageSeqs`) are rewritten to point at positions in the package, so a reader
never needs the source log's numbering.

## Importing

An import **writes a stored session**:

```
validate → sessionPersistence.create → append → flush → close
```

Not an in-memory attach. A copy that existed only in the live store would not
be listed by the sidebar (which reads persistence), would disappear on restart,
and would reject its own first message — the resume path opens the id for
write. Writing the log is also the entire rebuild: opening the copy later is
the ordinary resume path.

The copy is filed under a **workspace directory the reader picks**, never one
this code chooses. A header without a directory is filed as invalid, so the
session would exist without ever appearing in the sidebar.

An import starts one of two ways, and the difference is the directory.

| start | first state | directory |
|---|---|---|
| an incoming link | `fetching` | asked, after the preview |
| a Workspace's own menu | `enter-link` | that Workspace, no question |

The menu's row is a `ctx.contextMenus` contribution rather than a slot entry:
the shipped rename and delete rows are built-in ones, and a slot cannot join
them. Its label, its icon (a key in the `contextMenu.icon` slot), and the
import itself are all registered here, so the row behaves like its neighbours
without this package knowing what they do.

`enter-link` holds one control in its content box — the field, with no label
above it and no button beside it — and both of its buttons in the footer row,
in the same seats every other state uses. The field and those buttons are
siblings, so the submit button reaches the form through `form="…"` rather than
by containment. That association has to keep `type="submit"`: a submit button
outside its form is what makes `disabled` suppress Enter, and a `type="button"`
there would submit an empty field (measured in Chrome, field empty and filled).

### Cancelling

Closing the dialog aborts the request, and the abort travels all the way to the
Host: the connection bridge turns a dropped response into `request.signal`, which
the route passes to the service call and to `handle.append`. A cancel during the
download or the upload leaves nothing behind.

An import is the one operation where the timing matters. The persistence
contract has no delete, so a log that has been appended cannot be taken back —
which is why the abort reaches `append` itself rather than being checked after
it. Cancel before that point and no file is written; cancel after it and the
copy exists, because the reader cancelled the dialog rather than the session,
and to a reader the difference is not visible from the card.

## Configuration

| field | meaning |
|---|---|
| `serviceOrigin` | the share service's base URL. Required — there is no built-in value, because the address a conversation is uploaded to is the deployment's decision |

The bundle's `cordis.patch.yml` supplies it and reads
`AISHELL_SHARE_ORIGIN` first, so an operator can point at a staging service
without republishing.

## Files

```
src/index.ts                 Node half: read a session, write an imported one
src/package.ts               the package format, selection and reference rewriting
src/route.ts                 constants and the link admission both halves share
src/service.ts               the service's two HTTP calls
src/version.ts               generated by scripts/write-share-version.mjs
src/client/index.ts          claim, and the surfaces it registers
src/client/open-session.ts   refresh, then navigate to a freshly written session
src/client/machine.ts        the dialog's state machine
src/client/state.ts          its states and pure transitions
src/client/preview.ts        what a reader sees before importing
src/client/SharePreview.tsx  the dialog
src/client/ShareSessionMenuItem.tsx  the sidebar menu row
src/client/locales.ts        dictionary
```

## Further exploration

- [Deep links](../../docs/design/deeplink.md) — the transport this package builds
  on: the vocabulary, the division of responsibility between Host and Page, and
  the acceptance list.