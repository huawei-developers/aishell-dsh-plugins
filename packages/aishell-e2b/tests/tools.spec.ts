/**
 * The tools: what each one calls, and the two conversions that matter most.
 *
 * The first is `CommandExitError`. The SDK's foreground `run` rejects when a
 * command exits non-zero, carrying the exit code and both streams. A tool that
 * let that rejection through would report "the tool failed" for what is really
 * "the command ran and returned 1" — the ordinary outcome of a failing test, a
 * compile error, or a `grep` with no match. The model would then retry a
 * command that had already answered.
 *
 * The second is the missing-sandbox failure. There is exactly one sandbox per
 * conversation, so a tool has nothing to guess — but it does have to
 * distinguish "this conversation never had one" from "it had one and it is
 * gone", because only the second means the work is unrecoverable.
 *
 * The rest pins the correspondence the plugin exists to keep: each tool drives
 * the SDK method of the same name, with the same parameters, so someone reading
 * the E2B documentation finds no surprises here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

/** Calls the stub sandbox recorded, by method name. */
let calls: Array<{ method: string, args: unknown[] }> = []
/** What the stub's next command run does. */
let commandBehavior: 'ok' | 'exit-nonzero' | 'throw' = 'ok'
/** The exit code a non-zero run reports. */
let exitCode = 1
/** Whether a filesystem is mounted for the download tool. */
let hasFs = true
/** Sandboxes the gateway reports for a metadata query. */
let recoverable: Array<{ sandboxId: string, state: string }> = []
/** Whether the bound sandbox's connection fails as if it were gone. */
let handleIsGone = false
/** Body `files.read` reports, when a spec needs bytes that are not text. */
let bytesBody: Uint8Array | undefined
/** Stdout the stub's next successful command run reports, when it is not `ok\n`. */
let stdoutOverride: string | undefined
/** Pid `commands.kill` reports as already gone. */
let alreadyGonePid = -1

interface StubSandbox {
  sandboxId: string
  getInfo: () => Promise<unknown>
  kill: () => Promise<void>
  setTimeout: (ms: number) => Promise<void>
  getHost: (port: number) => string
  commands: {
    run: (cmd: string, opts?: unknown) => Promise<unknown>
    kill: (pid: number, opts?: unknown) => Promise<boolean>
  }
  files: {
    write: (path: string, data: unknown) => Promise<unknown>
    read: (path: string, opts?: unknown) => Promise<unknown>
    list: (path: string, opts?: unknown) => Promise<unknown>
  }
}

/** An error shaped like the SDK's `SandboxNotFoundError`. */
function sandboxGone(): Error {
  const error = new Error('sandbox not found')
  Object.defineProperty(error, 'constructor', { value: { name: 'SandboxNotFoundError' } })
  return error
}

