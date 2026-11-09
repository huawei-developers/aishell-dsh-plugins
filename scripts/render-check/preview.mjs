#!/usr/bin/env node
/**
 * Serve the suggestion-card preview so it can be looked at in a browser.
 *
 * The preview loads React from a CDN, which needs an http origin — opening the
 * staged file straight off disk (`file://`) leaves the page blank with nothing
 * in the console to explain why. So this serves the work dir over loopback and
 * opens that.
 *
 * It serves whatever `render:check` last staged, and runs it first when the
 * bundle is missing or older than the source, so the page always shows the
 * built code rather than a stale copy.
 *
 * Usage:
 *   pnpm run render:preview                     # serve and open a browser
 *   pnpm run render:preview -- --no-open        # serve only
 *   pnpm run render:preview -- --port 8174      # serve on another port
 *   PREVIEW_PORT=8174 pnpm run render:preview   # same, via the environment
 *
 * A busy port is reported as a plain sentence rather than a stack trace: the
 * usual cause is a preview already running in another shell, and the useful
 * thing to say is which URL to open instead.
 *
 * @module scripts/render-check/preview
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const WORK = join(REPO, '.render-check')
const BUNDLE = join(REPO, 'packages', 'aishell-brand', 'lib', 'client.js')

/** The port: `--port N` wins, then `PREVIEW_PORT`, then 8173. */
function resolvePort() {
  const flag = process.argv.indexOf('--port')
  const fromArgv = flag === -1 ? undefined : process.argv[flag + 1]
  const raw = fromArgv ?? process.env.PREVIEW_PORT ?? '8173'
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`render-preview: "${raw}" is not a valid port`)
    process.exit(2)
  }
  return port
}

const PORT = resolvePort()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** Run the render check, which stages the work dir from the current build. */
function stage() {
  const result = spawn('node', [join(HERE, 'run.mjs')], {
    cwd: REPO,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  return new Promise((res) => { result.on('exit', (code) => { res(code ?? 1) }) })
}

/** Whether two files hold the same bytes, treating a missing file as unequal. */
function sameContent(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false
  const left = readFileSync(a)
  const right = readFileSync(b)
  return left.equals(right)
}

async function main() {
  // Every input the served page depends on, not just the bundle. The preview
  // page is source too: editing it changes what you see, so a check that only
  // watched the bundle would keep serving the old page and the edit would look
  // like it had no effect.
  //
  // The staged copy is compared by CONTENT against the current bundle, never
  // by mtime. A rebuild can leave the artifact carrying an older timestamp
  // than the source it was built from (tsdown writes it, then the watcher
  // touches the source), and an mtime test then reports "fresh" while the page
  // keeps serving the previous build.
  const stale = !existsSync(BUNDLE)
    || !sameContent(BUNDLE, join(WORK, 'bundle.js'))
    || !sameContent(join(HERE, 'preview.html'), join(WORK, 'preview.html'))
    || !sameContent(join(HERE, 'index.html'), join(WORK, 'index.html'))
    // The generated theme sheet is an input too: it is lifted from the
    // installed DSH, so a version bump upstream changes the palette the page
    // paints. Comparing content catches that without watching mtimes.
    || !existsSync(join(WORK, 'theme.css'))
  if (stale) {
    console.log('render-preview: staging from the current build…')
    const code = await stage()
    if (code !== 0) {
      console.error('render-preview: the render check failed; fix that first')
      process.exit(code)
    }
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const name = path === '/' ? '/preview.html' : path
    // No traversal: the name must stay inside the work dir.
    const file = join(WORK, name)
    if (!file.startsWith(WORK) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })

  // A busy port is the expected failure — the usual cause is a preview left
  // running in another shell — so it gets a sentence, not a stack trace.
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`render-preview: port ${PORT} is already in use.`)
      console.error(`  A preview may already be running there — try http://127.0.0.1:${PORT}/preview.html`)
      console.error(`  Or pick another port: pnpm run render:preview -- --port ${PORT + 1}`)
      process.exit(1)
    }
    console.error(`render-preview: could not start the server: ${error.message}`)
    process.exit(1)
  })

  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/preview.html`
    console.log(`render-preview: ${url}`)
    console.log('  cards auto-rotate every 1.5s; hover to pause. Ctrl+C to stop.')
    if (!process.argv.includes('--no-open')) {
      const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start' : 'xdg-open'
      spawn(opener, [url], { stdio: 'ignore', detached: true }).unref()
    }
  })
}

await main()