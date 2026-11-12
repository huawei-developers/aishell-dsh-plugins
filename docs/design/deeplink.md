# Deep links

How a URL handed to AI Shell by the operating system reaches the plugin that
knows what to do with it.

---

## 1. What this is

A user receives a link in a chat application:

```
aishell://share/abc123
```

Clicking it raises the Desktop application and shows a preview of a shared
session. More link families follow: `aishell://connect/…`, `aishell://import/…`,
others.

Two facts shape the design:

- **The plugin set grows independently of the host.** A new link family must not
  require a host release.
- **Only the main process can talk to the operating system.** Protocol
  registration, command-line parsing and single-instance routing live there, and
  no plugin can reach it.

The split that follows: the host owns everything up to *"here is a string the OS
gave us"*, and a plugin owns everything after it.

---

## 2. Vocabulary

Five things are involved, and mixing their names is the fastest way to misread
this document.

| Term | What it is | What it is **not** |
|---|---|---|
| **Desktop application** | The Electron application as a whole | not the Page, not the Host |
| **Main process** | Electron's main process: OS integration, protocol registration, IPC | plugins never run here |
| **Host** | A child process the main process spawns: the cordis plugin tree and its HTTP server | not the main process, not a separate application |
| **Page** | The one web document rendered inside the application's `BrowserWindow`, loaded from `dsh-app://app/` | not an external browser tab |
| **Browser** | An ordinary external browser, used only in the `aishell web` deployment | never the Page |

```
Desktop application
├── Main process          Node      OS integration, protocol registration, IPC
├── Host                  Node      cordis plugin tree, HTTP server, persistence
└── Page                  Chromium  dsh-app://app/ — the UI; client plugins run here
```

| Deployment | UI runs in | `aishell://` registered | Deep links reach it |
|---|---|---|---|
| **Desktop application** | the Page | yes | **yes** |
| **`aishell web`** | an external Browser | **no** | no |

Everything here is about the Desktop application. The `aishell web` deployment
registers no scheme and therefore has no deep links at all.

---

## 3. The division of responsibility

The Host must not interpret a URL. It must not know the word `share`, what the
rest of a path means, or which families exist. Its whole responsibility is:

> Deliver the URL, unmodified, to whoever claims the `deepLinks` service. If
> nobody claims it, hold it until somebody does.

Everything else — parsing, routing, what to show — belongs to a plugin. A host
that starts interpreting paths becomes a second, competing router, and the two
will drift.

**The Host cannot show anything anyway.** It is a plain Node process: the string
`BrowserWindow` does not appear in it at all. What the Host could do on its own
is write a log line — while the user sees nothing.

```
Main process   has windows, registers the scheme   → hands the URL in
Host           has the plugin tree and services     → hands it to deepLinks
Plugin         has React, has Modal                 → parses, decides, shows
```

The meaning of a URL and the UI that acts on it live in the same place.

---

## 4. The URL

`aishell://share/abc123` parses as follows — measured, not assumed:

| component | value |
|---|---|
| `url.protocol` | `aishell:` |
| `url.hostname` | `share` |
| `url.pathname` | `/abc123` |
| `url.search` | `` (empty here) |

**The first segment after `//` is `hostname`, not part of the path.** This is the
most common mistake when writing a handler; `url.pathname` does not contain it.

```ts
/** One admitted link. */
interface DeepLink {
  /** Lowercase hostname segment, e.g. `share`. */
  readonly family: string
  /** The complete URL, canonical, fragment removed. */
  readonly href: string
}
```

Conventions:

- The first segment is the **link family**: lowercase and short — `share`,
  `connect`, `import`. The plugin that claims it chooses the name.
- By convention a family carries its state in the **path** —
  `aishell://share/abc123` — because a path survives copy-paste and length limits
  better than a query string. This transport does not enforce it: a query is
  preserved and reaches the handler, which decides what it means.
- A **fragment is discarded** before dispatch, by the transport.
- A non-special scheme does **not** normalise host case. `https://X.COM`
  becomes `x.com`, but `aishell://Share/x` keeps `Share`, so both sides compare
  `hostname.toLowerCase()`.
