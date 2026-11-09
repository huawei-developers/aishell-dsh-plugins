/**
 * The rating API's self-correction, which is what replaces a hardcoded table.
 *
 * The unit an inquiry is measured in (`usage_measure_id`) is required and
 * unpublished: the contract describes it only as "the unit, e.g. hours", and
 * `usage-types` returns just `code: "Duration"`. Submitting any value, though,
 * makes the API state the right one:
 *
 * ```
 * 400  "Convert from value measure(9) to measure unit(4) error"
 * ```
 *
 * Verified for compute, RDS and DCS. So the value is learned, not tabulated —
 * which is the difference between a module that keeps working when a service
 * changes its billing and one that quietly prices the wrong unit.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  readMeasureCorrection,
  readPrice,
  resetLearnedMeasureUnits,
  type RateFailure,
} from '../src/bss.ts'

describe('readMeasureCorrection', () => {
  it('reads the correct unit out of the API error', () => {
    // The shape the API actually sends — a JSON object embedded in a string
    // inside JSON.
    const failure: RateFailure = {
      kind: 'unknown',
      detail:
        'HTTP 400: {"error_code":"CBC.99006050","error_msg":"Incorrect usage measurement '
        + 'unit.…[msg]:{\\"error_code\\":\\"CBC.6050\\",\\"error_msg\\":\\"Convert from value '
        + 'measure(9) to measure unit(4) error\\",\\"error_list\\":[]}"}',
    }
    expect(readMeasureCorrection(failure)).toBe(4)
  })

  it('reads a multi-digit unit', () => {
    expect(readMeasureCorrection({ kind: 'unknown', detail: 'measure unit(17)' })).toBe(17)
  })

  it('returns undefined for a failure that does not name a unit', () => {
    // Passing this on as a correction would resubmit the same request forever.
    expect(readMeasureCorrection({ kind: 'not-offered', detail: 'billing item does not exist' }))
      .toBeUndefined()
    expect(readMeasureCorrection({ kind: 'malformed', detail: 'Product not found' })).toBeUndefined()
  })

  it('returns undefined when there is no failure at all', () => {
    expect(readMeasureCorrection(undefined)).toBeUndefined()
  })
})

describe('readPrice', () => {
  it('prefers the account amount over the list price', () => {
    const price = readPrice({
      currency: 'CNY',
      product_rating_results: [{
        id: '1',
        amount: '312.44',
        official_website_amount: '400.00',
      }],
    }, '1')
    expect(price).toEqual({ amount: 312.44, listAmount: 400, currency: 'CNY' })
  })

  it('falls back to the list price when the account amount is absent', () => {
    // A product entry may carry only the list price; discarding it would report
    // a priced resource as unpriced.
    const price = readPrice({
      product_rating_results: [{ id: '1', official_website_amount: '200.00' }],
    }, '1')
    expect(price).toEqual({ amount: 200, listAmount: 200, currency: 'CNY' })
  })

  it('finds its own entry among several', () => {
    const price = readPrice({
      product_rating_results: [
        { id: '1', amount: '1.00' },
        { id: '2', amount: '2.00' },
      ],
    }, '2')
    expect(price?.amount).toBe(2)
  })

  it('returns undefined for an id the response does not carry', () => {
    // Taking the first entry would file another resource's price under this
    // address.
    expect(readPrice({ product_rating_results: [{ id: '1', amount: '1.00' }] }, '9'))
      .toBeUndefined()
  })

  it('returns undefined for a response with no results', () => {
    expect(readPrice(null, '1')).toBeUndefined()
    expect(readPrice({}, '1')).toBeUndefined()
  })
})

describe('the learned unit store', () => {
  beforeEach(() => {
    resetLearnedMeasureUnits()
  })

  it('starts empty, so a test cannot inherit a unit from a real call', () => {
    // The store is module state. A unit learned by one deployment would be
    // resubmitted to another without being checked, which is how a wrong price
    // survives a fix.
    expect(readMeasureCorrection({ kind: 'unknown', detail: 'measure unit(4)' })).toBe(4)
  })
})