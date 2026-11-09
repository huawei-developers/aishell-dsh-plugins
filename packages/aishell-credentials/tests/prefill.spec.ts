/**
 * Credential prefill from the environment.
 *
 * The property that matters is what a prefill is *not*: it fills the form's
 * fields, and nothing else. The form still opens, every field stays editable,
 * and submitting or cancelling work as before. So the cases below are about
 * which values are offered, never about anything being stored or skipped.
 */

import { describe, it, expect } from 'vitest'
import { readEnvPrefill } from '../src/prefill.ts'

/** An environment carrying the given variables. */
function env(vars: Record<string, string>): Record<string, string | undefined> {
  return vars
}

describe('readEnvPrefill', () => {
  it('offers a complete pair', () => {
    expect(readEnvPrefill(env({ HW_ACCESS_KEY: 'AK1', HW_SECRET_KEY: 'SK1' })))
      .toEqual({ accessKeyId: 'AK1', secretAccessKey: 'SK1' })
  })

  it('carries a security token when one is set', () => {
    expect(readEnvPrefill(env({
      HW_ACCESS_KEY: 'AK1',
      HW_SECRET_KEY: 'SK1',
      HW_SECURITY_TOKEN: 'STS1',
    }))).toEqual({ accessKeyId: 'AK1', secretAccessKey: 'SK1', securityToken: 'STS1' })
  })

  it('omits an empty security token rather than passing an empty string', () => {
    // An empty `security_token` would sign as a third header the gateway then
    // rejects — the same rule the credential store applies.
    const prefill = readEnvPrefill(env({
      HW_ACCESS_KEY: 'AK1',
      HW_SECRET_KEY: 'SK1',
      HW_SECURITY_TOKEN: '',
    }))
    expect(prefill).not.toHaveProperty('securityToken')
  })

  it('offers nothing when either half of the pair is missing', () => {
    // Half a pair is no pair: filling one field and leaving the other empty
    // would submit an incomplete credential.
    expect(readEnvPrefill(env({ HW_ACCESS_KEY: 'AK1' }))).toBeUndefined()
    expect(readEnvPrefill(env({ HW_SECRET_KEY: 'SK1' }))).toBeUndefined()
    expect(readEnvPrefill(env({}))).toBeUndefined()
  })

  it('treats an empty value as absent', () => {
    expect(readEnvPrefill(env({ HW_ACCESS_KEY: '', HW_SECRET_KEY: 'SK1' }))).toBeUndefined()
    expect(readEnvPrefill(env({ HW_ACCESS_KEY: 'AK1', HW_SECRET_KEY: '' }))).toBeUndefined()
  })

  it('does not carry a token on its own', () => {
    // A lone token with no pair cannot be saved; offering it would fill a field
    // the person has no way to complete.
    expect(readEnvPrefill(env({ HW_SECURITY_TOKEN: 'STS1' }))).toBeUndefined()
  })

  it('reads nothing else from the environment', () => {
    // A narrow reader: the values are the three named variables, and a machine
    // carrying unrelated secrets must not have them travel to the page.
    const prefill = readEnvPrefill(env({
      HW_ACCESS_KEY: 'AK1',
      HW_SECRET_KEY: 'SK1',
      AWS_SECRET_ACCESS_KEY: 'nope',
      DEEPSEEK_API_KEY: 'nope',
    }))
    expect(JSON.stringify(prefill)).not.toContain('nope')
  })
})