- A malformed string throws `TypeError` from `new URL()`. That means *drop it*,
  never *report an error* — the sender may be a plugin version this build does
  not know.

Admission is these rules and nothing else:

```ts
function admit(raw: string): DeepLink | undefined {
  let url: URL
  try { url = new URL(raw) } catch { return undefined }
  if (url.protocol !== 'aishell:') return undefined
  const family = url.hostname.toLowerCase()
  if (family === '') return undefined
  url.hash = ''
  return { family, href: url.href }
}
```

---

## 5. The interface

### 5.1 Host → plugin

One service, one method.

```ts
interface DeepLinks {
  /**
   * Accept one URL the operating system handed to the shell.
   *
   * The caller passes the string through untouched: this side is where it is
   * first parsed. A URL this transport does not own is dropped.
   *
   * @param raw - the URL exactly as received, e.g. `aishell://share/abc123`.
   */
  deliver(raw: string): void
}
```

Provided by `@huaweidevtools/aishell-dsh-deeplink`, consumed by the desktop
shell's Host half.

**The host's only obligation is to pass the string through unmodified:** no
pre-parsing, no trimming, no case folding, no routing by family. Whatever
arrives is what `deliver` receives.

`deliver` is safe to call at any time. Before the plugin tree has assembled, or
while no Page is connected, the plugin holds the URL itself — the host needs no
readiness handshake. The only thing the host must buffer on its own is the span
before the Host child process exists (see §6.3).

### 5.2 Plugin → link family

```ts
interface AishellDeepLinks {
  /**
   * Claim one link family.
   * @param family - the URL hostname segment, lowercase, e.g. 'share'.
   * @param handler - invoked for every URL carrying that hostname, including
   *   ones that arrived before this claim.
   * @returns disposer that releases the claim.
   */
  claim(family: string, handler: (url: URL) => void): () => void
}
```

```ts
ctx.inject(['aishellDeepLinks'], (scope) => {
  ctx.effect(() => scope.aishellDeepLinks.claim('share', (url) => {
    openPreview(url.href)
  }), 'my-plugin: deep link')
})
```

The handler receives the whole URL and decides what parts of it mean anything.
The transport does not parse it — the shape of an `aishell://share/...` belongs
to whoever mints those links, and a handler that reshaped it there would be
inventing a grammar the issuer never agreed to.

- One family has one claimant; a second claim of the same family throws.
- A URL that arrives before the claim is delivered on the claim, in arrival
  order.
- The disposer releases the family, and a later claim may take it.
- A handler shows a preview. It does not act: see §8.

---

## 6. Host implementation

### 6.1 What the shell must do

**Register the scheme.**

```js
app.setAsDefaultProtocolClient('aishell', process.execPath, ['--open-url', '--'])
```

The third argument is what the OS appends when invoking the program for a URL.
Without it, Linux invokes the binary with the URL alone and nothing looks for it.

**Packaged Linux must not call this** — the registration points the handler at
the bare binary and overwrites what the installer wrote. The installer's
`.desktop` is the authority there.

| Deployment | Registration |
|---|---|
| **Packaged Linux** | **no call** — the installer's `.desktop` only |
| Development Linux | call it |
| macOS / Windows | call it |

**Receive the URL from three entry points.**

```js
const findUrl = (argv) => argv.find((arg) => arg.startsWith('aishell://'))

// macOS delivers URLs as an event, possibly before `ready`. The listener must
// exist during launch, not inside an async boot function.
app.on('will-finish-launching', () => {
  app.on('open-url', (event, url) => {
    event.preventDefault()
    deliverToHost(url)
  })
})

// A second launch while one is running: its argv arrives here.
app.on('second-instance', (_event, argv) => {
  focusPrimaryWindow()
  const url = findUrl(argv)
  if (url !== undefined) deliverToHost(url)
})

// Cold start: the URL is in our own argv.
const initialUrl = findUrl(process.argv)
```

**Exit the losing instance without unwinding it.**

```js
if (!application.requestSingleInstanceLock()) {
  application.exit(0)
  return false
}
```