/** A sandbox whose every method records its call. */
function makeSandbox(id: string): StubSandbox {
  return {
    sandboxId: id,
    getInfo: async () => {
      calls.push({ method: 'getInfo', args: [] })
      if (handleIsGone) throw sandboxGone()
      return {
        sandboxId: id,
        templateId: 'base',
        state: 'running',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        endAt: new Date('2026-01-01T00:05:00Z'),
        cpuCount: 2,
        memoryMB: 512,
        envdVersion: '0.6.10',
        metadata: {},
      }
    },
    kill: async () => {
      calls.push({ method: 'kill', args: [] })
      if (handleIsGone) throw sandboxGone()
    },
    setTimeout: async (ms: number) => {
      calls.push({ method: 'setTimeout', args: [ms] })
      if (handleIsGone) throw sandboxGone()
    },
    getHost: (port: number) => {
      calls.push({ method: 'getHost', args: [port] })
      return `${port}-${id}.example.test`
    },
    commands: {
      run: async (cmd: string, opts?: unknown) => {
        calls.push({ method: 'commands.run', args: [cmd, opts] })
        if (handleIsGone) throw sandboxGone()
        if (commandBehavior === 'throw') throw new Error('boom')
        if ((opts as { background?: boolean } | undefined)?.background === true) {
          return { pid: 4242 }
        }
        if (commandBehavior === 'exit-nonzero') throw commandExitError(exitCode, 'out text', 'err text')
        return { exitCode: 0, stdout: stdoutOverride ?? 'ok\n', stderr: '' }
      },
      kill: async (pid: number, opts?: unknown) => {
        calls.push({ method: 'commands.kill', args: [pid, opts] })
        if (handleIsGone) throw sandboxGone()
        // The SDK answers false for a pid that was already gone.
        return pid !== alreadyGonePid
      },
    },
    files: {
      write: async (path: string, data: unknown) => {
        calls.push({ method: 'files.write', args: [path, data] })
        if (handleIsGone) throw sandboxGone()
        return { path }
      },
      read: async (path: string, opts?: unknown) => {
        calls.push({ method: 'files.read', args: [path, opts] })
        if (handleIsGone) throw sandboxGone()
        const asBytes = (opts as { format?: string } | undefined)?.format === 'bytes'
        // A queued body models the download tool, which reads bytes and
        // decides what they are. Without one, a byte read answers the small
        // binary the base64 spec expects and a text read answers normally.
        if (asBytes) return bytesBody ?? new Uint8Array([104, 105])
        return bytesBody === undefined ? 'file body' : new TextDecoder().decode(bytesBody)
      },
      list: async (path: string, opts?: unknown) => {
        calls.push({ method: 'files.list', args: [path, opts] })
        if (handleIsGone) throw sandboxGone()
        return [
          { name: 'a.txt', path: '/w/a.txt', type: 'file', size: 3 },
          { name: 'sub', path: '/w/sub', type: 'dir' },
        ]
      },
    },
  }
}

/** An error shaped like the SDK's `CommandExitError`. */
function commandExitError(code: number, stdout: string, stderr: string): Error {
  const error = new Error(`exit ${code}`)
  Object.assign(error, { exitCode: code, stdout, stderr })
  Object.defineProperty(error, 'constructor', { value: { name: 'CommandExitError' } })
  return error
}

vi.mock('e2b', () => ({
  Sandbox: {
    create: async (a: unknown, b?: unknown) => {
      const opts = (typeof a === 'string' ? b : a) as Record<string, unknown>
      calls.push({ method: 'create', args: [typeof a === 'string' ? a : undefined, opts] })
      return makeSandbox(`sbx-${calls.length}`)
    },
    connect: async (id: string) => {
      calls.push({ method: 'connect', args: [id] })
      return makeSandbox(id)
    },
    list: (opts?: { query?: { metadata?: Record<string, string> } }) => {
      calls.push({ method: 'list', args: [opts] })
      return {
        nextItems: async () => recoverable.map(row => ({
          ...row,
          templateId: 'base',
          startedAt: new Date('2026-01-01T00:00:00Z'),
          endAt: new Date('2026-01-01T00:05:00Z'),
        })),
      }
    },
  },
}))

const { MemoryBackend } = await import('@huaweidevtools/aishell-dsh-credentials-store')
const { SandboxClient } = await import('../src/client.ts')
const { SandboxKeySource } = await import('../src/sandbox-key.ts')
const { SandboxRegistry } = await import('../src/sandbox-registry.ts')
const { registerSandboxTools } = await import('../src/tools.ts')
const { SandboxToolError } = await import('../src/errors.ts')

/** The tool definitions the plugin registered, by name. */
let tools: Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }> = new Map()
/** Files written through the stub filesystem. */
let fsWrites: Array<{ path: string, text: string }> = []
/** Every `fs.resolve` call, so a spec can see the cwd a tool anchored at. */
let resolveCalls: Array<{ path: string, cwd: string | undefined }> = []
/** The session directory the working-directory service reports; `null` = no service. */
let sessionCwd: string | null = '/work/project'
/** The registry the tools resolve through. */
let registry: InstanceType<typeof SandboxRegistry>

