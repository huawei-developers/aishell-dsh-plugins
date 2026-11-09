/**
 * The bridge: tool handlers in, DSH tool definitions out.
 *
 * The properties worth pinning are the ones where the two vocabularies differ
 * and a mismatch would be silent:
 *
 *   1. `isError` must become a rejection. DSH records rejection as failure; an
 *      error payload returned as a value reads to the model as success.
 *   2. The declared zod schema must become real JSON Schema. A zod object handed
 *      over as-is serializes to `{}`, which tells the model the tool takes no
 *      arguments — and then every call fails validation.
 *   3. The data files must resolve from the bundle, not the cwd.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import {
  createRegistrar,
  publicToolName,
  toToolDefinition,
} from '../src/bridge.ts'
import { DATA_DIR, dataFile } from '../src/data-paths.ts'
import { okJson } from '../src/tools/errors.ts'

/** Register one tool into a fresh capture surface and return its definition. */
function build(options: {
  config?: Record<string, unknown>
  result?: unknown
} = {}) {
  const { registrar, captured } = createRegistrar()
  registrar.registerTool(
    'terraform_apply',
    {
      description: 'Apply a plan.',
      inputSchema: z.object({ deployment: z.string().min(1).describe('工作区路径') }),
      ...options.config,
    } as never,
    (async () => options.result ?? { content: [{ type: 'text', text: 'done' }] }) as never,
  )
  return toToolDefinition(captured[0]!, 60_000)
}

describe('bridge — naming', () => {
  it('prefixes the tool name', () => {
    // A stable, collision-resistant prefix; it is not a protocol namespace.
    expect(publicToolName('terraform_apply')).toBe('aishell__terraform_apply')
  })
})

describe('bridge — the declaration', () => {
  it('converts the zod schema to JSON Schema', () => {
    const definition = build()

    expect(definition.parameters).toMatchObject({
      type: 'object',
      properties: { deployment: { type: 'string', minLength: 1, description: '工作区路径' } },
      required: ['deployment'],
    })
    // A zod instance would serialize to `{}` here; the `type` assertion above is
    // what catches that.
    expect(definition.parameters).not.toHaveProperty('_zod')
  })

  it('carries the description through', () => {
    expect(build().description).toBe('Apply a plan.')
  })

  it('passes the timeout to the harness', () => {
    expect(build().timeoutMs).toBe(60_000)
  })

  it('refuses a declaration that is not a zod schema', () => {
    // Better at registration, where it names the tool, than at the first call.
    const { registrar, captured } = createRegistrar()
    expect(() => {
      registrar.registerTool('broken', { inputSchema: { type: 'object' } } as never, (async () => ({ content: [] })) as never)
      toToolDefinition(captured[0]!, 60_000)
    }).toThrow(/broken.*not a zod type/)
  })
})

describe('bridge — execution', () => {
  it('refuses a call whose arguments do not satisfy the declaration', async () => {
    // DSH's raw `register()` validates the definition's shape and the OUTPUT
    // schema, but not the arguments — only `defineTool()` wrappers do. Without
    // this check the handler receives `undefined` and fails inside Node, which
    // names neither the tool nor the argument.
    const definition = build()
    await expect(definition.execute({}, {} as never))
      .rejects.toThrow(/aishell__terraform_apply: deployment/)
  })

  it('names every violated argument in one message', async () => {
    const definition = build({
      config: { inputSchema: z.object({ deployment: z.string().min(1), count: z.number() }) },
    })
    await expect(definition.execute({}, {} as never))
      .rejects.toThrow(/deployment.*count/)
  })

  it('lets a well-formed call through', async () => {
    const definition = build({ result: { content: [{ type: 'text', text: 'ok' }] } })
    await expect(definition.execute({ deployment: 'dep' }, {} as never))
      .resolves.toBeDefined()
  })

  it('returns the result as the canonical value', async () => {
    const definition = build({ result: { content: [{ type: 'text', text: 'applied' }] } })

    await expect(definition.execute({ deployment: 'dep' }, {} as never)).resolves.toEqual({
      content: [{ type: 'text', text: 'applied' }],
    })
  })

  it('throws on isError, with the diagnostic as the message', async () => {
    // The single most important translation here: the handlers carry failure
    // inside the payload, the harness carries it as a rejection.
    const definition = build({
      result: { content: [{ type: 'text', text: 'Refused: read-only mode' }], isError: true },
    })

    await expect(definition.execute({ deployment: 'dep' }, {} as never)).rejects.toThrow(/Refused: read-only mode/)
  })

  it('joins several text blocks into the failure message', async () => {
    const definition = build({
      result: {
        content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
        isError: true,
      },
    })

    // The original error is the rejection's `.cause`; `vitest` surfaces the
    // message, which is what the model reads.
    await expect(definition.execute({ deployment: 'dep' }, {} as never)).rejects.toThrow(/first\nsecond/s)
  })

  it('describes an error with no message rather than throwing on it', async () => {
    const definition = build({ result: { content: [], isError: true } })
    await expect(definition.execute({ deployment: 'dep' }, {} as never)).rejects.toThrow(/without a message/)
  })

})