`exit(0)`, not `quit()`. That process owns nothing — no window, no Host child,
no open file — so there is no lifecycle to unwind. `quit()` runs the quit hooks,
and `before-quit` calls `event.preventDefault()` to ask the user to confirm.
The loser is not a second application: it creates no window and lives for
milliseconds.

### 6.2 Linux registration

Write a dedicated desktop entry and point it at the **binary**, not the wrapper
script. The wrapper runs an update check on every launch and exits early when
another instance is alive — both wrong for a URL hand-off.

```ini
[Desktop Entry]
Name=AI Shell - URL Handler
Exec=/path/to/@deepseek-aidsh-desktop --no-sandbox --open-url -- %U
Type=Application
NoDisplay=true
MimeType=x-scheme-handler/aishell;
```

Verify after installing:

```sh
xdg-mime query default x-scheme-handler/aishell   # prints the .desktop name
```

### 6.3 Handing the URL to the Host

The main process and the Host are separate processes joined by Node IPC
(`stdio: [..., 'ipc']`). One message type, alongside the existing ones:

```js
// main process
sendDeepLink(url) {
  if (this.child?.connected) this.child.send({ type: 'deep-link', url })
}

// Host child, in its existing `process.on('message')` dispatch
if (message.type === 'deep-link' && typeof message.url === 'string') {
  deliverDeepLink(ctx, message.url)
  return
}
```

The Host buffers only while the service is absent, because the URL can arrive
while the plugin tree is still assembling:

```js
const queue = []
let service

ctx.inject(['deepLinks'], (scope) => {
  service = scope.deepLinks
  for (const url of queue.splice(0)) service.deliver(url)
  scope.effect(() => () => { service = undefined })
})

function deliverDeepLink(ctx, url) {
  if (service !== undefined) service.deliver(url)
  else queue.push(url)
}
```

The main process buffers separately, for the span before the Host child exists:

```js
let pendingDeepLink

function deliverToHost(url) {
  const host = backend.host          // undefined before ready
  if (host !== undefined) host.sendDeepLink(url)
  else pendingDeepLink = url
}
```

Flush `pendingDeepLink` once the Host reports ready.

---

## 7. Plugin implementation — `aishell-dsh-deeplink`

The transport. Two halves, no UI.

| half | where it runs | responsibility |
|---|---|---|
| Host half | the Host | provide `deepLinks`; hold URLs no Page has taken yet; stream them to the Page |
| Page half | the Page | open the stream; dispatch each URL to the plugin that claimed its family |

### 7.1 Delivery is pushed, not polled

A design where the Page fetches whenever the window gains focus fails in two
ordinary cases.

**The window already has focus.** The user clicks the link while the application
is in front. `focusPrimaryWindow()` calls `window.focus()` on a window that
already has it, so no `focus` event fires and nothing fetches. The URL stays in
the queue and no preview appears.

**The IPC hop loses a race.** Forwarding to the Host is asynchronous
process-to-process messaging; focusing the window is synchronous. A fetch
triggered by focus can run *before* the Host has queued the URL, receive an empty
answer, and never ask again.

Neither is rare: the second is the normal path. A push channel removes both.

### 7.2 Host half: a server-sent-events stream

Every link in the path supports a streaming response — measured:

| Link | Evidence |
|---|---|
| A `fetch` route may return a streamed body | `for await (const chunk of response.body)` in `client-connection/lib/index.js:95` |
| The main process forwards the Page's request to the Host | `new Response(response.body, …)` in `main.js:16396` |
| The `dsh-app` scheme may stream | `stream: true` in `main.js:20553` |
| The Page can consume it | same-origin `EventSource`, cookie-authenticated like any `/api` call |

**The stream emits its first byte before it has a link to carry.** A response is
not delivered to the client until that byte arrives, so an idle stream would
never report open and a later push would have nowhere to go. An SSE comment
frame costs nothing — the parser ignores it — and makes the connection real.