beforeEach(() => {
  calls = []
  commandBehavior = 'ok'
  stdoutOverride = undefined
  exitCode = 1
  hasFs = true
  fsWrites = []
  resolveCalls = []
  sessionCwd = '/work/project'
  recoverable = []
  handleIsGone = false
  bytesBody = undefined
  alreadyGonePid = -1
  tools = new Map()

  const keys = new SandboxKeySource({
    baseUrl: 'https://openapi.example.test',
    readCredentials: () => ({ ak: 'AK1', sk: 'SK1' }),
    store: new MemoryBackend(),
    fetchImpl: async () => Response.json({ api_key: 'sk-e2b-1' }, { status: 201 }),
    timeoutMs: 5_000,
  })
  const client = new SandboxClient({
    resolveDomain: () => 'aishell.example.test',
    keys,
    resolveRequestTimeoutMs: () => 30_000,
  })
  registry = new SandboxRegistry((metadata, signal) => client.findByMetadata(metadata, signal))

  const fs = {
    // Records the resolution options so a spec can assert the cwd the tool
    // anchored at — the whole point of the working-directory fix.
    resolve: async (path: string, opts?: { cwd?: string }) => {
      resolveCalls.push({ path, cwd: opts?.cwd })
      return { displayPath: path }
    },
    processPath: (target: { displayPath: string }) => target.displayPath,
    writeText: async (target: { displayPath: string }, text: string) => {
      fsWrites.push({ path: target.displayPath, text })
      return {}
    },
  }

  /** Minimal context exposing only what tool registration touches. */
  const ctx = {
    tools: {
      register: (definition: { name: string }) => {
        tools.set(definition.name, definition as never)
        return () => { tools.delete(definition.name) }
      },
    },
    get: (name: string) => (name === 'fs' && hasFs ? fs : undefined),
  }

  registerSandboxTools(ctx as never, {
    client,
    registry,
    resolveFs: () => (hasFs ? fs as never : undefined),
    // The session's directory, as the real service would report it. `sessionCwd`
    // is null when the spec wants the service absent.
    resolveWorkingDirectory: () => (sessionCwd === null
      ? undefined
      : { ensure: async () => sessionCwd as string }),
  })
})

/** An execution context carrying a session, as the agent loop supplies one. */
function exec(sessionId = 's1'): unknown {
  return { signal: new AbortController().signal, agent: { session: { id: sessionId } } }
}

/** Create a sandbox in the given conversation, binding it there. */
async function withSandbox(sessionId = 's1'): Promise<void> {
  await tools.get('aishell__sandbox_create')!.execute({}, exec(sessionId))
}

/** The arguments of the first recorded call to a method. */
function argsOf(method: string): unknown[] {
  const call = calls.find(entry => entry.method === method)
  if (call === undefined) throw new Error(`no call to ${method}`)
  return call.args
}

describe('the registered toolset', () => {
  it('registers every sandbox capability under its SDK name', () => {
    expect([...tools.keys()].sort()).toEqual([
      'aishell__sandbox_commands_kill',
      'aishell__sandbox_commands_run',
      'aishell__sandbox_create',
      'aishell__sandbox_files_download',
      'aishell__sandbox_files_list',
      'aishell__sandbox_files_read',
      'aishell__sandbox_files_write',
      'aishell__sandbox_get_port_url',
      'aishell__sandbox_info',
      'aishell__sandbox_kill',
      'aishell__sandbox_list',
      'aishell__sandbox_set_timeout',
    ])
  })

  it('exposes no sandboxId parameter but on the create tool', () => {
    // The whole point of the one-to-one binding: no tool can be pointed at the
    // wrong sandbox, because no tool names one.
    for (const [toolName, definition] of tools) {
      const parameters = (definition as unknown as { parameters: { properties?: Record<string, unknown> } })
        .parameters.properties ?? {}
      if (toolName === 'aishell__sandbox_create') continue
      expect(Object.keys(parameters)).not.toContain('sandboxId')
    }
    const createProps = (tools.get('aishell__sandbox_create') as unknown as {
      parameters: { properties?: Record<string, unknown> }
    }).parameters.properties ?? {}
    expect(Object.keys(createProps)).not.toContain('sandboxId')
  })
})

