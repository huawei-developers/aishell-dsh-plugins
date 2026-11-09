/**
 * Where a relative directory argument points.
 *
 * The failure this prevents is not a bug in one tool — it is two tools
 * disagreeing. `write` saves a file into the session's working directory, whose
 * path the tool call renders as absolute; the next call passes the directory by
 * the name the model has been using, `"huawei-topology"`. Left to Node, that
 * name resolves against `process.cwd()`, the directory the host was launched
 * from, and the two tools are now looking at different places. The symptom is a
 * workspace nobody can find, and it reads as a bug in whichever tool reported
 * it first.
 *
 * The same question applies to `dest` — `terraform_examples_export`'s target
 * directory — which is why the rule is stated for directory arguments rather
 * than for `deployment` alone. Both are the same kind of value and need the
 * same anchor.
 */

import { describe, it, expect } from 'vitest'
import { isAbsolute } from 'node:path'

import { anchorPath } from '../src/paths.ts'

const SESSION = '/home/eushing/opensource/test'

describe('anchorPath', () => {
  it('leaves an absolute path alone', () => {
    expect(anchorPath('/tmp/dep', { sessionDirectory: SESSION })).toBe('/tmp/dep')
  })

  it('anchors a relative path at the session directory', () => {
    // The session directory, not `process.cwd()`: the latter is where the host
    // happened to start, which has nothing to do with the conversation.
    expect(anchorPath('huawei-topology', { sessionDirectory: SESSION }))
      .toBe(`${SESSION}/huawei-topology`)
  })

  it('resolves the empty-ish relative forms to the session itself', () => {
    expect(anchorPath('.', { sessionDirectory: SESSION })).toBe(SESSION)
    expect(anchorPath('./sub/../sub', { sessionDirectory: SESSION }))
      .toBe(`${SESSION}/sub`)
  })

  it('refuses a relative path when there is no session directory', () => {
    // Not a fallback: a relative path with nothing to anchor it names no
    // directory in particular, and choosing one for the caller is how the
    // disagreement above comes back, silently, on every call.
    expect(() => anchorPath('huawei-topology', {}))
      .toThrow(/no session working directory/)
  })

  it('refuses the same way with no context at all', () => {
    expect(() => anchorPath('huawei-topology', undefined))
      .toThrow(/absolute path/)
  })

  it('always returns an absolute path', () => {
    // The property every downstream operation depends on: `readFile`,
    // `spawn` and `join` all take it without asking again.
    for (const input of ['dep', './dep', '../dep', '/abs/dep']) {
      expect(isAbsolute(anchorPath(input, { sessionDirectory: SESSION })),
        input).toBe(true)
    }
  })
})