```ts
interface Stream {
  readonly controller: ReadableStreamDefaultController<Uint8Array>
}

/** Upper bound on URLs held while no Page is connected. */
const MAX_PENDING = 16

const streams = new Set<Stream>()
const pending: DeepLink[] = []
const OPENING_FRAME = new TextEncoder().encode(': open\n\n')

const frame = (link: DeepLink) =>
  new TextEncoder().encode(`data: ${JSON.stringify({ url: link.href })}\n\n`)

ctx.provide('deepLinks', {
  deliver(raw: string) {
    // Admission is scheme + non-empty host only. There is no claim registry
    // here: claims live in the Page, which this process cannot see, so
    // filtering by family would drop links the Page would accept.
    const link = admit(raw)
    if (link === undefined) { log.warn(`dropped a URL this transport does not own: ${raw}`); return }

    if (streams.size === 0) {
      pending.push(link)
      if (pending.length > MAX_PENDING) pending.shift()   // evict oldest
      return
    }
    const payload = frame(link)
    for (const stream of streams) {
      try { stream.controller.enqueue(payload) } catch { streams.delete(stream) }
    }
  },
})

ctx.effect(() => ctx.connection.fetch.register({
  path: '/api/aishell/deep-link',
  methods: ['GET'],
  requestBody: 'buffered',
  fetch: (request) => {
    let stream: Stream
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = { controller }
        controller.enqueue(OPENING_FRAME)
        streams.add(stream)
        while (pending.length > 0) {
          const link = pending.shift()
          if (link === undefined) break
          controller.enqueue(frame(link))
        }
      },
      cancel() { streams.delete(stream) },
    })
    request.signal.addEventListener('abort', () => {
      streams.delete(stream)
      try { stream.controller.close() } catch { /* already closed */ }
    })
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
  },
}), 'aishell-deeplink: stream route')
```

### 7.3 Page half: one `EventSource`

```ts
const claims = new Map<string, (url: URL) => void>()

/** Upper bound on URLs held until a plugin claims their family. */
const MAX_WAITING = 16

const waiting: DeepLink[] = []

const dispatch = (link: DeepLink) => {
  const handler = claims.get(link.family)
  if (handler !== undefined) { handler(new URL(link.href)); return }
  waiting.push(link)                    // the owning plugin has not claimed yet
  if (waiting.length > MAX_WAITING) waiting.shift()   // evict oldest
}

ctx.effect(() => {
  const source = new EventSource('api/aishell/deep-link')
  source.addEventListener('message', (event) => {
    const link = admit(JSON.parse(event.data).url ?? '')
    if (link !== undefined) dispatch(link)
  })
  // EventSource reconnects on its own; no error handler is needed.
  return () => source.close()
}, 'aishell-deeplink: stream')

ctx.provide('aishellDeepLinks', {
  claim(family, handler) {
    const key = family.toLowerCase()
    if (claims.has(key)) throw new Error(`deep link family "${key}" is already claimed`)
    claims.set(key, handler)
    const replayed = waiting.filter((link) => link.family === key)
    for (const link of replayed) {
      const index = waiting.indexOf(link)
      if (index >= 0) waiting.splice(index, 1)
      handler(new URL(link.href))       // forward, so arrival order is kept
    }
    return () => { if (claims.get(key) === handler) claims.delete(key) }
  },
})
```

The Page half declares no required services: `EventSource` needs only the page's
own origin, and gating activation on the RPC transport would delay the stream
for a service nothing there calls.

**There is exactly one Page.** `mainWindow` is a singleton, so `streams` normally
holds one entry. A reload briefly leaves a stale one until `request.signal`
aborts it; the `enqueue` failure guard covers that gap.

---

## 8. Buffers and ordering

Four buffers, each covering a gap the others cannot. They cannot be merged: the
time points are independent.

| # | Buffer | Covers |
|---|---|---|
| 1 | Main process: `pendingDeepLink` | the Host child has not been spawned |
| 2 | Host: `queue` in `deliverDeepLink` | the plugin tree is still assembling |
| 3 | Host half: `pending[]` | no Page is connected |
| 4 | Page half: `waiting[]` | the owning plugin has not claimed |

Buffers 3 and 4 keep the newest entries: a user who clicked five links wants the
last one.

### 8.1 Extreme behaviour, stated

These buffers are the only mutable state the transport owns, so what they do
under pressure is part of the contract, not an implementation detail.