describe('aishell__sandbox_create', () => {
  it('creates with the parameters it was given', async () => {
    const result = await tools.get('aishell__sandbox_create')!.execute({
      template: 'node',
      timeoutMs: 300_000,
      envs: { A: '1' },
      metadata: { client: 'test' },
    }, exec())

    expect(result).toMatchObject({ sandboxId: 'sbx-1', state: 'running' })
    const [template, opts] = argsOf('create')
    expect(template).toBe('node')
    expect(opts).toMatchObject({
      timeoutMs: 300_000,
      envs: { A: '1' },
      metadata: { client: 'test', 'aishell-session': 's1' },
    })
  })

  it('binds the sandbox to the conversation', async () => {
    await tools.get('aishell__sandbox_create')!.execute({}, exec('s1'))

    // No sandboxId passed: the write resolves to the bound sandbox.
    await tools.get('aishell__sandbox_files_write')!.execute({ path: '/w/a.txt', content: 'x' }, exec('s1'))

    expect(argsOf('files.write')[0]).toBe('/w/a.txt')
  })

  it('tags the sandbox with its conversation even when no labels were given', async () => {
    // The tag is what a restarted process rediscovers the sandbox by, so it is
    // not optional decoration.
    await tools.get('aishell__sandbox_create')!.execute({}, exec('s1'))

    expect((argsOf('create')[1] as { metadata?: Record<string, string> }).metadata)
      .toEqual({ 'aishell-session': 's1' })
  })

  it('refuses a non-string environment value instead of letting it deform', async () => {
    // The tool's schema can only say "an object" — the harness DSL cannot
    // constrain a free-form map's value type — while the SDK requires strings.
    // Left unchecked a number would be stringified downstream and surface as a
    // command behaving oddly, far from this call.
    await expect(tools.get('aishell__sandbox_create')!.execute({ envs: { PORT: 3000 } }, exec()))
      .rejects.toThrow(/envs\.PORT must be a string/)
    expect(calls.some(entry => entry.method === 'create')).toBe(false)
  })
})

describe('the one-sandbox binding', () => {
  it('acts on the conversation\'s sandbox without being told which', async () => {
    await withSandbox('s1')

    await tools.get('aishell__sandbox_info')!.execute({}, exec('s1'))

    expect(calls.some(entry => entry.method === 'getInfo')).toBe(true)
  })

  it('keeps two conversations in separate sandboxes', async () => {
    await withSandbox('s1')
    await withSandbox('s2')

    await tools.get('aishell__sandbox_commands_run')!.execute({ command: 'echo a' }, exec('s2'))

    // The second conversation acts on the sandbox it created, not the first's.
    expect(calls.filter(entry => entry.method === 'create')).toHaveLength(2)
  })

  it('recovers the binding after a restart', async () => {
    // Nothing bound in this process — the sandbox is found by the metadata tag
    // the create call wrote, which is what keeps it from being orphaned.
    await tools.get('aishell__sandbox_create')!.execute({}, exec('s1'))
    const rebound = new SandboxRegistry(() => Promise.resolve([{ sandboxId: 'sbx-1', state: 'running' }]))
    expect(await rebound.resolve('s1')).toBe('sbx-1')
  })

  it('names aishell__sandbox_create when the conversation has no sandbox', async () => {
    await expect(tools.get('aishell__sandbox_info')!.execute({}, exec('never-created')))
      .rejects.toThrow(/aishell__sandbox_create/)
  })

  it('does not create a sandbox on its own initiative', async () => {
    // A tool that quietly created one would have to choose the template and
    // the lifetime, which are the operator's decisions.
    await expect(tools.get('aishell__sandbox_files_write')!.execute(
      { path: '/w/a.txt', content: 'x' },
      exec('never-created'),
    )).rejects.toThrow(SandboxToolError)

    expect(calls.some(entry => entry.method === 'create')).toBe(false)
  })

  it('says the contents are gone when the sandbox has expired', async () => {
    await withSandbox('s1')
    handleIsGone = true

    // Distinct from "never had one": only this case means the work in the
    // previous sandbox is unrecoverable, and the model has to know that before
    // it decides to carry on.
    await expect(tools.get('aishell__sandbox_files_read')!.execute({ path: '/w/a.txt' }, exec('s1')))
      .rejects.toThrow(/contents are gone/)
  })
})

