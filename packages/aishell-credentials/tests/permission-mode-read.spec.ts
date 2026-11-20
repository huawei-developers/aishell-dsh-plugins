/**
 * Reading the permission mode across the Host's start-up window.
 *
 * The Host answers a read once `api/aishell/permission` is registered, and
 * answers `undefined` while it is not. A conversation the browser restores can
 * reach the page inside that window, so the read retries on a fixed schedule
 * and the control offers a re-read after it.
 *
 * The loop is driven directly here (a recording `sleep` instead of real time),
 * so the schedule is an assertion rather than a wait.
 */

import { describe, it, expect } from 'vitest'

import {
  MODE_READ_RETRY_DELAYS_MS,
  modeReadRetryDelay,
  readPermissionModeUntilKnown,
} from '../src/client/permission-mode.ts'

describe('mode read — retry schedule', () => {
  it('starts short and grows, so the ordinary case costs one request', () => {
    // Shortest first: a Host that registers the route quickly is read by the
    // first retry, and the longer waits are spent only while it is still not
    // ready.
    expect(modeReadRetryDelay(0)).toBe(MODE_READ_RETRY_DELAYS_MS[0])
    for (let index = 1; index < MODE_READ_RETRY_DELAYS_MS.length; index += 1) {
      expect(modeReadRetryDelay(index)).toBeGreaterThan(modeReadRetryDelay(index - 1))
    }
  })

  it('holds the last delay for any further attempt', () => {
    // The index comes from a counter, so out-of-range values are representable
    // and resolve to the nearest end of the schedule.
    const last = MODE_READ_RETRY_DELAYS_MS[MODE_READ_RETRY_DELAYS_MS.length - 1]
    expect(modeReadRetryDelay(999)).toBe(last)
    expect(modeReadRetryDelay(-1)).toBe(MODE_READ_RETRY_DELAYS_MS[0])
  })

  it('covers the start-up window the design sizes it for', () => {
    // The delays are the interval in which a read answers itself: a Host that
    // registers the route inside it is read without the person doing anything.
    // Pinned so shortening it is a deliberate change to that interval.
    const window = MODE_READ_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)
    expect(window).toBeGreaterThanOrEqual(15_000)
  })
})

describe('mode read — the loop', () => {
  /** A read that answers `undefined` for the first `failures` attempts. */
  const eventually = (failures: number, mode: 'read_only' | 'read_write' = 'read_only') => {
    let calls = 0
    return {
      read: async () => {
        calls += 1
        return calls > failures ? mode : undefined
      },
      calls: () => calls,
    }
  }

  it('returns the first successful read without waiting', async () => {
    const source = eventually(0, 'read_write')
    const slept: number[] = []

    const mode = await readPermissionModeUntilKnown({
      read: source.read,
      isLive: () => true,
      sleep: async (ms) => { slept.push(ms) },
    })

    expect(mode).toBe('read_write')
    expect(source.calls()).toBe(1)
    // No delay at all: the ordinary case must not add latency to the chip.
    expect(slept).toEqual([])
  })

  it('retries until the Host answers', async () => {
    // The route registered after the page rendered: the read waits out the two
    // shortest delays and the third attempt gets the mode.
    const source = eventually(2, 'read_write')
    const slept: number[] = []

    const mode = await readPermissionModeUntilKnown({
      read: source.read,
      isLive: () => true,
      sleep: async (ms) => { slept.push(ms) },
    })

    expect(mode).toBe('read_write')
    expect(source.calls()).toBe(3)
    expect(slept).toEqual([MODE_READ_RETRY_DELAYS_MS[0], MODE_READ_RETRY_DELAYS_MS[1]])
  })

  it('gives up after the schedule is spent', async () => {
    // The bound is the schedule's length: past it the read reports unknown and
    // the control offers a re-read, so a page left open spends no further
    // requests on a mode that is not arriving.
    const source = eventually(Number.POSITIVE_INFINITY)
    const slept: number[] = []

    const mode = await readPermissionModeUntilKnown({
      read: source.read,
      isLive: () => true,
      sleep: async (ms) => { slept.push(ms) },
    })

    expect(mode).toBeUndefined()
    // One attempt more than there are delays: the last wait is followed by a
    // final read rather than being waited out and abandoned.
    expect(source.calls()).toBe(MODE_READ_RETRY_DELAYS_MS.length + 1)
    expect(slept).toEqual([...MODE_READ_RETRY_DELAYS_MS])
  })

  it('stops when the chip unmounts mid-window', async () => {
    // `isLive` is what ties a read to the surface that started it: once the
    // chip is gone the loop ends at the attempt in flight.
    const source = eventually(Number.POSITIVE_INFINITY)
    let live = true
    const slept: number[] = []

    const mode = await readPermissionModeUntilKnown({
      read: async () => {
        // The chip unmounts while the first attempt is out.
        const answer = await source.read()
        live = false
        return answer
      },
      isLive: () => live,
      sleep: async (ms) => { slept.push(ms) },
    })

    expect(mode).toBeUndefined()
    expect(source.calls()).toBe(1)
    expect(slept).toEqual([])
  })

  it('rechecks liveness after the wait', async () => {
    // A chip that goes away during a delay is as gone as one that goes away
    // during the attempt.
    const source = eventually(Number.POSITIVE_INFINITY)
    let live = true
    const slept: number[] = []

    const mode = await readPermissionModeUntilKnown({
      read: source.read,
      isLive: () => live,
      sleep: async (ms) => {
        slept.push(ms)
        live = false
      },
    })

    expect(mode).toBeUndefined()
    expect(source.calls()).toBe(1)
    expect(slept).toHaveLength(1)
  })

  it('starts a fresh schedule when a new read begins', async () => {
    // Each read owns its schedule; nothing carries over between them. That is
    // what `reread` depends on: its first attempt is immediate and its waits
    // begin at the short end.
    const spent = async (): Promise<number[]> => {
      const slept: number[] = []
      await readPermissionModeUntilKnown({
        read: async () => undefined,
        isLive: () => true,
        sleep: async (ms) => { slept.push(ms) },
      })
      return slept
    }

    const first = await spent()
    const second = await spent()

    expect(first).toEqual([...MODE_READ_RETRY_DELAYS_MS])
    expect(second).toEqual(first)
  })
})