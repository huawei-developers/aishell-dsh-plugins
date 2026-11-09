/**
 * The read-only policy context — what the model is told, and when it is told it.
 *
 * Two failure modes matter and neither throws.
 *
 * The first is silence: the text provider is synchronous, so it reads a mode
 * snapshot instead of asking the server. A snapshot that is never seeded, or
 * never refreshed after a switch, leaves the model reading yesterday's mode —
 * and the gate would then refuse a call the prompt had just invited.
 *
 * The second is over-announcement: read-write must contribute nothing, and so
 * must an unknown mode. A context that says "you may write" when the mode is
 * not yet known would be stating a permission nothing has granted.
 */

import { describe, it, expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  PERMISSION_CONTEXT_NAME,
  READ_ONLY_POLICY,
  permissionPolicyText,
  registerPermissionPolicyContext,
} from '../src/permission-context.ts'
import type { PermissionMode } from '../src/permission.ts'

describe('permissionPolicyText — what is announced', () => {
  it('announces the policy in read-only mode', () => {
    expect(permissionPolicyText('read_only')).toBe(READ_ONLY_POLICY)
  })

  it('contributes nothing in read-write mode', () => {
    // Not a "you may now write" line: the absence is the statement, and a line
    // that has to be kept in step with the mode is one more thing to go stale.
    expect(permissionPolicyText('read_write')).toBe('')
  })

  it('contributes nothing before the mode is known', () => {
    // An unread mode is not read-only. Saying so would assert a restriction
    // that may not hold; the gate refuses precisely once it is asked.
    expect(permissionPolicyText(undefined)).toBe('')
  })

  it('does not restate the gate it cannot enforce', () => {
    // Kept as an assertion because the temptation is constant: the gate's
    // denial already names the operation and what remains available, so
    // repeating its rules here would only add a second, vaguer copy — and a
    // model that reads a vague rule pre-emptively declines work that would
    // have been allowed.
    expect(READ_ONLY_POLICY).not.toContain('Refused')
    expect(READ_ONLY_POLICY).not.toContain('terraform_plan')
  })

  it('names the route the permission check cannot see', () => {
    // The one instruction that has no enforcement behind it, so it has to be
    // explicit: a reachable EIP or tunnel is the same account, and reaching a
    // resource without the gate is not a way around the gate.
    expect(READ_ONLY_POLICY).toContain('EIP')
    expect(READ_ONLY_POLICY).toContain('tunnel')
    expect(READ_ONLY_POLICY).toMatch(/does not make the change allowed/)
  })

  it('keeps local work out of scope, so a review is not declined', () => {
    // "Read-only" is not "touch nothing": files and local processes are not
    // cloud state, and a model that conflates them stops work it should do.
    expect(READ_ONLY_POLICY).toMatch(/Local work is unaffected/)
  })
})

/** A scope where the registered contribution can be read back. */
function makeScope(order = 115): {
  scope: { systemPrompt: { context: (c: unknown) => () => void, getContextOrder: (n: string) => number } }
  registered: Array<{ name: string, order: number, text: () => string }>
  orderQueried: string[]
} {
  const registered: Array<{ name: string, order: number, text: () => string }> = []
  const orderQueried: string[] = []
  return {
    registered,
    orderQueried,
    scope: {
      systemPrompt: {
        context: (contribution: unknown) => {
          registered.push(contribution as never)
          return () => {}
        },
        getContextOrder: (name: string) => {
          orderQueried.push(name)
          return order
        },
      },
    },
  }
}

describe('registerPermissionPolicyContext — the registration', () => {
  it('registers under its own name at the approval policy order', () => {
    // Beside its kin in the snapshot rather than at the end, where an
    // out-of-band restriction reads as an afterthought.
    const { scope, registered, orderQueried } = makeScope()
    const ctx = { inject: (_deps: string[], fn: (s: unknown) => void) => { fn(scope) } } as unknown as Context

    registerPermissionPolicyContext(ctx, () => 'read_only')

    expect(registered).toHaveLength(1)
    // Destructured through a one-element tuple cast: the length was just
    // asserted, and `noUncheckedIndexedAccess` cannot see that.
    const [entry] = registered as [typeof registered[number]]
    expect(entry.name).toBe(PERMISSION_CONTEXT_NAME)
    expect(entry.order).toBe(115)
    expect(orderQueried).toEqual(['APPROVAL_POLICY'])
  })

  it('reads the mode through the accessor at each evaluation', () => {
    // The provider is synchronous and runs per assembly, so the accessor is how
    // a switch reaches the prompt at all.
    const { scope, registered } = makeScope()
    const ctx = { inject: (_deps: string[], fn: (s: unknown) => void) => { fn(scope) } } as unknown as Context
    let mode: PermissionMode | undefined = 'read_only'

    registerPermissionPolicyContext(ctx, () => mode)

    const [entry] = registered as [typeof registered[number]]
    expect(entry.text()).toBe(READ_ONLY_POLICY)
    mode = 'read_write'
    expect(entry.text()).toBe('')
  })

  it('does nothing, and does not throw, without the system prompt service', () => {
    // Deferred behind ctx.inject precisely so a deployment without the system
    // prompt keeps its tools instead of failing to activate.
    const inject = vi.fn()
    const ctx = { inject } as unknown as Context

    expect(() => { registerPermissionPolicyContext(ctx, () => 'read_only') }).not.toThrow()
    expect(inject).toHaveBeenCalledWith(['systemPrompt'], expect.any(Function))
  })
})