describe('aishell__sandbox_commands_run', () => {
  it('reports a successful command with its streams', async () => {
    await withSandbox()
    const result = await tools.get('aishell__sandbox_commands_run')!.execute(
      { command: 'echo ok' },
      exec(),
    ) as { exitCode: number, stdout: string, outputTruncated: boolean }

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('ok\n')
    expect(result.outputTruncated).toBe(false)
  })

  it('caps output at 30 000 code points, not code units', async () => {
    // The limit is what the context budget is spent in, and the two counts
    // diverge the moment text is not ASCII. 40 001 astral characters are
    // 40 001 code points but 80 002 code units: a unit-counted limit sees only
    // 80 002 and truncates, while a point-counted one sees 40 001 — the two
    // agree on *whether* to truncate here. What separates them is the length:
    // truncating in units leaves 15 000 points, truncating in points leaves
    // 30 000.
    await withSandbox()
    stdoutOverride = '😀'.repeat(40_001)

    const result = await tools.get('aishell__sandbox_commands_run')!.execute(
      { command: 'emit' },
      exec(),
    ) as { stdout: string, outputTruncated: boolean }

    expect(result.outputTruncated).toBe(true)
    expect([...result.stdout]).toHaveLength(30_000)
  })

  it('does not split a surrogate pair at the cut', async () => {
    // An emoji is one code point and two code units, so a slice at a unit
    // index lands between them and leaves a lone surrogate — not valid text,
    // and rendered as a replacement character at the boundary.
    await withSandbox()
    stdoutOverride = '😀'.repeat(30_001)

    const result = await tools.get('aishell__sandbox_commands_run')!.execute(
      { command: 'emit' },
      exec(),
    ) as { stdout: string }

    // Every code point survived whole: a split pair would decode as a lone
    // surrogate, and re-joining the units would not equal the original rune.
    const points = [...result.stdout]
    expect(points).toHaveLength(30_000)
    expect(points.every(point => point === '😀')).toBe(true)
    // No lone surrogate anywhere in the result.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result.stdout)).toBe(false)
  })

  it('reports a non-zero exit as a result rather than failing the tool', async () => {
    await withSandbox()
    commandBehavior = 'exit-nonzero'
    exitCode = 3

    // The property: a failing command is an answer. Letting the SDK's
    // rejection through would tell the model the tool broke, and it would
    // retry a command that had already answered.
    const result = await tools.get('aishell__sandbox_commands_run')!.execute(
      { command: 'false' },
      exec(),
    ) as { exitCode: number, stdout: string, stderr: string }

    expect(result.exitCode).toBe(3)
    expect(result.stdout).toBe('out text')
    expect(result.stderr).toBe('err text')
  })

  it('returns a pid for a background command instead of waiting', async () => {
    await withSandbox()
    const result = await tools.get('aishell__sandbox_commands_run')!.execute(
      { command: 'sleep 30', background: true },
      exec(),
    )

    expect(result).toEqual({ pid: 4242 })
    expect((argsOf('commands.run')[1] as { background?: boolean }).background).toBe(true)
  })

  it('forwards cwd, envs, and a timeout when given', async () => {
    await withSandbox()
    await tools.get('aishell__sandbox_commands_run')!.execute({
      command: 'ls',
      cwd: '/w',
      envs: { A: '1' },
      timeoutMs: 1_000,
    }, exec())

    expect(argsOf('commands.run')[1]).toMatchObject({
      cwd: '/w', envs: { A: '1' }, timeoutMs: 1_000,
    })
  })
})

