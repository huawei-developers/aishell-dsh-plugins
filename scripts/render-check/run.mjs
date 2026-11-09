#!/usr/bin/env node
/**
 * Render the suggestion cards in a real browser and assert what a person
 * would see.
 *
 * The vitest suites around this feature are pure: `carousel.spec.ts` pins the
 * wrap-around arithmetic, and nothing tests the component at all. That is the
 * right split for logic, but it cannot answer the two questions that actually
 * decide whether the feature works — does the component put four cards on
 * screen at the width it claims, and does an arrow move them — because both
 * depend on layout, which only a browser has.
 *
 * So this drives headless Chrome over CDP against the BUILT bundle. It loads
 * `lib/client.js` the way the client loader does (the `__ModuleLoader__.load`
 * factory), mounts the component with stub slot props, and measures the DOM.
 * No test framework and no dependencies: Node 24 ships a global WebSocket, so
 * the CDP client is a few dozen lines here.
 *
 * Usage:
 *   node scripts/render-check/run.mjs               # build first if stale
 *   node scripts/render-check/run.mjs --keep-open   # leave the page up
 *
 * Chrome is located via CHROME_BIN, then the usual names on PATH, then the
 * two macOS bundle paths. It is not vendored: a browser is a large thing to
 * add to a plugin repo, and a machine that cannot run this still runs the
 * whole vitest suite.
 *
 * What this does NOT do: it does not exercise the host. The component is
 * mounted with stub slot props against a stub theme, so it proves the markup
 * and the layout maths, not that DSH dispatches the slot or that the composer
 * accepts the draft. Those need a running host.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const BUNDLE = join(REPO, 'packages', 'aishell-brand', 'lib', 'client.js')
const WORK = join(REPO, '.render-check')
const KEEP_OPEN = process.argv.includes('--keep-open')

/** Find a Chrome to drive. */
function findChrome() {
  if (process.env.CHROME_BIN !== undefined && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN
  }
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return undefined
}

/** Minimal CDP client over one WebSocket. */
class CDP {
  #ws
  #id = 0
  #pending = new Map()

  constructor(url) { this.url = url }

  async connect() {
    this.#ws = new WebSocket(this.url)
    await new Promise((res, rej) => {
      this.#ws.addEventListener('open', res, { once: true })
      this.#ws.addEventListener('error', rej, { once: true })
    })
    this.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const settle = this.#pending.get(msg.id)
      if (settle !== undefined) { this.#pending.delete(msg.id); settle(msg) }
    })
  }

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((res) => {
      this.#pending.set(id, res)
      this.#ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() { this.#ws.close() }
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
  return r.result?.result?.value
}

async function main() {
  const chromeBin = findChrome()
  if (chromeBin === undefined) {
    console.error('render-check: no Chrome found (set CHROME_BIN to point at one)')
    return 1
  }
  if (!existsSync(BUNDLE)) {
    console.error(`render-check: ${BUNDLE} is missing — run \`pnpm run build\` first`)
    return 1
  }

  // Stage the page next to a copy of the bundle the page can fetch. The
  // preview is staged the same way so `preview.html` in the work dir is always
  // the page built against THIS bundle, never a stale copy someone saved.
  mkdirSync(WORK, { recursive: true })
  copyFileSync(join(HERE, 'index.html'), join(WORK, 'index.html'))
  copyFileSync(join(HERE, 'preview.html'), join(WORK, 'preview.html'))
  copyFileSync(BUNDLE, join(WORK, 'bundle.js'))

  // The shell's own theme CSS, staged beside the pages that link it. Both
  // pages paint the real palette rather than a hand-copied subset, so a token
  // the shell defines cannot go missing here and quietly change what the
  // assertions measure. Regenerated every run: it costs milliseconds and a
  // stale copy would defeat the point.
  const themeCss = spawnSync(process.execPath, [join(HERE, 'theme-css.mjs')], {
    cwd: REPO,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  if (themeCss.status !== 0) {
    // Not fatal: the pages still load, and the assertions that depend on the
    // real palette will fail loudly rather than silently measure a lookalike.
    console.error(`render-check: could not regenerate theme.css — ${themeCss.stderr?.toString().trim()}`)
  }

  const port = 9411
  const chrome = spawn(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(WORK, 'profile')}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  let chromeLog = ''
  chrome.stderr.on('data', (d) => { chromeLog += d })

  const cleanup = () => {
    if (!KEEP_OPEN) chrome.kill('SIGKILL')
  }

  try {
    // Wait for the debugging endpoint.
    let up = false
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { up = true; break }
      } catch { /* not up yet */ }
      await sleep(100)
    }
    if (!up) throw new Error(`Chrome never answered on :${port}\n${chromeLog}`)

    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
    const cdp = new CDP(target.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Page.navigate', { url: `file://${join(WORK, 'index.html')}` })

    // The page publishes its results when it finishes.
    let results
    for (let i = 0; i < 150; i++) {
      await sleep(200)
      const raw = await evaluate(cdp, 'JSON.stringify(window.__RESULTS__ ?? null)')
      if (raw !== undefined && raw !== 'null') { results = JSON.parse(raw); break }
    }

    if (results === undefined) {
      const title = await evaluate(cdp, 'document.title')
      const err = await evaluate(cdp, 'String(window.__ERR__ || "")')
      console.error(`render-check: the page published no results (title: ${title})`)
      if (err !== '') console.error(`  page error: ${err}`)
      cdp.close()
      return 1
    }

    let failed = 0
    for (const r of results) {
      if (!r.ok) failed++
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${String(r.name).padEnd(52)} ${r.detail ?? ''}`)
    }
    console.log(failed === 0
      ? `\nrender-check: ${results.length} checks passed`
      : `\nrender-check: ${failed} of ${results.length} checks FAILED`)

    if (KEEP_OPEN) console.log(`\nleft open on http://127.0.0.1:${port} (--keep-open)`)
    cdp.close()
    return failed === 0 ? 0 : 1
  } finally {
    if (!KEEP_OPEN) {
      chrome.kill('SIGKILL')
      rmSync(join(WORK, 'profile'), { recursive: true, force: true })
    }
  }
}

process.exit(await main())