| Buffer | Bound | Full behaviour |
|---|---|---|
| 1 — `pendingDeepLink` (main process) | 1 | **newest wins**: a later URL replaces an undelivered one |
| 2 — `queue` (Host) | 16 | **oldest evicted**, one warning logged |
| 3 — `pending[]` (Host half) | 16 | **oldest evicted** |
| 4 — `waiting[]` (Page half) | 16 | **oldest evicted** |

**Why eviction and not rejection.** A user who clicks five links in a row wants
the last one; refusing the fifth keeps the four they no longer care about.
Eviction matches what a person means by clicking again.

**The cost of eviction, stated plainly.** A flood can push a legitimate link out
before its plugin arrives. Nothing in this transport can tell a flood from a
burst of real clicks: recognising a URL as legitimate requires knowing the
family, and the family's owners live in the Page — the reason the Host does not
filter by family at all (§7.2). So the defence is a bounded buffer, not a
classification, and the bound is what converts "unbounded memory growth" into
"some links are lost". The process surviving matters more than every link
arriving: this plugin runs inside the Host, and a Host that dies takes the whole
application with it.

**Why 16, and why not one number copied across.** Each buffer covers a different
span of time, so the same number holds a different amount of history in each:

| Buffer | The span it covers | What its bound has to survive |
|---|---|---|
| 1 | Host child spawn → ready | one URL; a launch carries one, so 1 |
| 2 | plugin tree assembly | a burst during startup — seconds |
| 3 | Host ready → the Page's stream connects | a burst during startup — seconds |
| 4 | the Page is loaded → a plugin claims | milliseconds |

Each number follows from its own window:

- **Buffer 1 is 1** because the span carries a single URL by construction.
- **Buffers 2 and 3 cover seconds.** A person clicking through a burst of links
  produces a handful, so a bound in the teens is comfortable and still far below
  anything the process would notice.
- **Buffer 4 covers milliseconds.** No real user produces more than one or two
  entries there, so its bound is not a tuned limit at all — it exists only to
  keep a family that is never claimed from growing without end.

The three numbers happen to coincide; they are not derived from one another.
Changing one is a decision about that buffer's window alone.

**Buffer 4 needs no age-out policy.** `waiting[]` drains on the claim of each
family, so it holds only families no plugin has ever claimed. An entry leaves
when its family is claimed, or when the bound passes it. Load order is the
reason it exists at all, and that is a bounded-time event: either the plugin
loads within the window, or it is not in this profile.

**Cold start — the application is not running**

```
user clicks the link
  the OS runs the URL handler → a main process starts
  argv contains the URL → pendingDeepLink                  [1]
  the lock is acquired → whenReady → main() → backend.start()
  the Host child spawns → the plugin tree loads → deepLinks provided
  the Host reports ready → flush pendingDeepLink over IPC  [1 empties]
  the Host queues the URL                                 [2]
  the plugin tree finishes → deepLinks delivered → pending[]   [3]
  the main process creates the Page
  the Page loads → EventSource connects → pending[] is flushed
  the client half dispatches → the owning plugin has claimed → preview
```

**Already running — a second main process exists only to hand over**

```
user clicks the link
  the OS runs the URL handler → a second main process starts
  requestSingleInstanceLock() fails → exit(0)   (no window, milliseconds)
  Electron hands its argv to the owner → 'second-instance' fires
  focusPrimaryWindow() + sendDeepLink(url)
  a Page is connected → the stream delivers it immediately
  the client half dispatches → preview
```

Both paths converge at the Page half's `dispatch`. There is one code path after
the URL reaches the Host.

---

## 9. Why nothing is automatic

A deep link is triggered by content the user did not author — a chat message, a
page in an external Browser. It must never install, enable or execute anything
on its own.

The contract enforces this by construction:

- The host only forwards a string; it has no action vocabulary.
- A handler shows a preview; the user confirms the import.
- An unclaimed family is held only inside the bounded queue of §8, and
  dispatched the moment its plugin claims it — so a plugin that loads after the
  Page still receives what arrived early. A family no plugin ever claims is
  dropped when the queue passes its bound.