describe('aishell__sandbox_commands_kill', () => {
  it('stops a background process by pid', async () => {
    await withSandbox()
    expect(await tools.get('aishell__sandbox_commands_kill')!.execute({ pid: 4242 }, exec()))
      .toEqual({ pid: 4242, killed: true })

    expect(argsOf('commands.kill')[0]).toBe(4242)
  })

  it('reports a pid that was already gone as the outcome asked for', async () => {
    await withSandbox()
    alreadyGonePid = 4242

    // The caller wanted it stopped; it is stopped. A failure here would invite
    // a retry that can only fail again.
    expect(await tools.get('aishell__sandbox_commands_kill')!.execute({ pid: 4242 }, exec()))
      .toEqual({ pid: 4242, killed: false })
  })

  it('does not delete the sandbox to stop a process', async () => {
    await withSandbox()
    await tools.get('aishell__sandbox_commands_kill')!.execute({ pid: 4242 }, exec())

    // The point of the tool: stopping a server must not cost the files.
    expect(calls.some(entry => entry.method === 'kill')).toBe(false)
  })
})

describe('the filesystem tools', () => {
  it('writes text to the path it was given', async () => {
    await withSandbox()
    const result = await tools.get('aishell__sandbox_files_write')!.execute(
      { path: '/w/index.html', content: '<h1>hi</h1>' },
      exec(),
    )

    expect(result).toEqual({ path: '/w/index.html', bytes: 11 })
    expect(argsOf('files.write')).toEqual(['/w/index.html', '<h1>hi</h1>'])
  })

  it('reads text by default and bytes when base64 is asked for', async () => {
    await withSandbox()
    const text = await tools.get('aishell__sandbox_files_read')!.execute({ path: '/w/a.txt' }, exec())
    expect(text).toMatchObject({ format: 'text', content: 'file body', truncated: false })

    const bytes = await tools.get('aishell__sandbox_files_read')!.execute(
      { path: '/w/a.bin', format: 'base64' },
      exec(),
    )
    expect(bytes).toMatchObject({ format: 'base64', content: 'aGk=', bytes: 2 })
  })

  it('lists entries with their type, and a size only where one exists', async () => {
    await withSandbox()
    const result = await tools.get('aishell__sandbox_files_list')!.execute({ path: '/w' }, exec()) as {
      entries: Array<{ name: string, type: string, size?: number }>
    }

    expect(result.entries).toEqual([
      { name: 'a.txt', path: '/w/a.txt', type: 'file', size: 3 },
      { name: 'sub', path: '/w/sub', type: 'dir' },
    ])
  })

  it('copies a text file into the local workspace through the filesystem service', async () => {
    await withSandbox()
    bytesBody = new TextEncoder().encode('file body')

    const result = await tools.get('aishell__sandbox_files_download')!.execute(
      { path: '/w/a.txt', localPath: 'a.txt' },
      exec(),
    )

    expect(result).toMatchObject({ path: '/w/a.txt', localPath: 'a.txt', bytes: 9, encoding: 'text' })
    expect(fsWrites).toEqual([{ path: 'a.txt', text: 'file body' }])
  })

  it("anchors a relative destination at the session's working directory", async () => {
    // Not at the host process's launch directory, which is what the backend
    // falls back to when no `cwd` is given. The session directory is the one
    // the person chose, and every other filesystem tool anchors there.
    await withSandbox()
    bytesBody = new TextEncoder().encode('file body')
    sessionCwd = '/work/some-project'

    await tools.get('aishell__sandbox_files_download')!.execute(
      { path: '/w/a.txt', localPath: 'out/a.txt' },
      exec(),
    )

    expect(resolveCalls).toEqual([{ path: 'out/a.txt', cwd: '/work/some-project' }])
  })

  it('passes no cwd when there is no working-directory service', async () => {
    // A deployment without the service is not an error: the backend's own
    // default is used, exactly as before this fix. Losing the anchor is a
    // degradation, not a refusal to write.
    await withSandbox()
    bytesBody = new TextEncoder().encode('file body')
    sessionCwd = null

    const result = await tools.get('aishell__sandbox_files_download')!.execute(
      { path: '/w/a.txt', localPath: 'a.txt' },
      exec(),
    )

    expect(result).toMatchObject({ encoding: 'text' })
    expect(resolveCalls).toEqual([{ path: 'a.txt', cwd: undefined }])
    expect(fsWrites).toHaveLength(1)
  })

  it('returns base64 instead of writing a binary file it cannot store', async () => {
    await withSandbox()
    // A NUL byte settles it: no text file has one.
    bytesBody = new Uint8Array([0, 1, 2, 253, 254, 255])

    const result = await tools.get('aishell__sandbox_files_download')!.execute(
      { path: '/w/blob.bin', localPath: 'blob.bin' },
      exec(),
    ) as { encoding: string, content: string, bytes: number }

    expect(result.encoding).toBe('base64')
    expect(result.content).toBe(Buffer.from(bytesBody).toString('base64'))
    // Nothing was written: the harness filesystem holds text, and writing the
    // bytes as text would have produced a mangled file with no warning.
    expect(fsWrites).toEqual([])
  })

  it('treats a UTF-8 BOM file as text despite its leading bytes', async () => {
    await withSandbox()
    bytesBody = new TextEncoder().encode('\uFEFFhello')

    const result = await tools.get('aishell__sandbox_files_download')!.execute(
      { path: '/w/bom.txt', localPath: 'bom.txt' },
      exec(),
    )

    expect(result).toMatchObject({ encoding: 'text' })
    expect(fsWrites).toHaveLength(1)
  })

  it('returns the bytes rather than failing when no filesystem is mounted', async () => {
    await withSandbox()
    hasFs = false
    bytesBody = new TextEncoder().encode('file body')

    // The contents are what the caller wanted; losing them to an error would
    // waste the read.
    const result = await tools.get('aishell__sandbox_files_download')!.execute(
      { path: '/w/a.txt', localPath: 'a.txt' },
      exec(),
    )

    expect(result).toMatchObject({ encoding: 'base64', bytes: 9 })
  })
})

