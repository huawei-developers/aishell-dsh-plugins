/**
 * Audit trail behaviour.
 *
 * What these pin: a record reaches a real file as one parseable JSON line, a
 * value the caller supplies cannot break the file's shape, the caller can
 * record after completing its action without guarding, and an unwritable trail
 * reports itself once.
 *
 * Every test writes into its own temporary directory. The trail otherwise
 * resolves under `DSH_HOME`, which is the developer's real data —
 * `auditFilePath()` takes an override for exactly this reason.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, auditFilePath, formatAuditRecord, AUDIT_FILE_NAME } = await import('../src/index.ts')
import type { AuditTrail } from '../src/index.ts'

/** Minimal Context exposing what apply() touches. */
function makeCtx(): { ctx: never, provided: Map<string, unknown>, warnings: string[] } {
  const provided = new Map<string, unknown>()
  const warnings: string[] = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: (line: string) => { warnings.push(line) } }),
    provide: (name: string, value: unknown) => { provided.set(name, value) },
  }
  return { ctx: ctx as never, provided, warnings }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aishell-audit-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The trail a mounted plugin provides, writing into this test's directory. */
function mount(): { audit: AuditTrail, warnings: string[] } {
  const { ctx, provided, warnings } = makeCtx()
  apply(ctx, { dir })
  return { audit: provided.get('audit') as AuditTrail, warnings }
}

/** Every record in the trail file, parsed. */
function readRecords(): Array<Record<string, unknown>> {
  const text = readFileSync(join(dir, AUDIT_FILE_NAME), 'utf8')
  return text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('formatAuditRecord', () => {
  it('is one JSON object with every field named', () => {
    const line = formatAuditRecord({
      action: 'permission.mode',
      subject: 'huaweicloud:AKID',
      outcome: 'granted',
      actor: 'user',
      detail: { from: 'read_only', to: 'read_write' },
    }, Date.parse('2026-11-18T00:00:00Z'))

    expect(JSON.parse(line)).toEqual({
      action: 'permission.mode',
      subject: 'huaweicloud:AKID',
      outcome: 'granted',
      actor: 'user',
      time: '2026-11-18T00:00:00.000Z',
      detail: { from: 'read_only', to: 'read_write' },
    })
  })

  it('names an absent field as null rather than omitting it', () => {
    // A reader must be able to tell "this action had no actor" from "the writer
    // was an older version that did not record actors".
    expect(JSON.parse(formatAuditRecord({ action: 'x.y' }, 0))).toEqual({
      action: 'x.y', subject: null, outcome: null, actor: null, time: '1970-01-01T00:00:00.000Z',
    })
  })

  it('keeps a value containing a newline on one line', () => {
    // The reason this is JSON and not `key=value`: an unescaped newline would
    // split one record into a line that parses and a line that does not.
    const line = formatAuditRecord({ action: 'x.y', detail: { note: 'first\nsecond' } }, 0)
    expect(line).not.toContain('\n')
    expect(JSON.parse(line).detail).toEqual({ note: 'first\nsecond' })
  })

  it('keeps a key the caller chose, whatever it contains', () => {
    // `two words=1` cannot be split back into a key and a value; JSON does not
    // need to.
    const parsed = JSON.parse(formatAuditRecord({ action: 'x.y', detail: { 'two words': 1 } }, 0))
    expect(parsed.detail).toEqual({ 'two words': 1 })
  })

  it('cannot be made to look like a second record', () => {
    // A value that spells out another record's fields stays a value.
    const parsed = JSON.parse(formatAuditRecord({
      action: 'permission.mode',
      outcome: 'revoked',
      detail: { note: 'outcome=granted' },
    }, 0))
    expect(parsed.outcome).toBe('revoked')
    expect(parsed.detail.note).toBe('outcome=granted')
  })
})

describe('aishell-audit — the file sink', () => {
  it('resolves its path under the given directory', () => {
    expect(auditFilePath({ dir })).toBe(join(dir, AUDIT_FILE_NAME))
  })

  it('appends one line per record', () => {
    const { audit } = mount()
    audit.record({ action: 'permission.mode', outcome: 'granted', actor: 'user' })
    audit.record({ action: 'permission.mode', outcome: 'revoked', actor: 'user' })

    expect(readRecords()).toHaveLength(2)
    expect(readRecords()[0]?.outcome).toBe('granted')
    expect(readRecords()[1]?.outcome).toBe('revoked')
  })

  it('creates its directory when the host has not', () => {
    const nested = join(dir, 'not', 'yet', 'there')
    const { ctx, provided } = makeCtx()
    apply(ctx, { dir: nested })
    ;(provided.get('audit') as AuditTrail).record({ action: 'x.y' })

    expect(existsSync(join(nested, AUDIT_FILE_NAME))).toBe(true)
    expect(JSON.parse(readFileSync(join(nested, AUDIT_FILE_NAME), 'utf8').trim()).action).toBe('x.y')
  })

  it('never throws, so a caller can record after completing its action', () => {
    const { audit } = mount()
    expect(() => audit.record({ action: 'x.y' })).not.toThrow()
    expect(() => audit.record({ action: 'x.y', detail: { odd: 'a=b c' } })).not.toThrow()
  })

  it('reports an unwritable trail once, through a level the Host keeps', () => {
    // `info` reaches nothing on a real Host — see the module header — so a lost
    // record has to be reported at `warn` or it is reported nowhere.
    const { ctx, provided, warnings } = makeCtx()
    // A file where the directory should be: mkdir fails, so the append cannot.
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, '')
    apply(ctx, { dir: join(blocked, 'sub') })
    const audit = provided.get('audit') as AuditTrail

    audit.record({ action: 'x.y' })
    audit.record({ action: 'x.y' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('audit trail cannot write')
  })
})