That split is deliberate: a link is an invitation, not a pending task. It is
held long enough to survive plugin load order, and no longer — so a family added
later does not act on a request the user made days ago.

**Automatic plugin installation is out of scope.** Enabling it would mean a link
from any page in any external Browser can cause an install followed by loading
third-party code into the Host at full Node privilege. That needs a
trusted-registry allowlist, a pre-install confirmation, and not enabling on
completion; none of those exist. Until they do, a missing plugin produces a log
line, not an install.

---

## 10. Acceptance

The chain is proven only when each of these is observed. Exit codes are not
evidence.

| # | Action | Expected |
|---|---|---|
| 1 | `xdg-mime query default x-scheme-handler/aishell` | prints the handler's desktop file name |
| 2 | Click the link with the application closed | it starts, the preview appears without further interaction |
| 3 | Click the link with the window behind another app | the application rises, the preview appears |
| 4 | Click the link with the application **already in front** | the preview appears — *the case a pull-on-focus design cannot pass* |
| 5 | Click twice | two previews |
| 6 | Click `aishell://unknown/x` | no preview, no crash; a plugin claiming `unknown` afterwards receives nothing |
| 7 | Click a non-URL string, or `aishell://` with no host | dropped silently by the transport |
| 8 | Uninstall `aishell-dsh-deeplink`, click a link | the application runs normally, one log line, no hang |
| 9 | Reload the Page after a preview | it does not re-open — the URL was consumed |

Two behaviours come from Electron documentation and were **not** measured here.
Confirm them first, since everything else depends on them:

- that `second-instance` receives the URL in `argv` on Linux;
- that the third argument to `setAsDefaultProtocolClient` produces a working
  handler on this platform.

---

## 11. Design notes

**Why the family is short.** A package name would make families unique by
construction and let the receiver identify the package — `aishell://huaweidevtools.aishell-dsh-share/abc`.
Its only real payoff is automatic installation, which is out of scope, and it
lengthens every user-facing link from 28 to 62 characters. Short names are kept.

**Why there is no host-side authority table.** It would put every new link
family behind a host release, contradicting §1. It would also duplicate routing
that already exists in the Page.

**Why the stream is a `fetch` route.** `ctx.typertGateway.registerRemoteEvents`
is the framework's own forwarded-event channel and the right shape — it manages
connection, reconnection and peer scope. A plugin cannot use it: the gateway
accepts exactly one source and refuses a second, `@deepseek-ai/dsh-api-remotes`
already holds that seat, and the events it forwards are a hard-coded list. A
composable forwarded-event channel would need upstream support. Until then a
plugin that must push to the Page writes its own stream, which the route
registry explicitly supports ("exact Fetch routes for streaming or
browser-native responses") and the HTTP bridge forwards chunk by chunk.

---

## 12. Future: a socket hand-off

The design above starts a whole main process to deliver one string. It finds the
lock taken and exits — correct, but heavy.

The improvement changes only the first hop: **a short-lived Node process writes
the URL to a socket owned by the running instance.** Every other layer — the
lock, the IPC hop, the buffers, the stream to the Page — stays exactly as
described.

```
Windows : \\.\pipe\aishell-<hash>-<user>-<session>
Linux   : $XDG_RUNTIME_DIR/aishell-<hash>-<u4>-<s6>.sock
macOS   : not needed — `open-url` already works there
```

`$XDG_RUNTIME_DIR` over `/tmp` because it is `0700` and per-session; `/tmp` is
`1777` and its paths can be pre-empted. The path must be checked against
`sun_path` — 108 bytes on Linux, 104 on macOS — which is why the name is a short
hash rather than a path. A stale socket file from a `SIGKILL`ed process blocks
`listen()`; remove it and retry on `EADDRINUSE`, since the lock already proves no
other process owns it. The handler needs one branch: try the socket, and on
`ENOENT` launch the application normally.

That handler is written by the installer, and a runtime
`setAsDefaultProtocolClient` would overwrite it — demoting the socket hand-off to
a full launch, with no error. The registration table in §6.1 settles it:
packaged Linux does not call the runtime registration, whether or not this
section is ever built.

**Not built. Recorded so that a later change to §6 does not foreclose it.**