describe('aishell__sandbox_get_port_url', () => {
  it('returns an https URL for the requested port', async () => {
    await withSandbox()
    const result = await tools.get('aishell__sandbox_get_port_url')!.execute({ port: 3000 }, exec())

    // `getHost` yields a bare hostname, so the scheme is the plugin's to add.
    expect(result).toEqual({
      url: 'https://3000-sbx-1.example.test',
      sandboxId: 'sbx-1',
      port: 3000,
    })
  })
})

describe('sandbox lifecycle', () => {
  it('kills a sandbox and releases the binding', async () => {
    await withSandbox('s1')
    await tools.get('aishell__sandbox_kill')!.execute({}, exec('s1'))

    expect(calls.some(entry => entry.method === 'kill')).toBe(true)
    // The binding is dropped too: it addressed an endpoint that is gone, and a
    // later call has to be told to create rather than act on nothing.
    await expect(tools.get('aishell__sandbox_info')!.execute({}, exec('s1')))
      .rejects.toThrow(/aishell__sandbox_create/)
  })

  it('treats killing an already-gone sandbox as the outcome asked for', async () => {
    await withSandbox('s1')
    handleIsGone = true

    // The caller wanted it gone; it is gone. Reporting a failure would invite
    // a retry that can only fail again.
    expect(await tools.get('aishell__sandbox_kill')!.execute({}, exec('s1')))
      .toEqual({ sandboxId: 'sbx-1', killed: false })
  })

  it('reports the new expiry after a timeout change', async () => {
    await withSandbox()
    const result = await tools.get('aishell__sandbox_set_timeout')!.execute({ timeoutMs: 600_000 }, exec())

    expect(result).toEqual({ sandboxId: 'sbx-1', endAt: '2026-01-01T00:05:00.000Z' })
  })

  it('lists the account\'s sandboxes without a binding lookup', async () => {
    const result = await tools.get('aishell__sandbox_list')!.execute({}, exec('s1'))
    // No sandbox is bound, but listing every sandbox needs none.
    expect(result).toEqual({ sandboxes: [] })
  })
})