describe('bridge — rendering', () => {
  it('renders text blocks', async () => {
    // Through `execute` first, so the value rendered is the canonical one the
    // harness would actually hold — not a hand-built shape that happens to fit.
    const definition = build({ result: { content: [{ type: 'text', text: 'applied' }] } })
    const value = await definition.execute({ deployment: 'dep' }, {} as never)
    const blocks = definition.output.render(undefined, value as never)

    expect(blocks).toEqual([{ type: 'text', text: 'applied' }])
  })

  it('reports a non-text block as unavailable instead of dropping it', async () => {
    // The handlers only produce text today. Dropping an unexpected block would
    // render a successful call as empty, which reads like a broken tool — so it
    // is reported instead.
    const definition = build({ result: { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] } })
    const value = await definition.execute({ deployment: 'dep' }, {} as never)
    const blocks = definition.output.render(undefined, value as never)

    expect(blocks).toEqual([{ type: 'text', text: expect.stringContaining('content unavailable') }])
  })

  it('renders an empty result as something rather than nothing', async () => {
    const definition = build({ result: { content: [] } })
    const value = await definition.execute({ deployment: 'dep' }, {} as never)
    expect(definition.output.render(undefined, value as never)).toEqual([{ type: 'text', text: '(no output)' }])
  })
})

describe('data paths — the bundle, not the cwd', () => {
  it('resolves inside the package', () => {
    // The flat bundle makes `import.meta.url` point at `lib/index.js`, so the
    // data directory must be its sibling. A path resolved against the cwd would
    // let a workspace file choose what this plugin calls read-only.
    expect(DATA_DIR.endsWith('/data')).toBe(true)
    expect(DATA_DIR).toContain('aishell-deploy')
    expect(dataFile('permission-registry.json')).toBe(`${DATA_DIR}/permission-registry.json`)
  })

  it('ships both artifacts', async () => {
    // A package that builds clean and fails at the first openapi_request is the
    // failure this guards: the build copies these, so their absence is a
    // packaging regression rather than an unlikely state.
    const { stat } = await import('node:fs/promises')
    for (const name of ['permission-registry.json', 'terraform-examples.zip']) {
      const info = await stat(dataFile(name)).catch(() => undefined)
      expect(info?.isFile(), `${name} missing from ${DATA_DIR}`).toBe(true)
    }
  })
})
describe('bridge — the value, not a string containing it', () => {
  /** A handler that produced a JSON value the way every tool now does. */
  function buildJson(value: Record<string, unknown>) {
    const { registrar, captured } = createRegistrar()
    registrar.registerTool(
      'create_deployment',
      {
        description: 'Make a deployment.',
        inputSchema: z.object({ deployment: z.string().min(1) }),
      } as never,
      (async () => okJson(value)) as never,
    )
    return toToolDefinition(captured[0]!, 60_000)
  }

  it('renders the structured value once, as the value', async () => {
    // A handler that serializes its own result AND returns it as
    // `structuredContent` delivers a JSON document quoting another JSON
    // document — parsed twice for no reason, and the model reads a string
    // where it expected the object. The renderer is the only place that turns
    // the value into text.
    const definition = buildJson({ deployment: 'dep', status: 'created' })
    const value = await definition.execute({ deployment: 'dep' }, {} as never)
    const blocks = definition.output.render(undefined, value as never)
    const text = (blocks[0] as { text: string }).text

    expect(text).not.toContain('\\"')
    expect(JSON.parse(text)).toEqual({ deployment: 'dep', status: 'created' })
  })

  it('carries the value once, not a second copy as text', async () => {
    // The model reads what `render` produces, so a serialized copy in
    // `content[]` would never be read — and the harness snapshots the whole
    // returned result, so that copy is paid for twice to show nobody anything.
    // Measured before this: 410 bytes of the canonical payload were that
    // duplicate.
    const definition = buildJson({ deployment: 'dep' })
    const value = await definition.execute({ deployment: 'dep' }, {} as never) as {
      content: unknown[]
      structuredContent?: unknown
    }
    expect(value.structuredContent).toEqual({ deployment: 'dep' })
    expect(value.content).toEqual([])
  })

  it('still passes plain text through when there is no structured value', async () => {
    // A diagnostic carries no data to structure, and inventing one would be a
    // second representation to keep in step.
    const definition = build({ result: { content: [{ type: 'text', text: 'Applied 3 resources.' }] } })
    const value = await definition.execute({ deployment: 'dep' }, {} as never)
    expect(definition.output.render(undefined, value as never))
      .toEqual([{ type: 'text', text: 'Applied 3 resources.' }])
  })

  it('declares an output schema that admits both result shapes', async () => {
    // The old schema said only `{type:'object'}`, which validated everything and
    // therefore described nothing.
    const { parameters: _p, ...definition } = buildJson({})
    expect(definition.output.schema).toMatchObject({
      type: 'object',
      required: ['content'],
    })
  })
})
