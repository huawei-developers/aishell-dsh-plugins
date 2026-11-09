/**
 * The suggestion strip's ring maths.
 *
 * Split from the component so the ring can be pinned without a DOM. What
 * makes this worth testing is that the ring's invariant is easy to state and
 * easy to break: **position `p` and position `p + n` show the same three
 * cards**, and every press must land on a position whose window is fully
 * rendered.
 *
 * The failure this guards against is silent. Get `ringStart` wrong and the
 * first prev click shows an empty track; get `rewindTo` wrong and a click at
 * the seam appears to skip a card; let a fast double-click outrun the rewind
 * and the window walks off the rendered copies into blank space. None of
 * those throw — they just look wrong for a moment.
 */

import { describe, it, expect } from 'vitest'
import { COPIES, ringLength, ringStart, ringStep, rewindTo } from '../src/client/carousel.ts'

/** The shipped strip: four cards, three visible. */
const N = 4

describe('ring geometry', () => {
  it('renders three copies', () => {
    expect(COPIES).toBe(3)
    expect(ringLength(N)).toBe(12)
  })

  it('starts in the middle copy', () => {
    // Starting at 0 would leave the first prev click with nothing behind it.
    expect(ringStart(N)).toBe(N)
    expect(ringStart(N)).toBeGreaterThan(0)
  })

  it('starts at a position whose window is fully rendered', () => {
    // The window at `p` reads cards p .. p+VISIBLE-1, so the last usable
    // position inside one copy is n-1.
    const first = ringStart(N)
    const last = first + N - 1
    expect(first).toBeGreaterThanOrEqual(0)
    expect(last).toBeLessThan(ringLength(N))
  })
})

describe('rewindTo', () => {
  it('leaves a position inside the working band alone', () => {
    for (let p = N; p <= 2 * N - 1; p++) {
      expect(rewindTo(p, N)).toBeNull()
    }
  })

  it('rewinds one past the band back to the band start', () => {
    // The forward seam: 2n and n show the same window.
    expect(rewindTo(2 * N, N)).toBe(N)
  })

  it('rewinds one before the band forward to the band end', () => {
    // The backward seam: n-1 and 2n-1 show the same window.
    expect(rewindTo(N - 1, N)).toBe(2 * N - 1)
  })

  it('rewinds any position past the band, not only the first', () => {
    // A caller that missed several rewinds must still be recoverable — the
    // band is periodic, so everything at or past 2n maps to the band.
    expect(rewindTo(2 * N + 3, N)).toBe(N)
    expect(rewindTo(7 * N, N)).toBe(N)
  })
})

describe('ringStep — the press sequence', () => {
  it('advances one card per press, through every position', () => {
    // The whole point of the ring: four cards visible three have FOUR
    // positions, and each press reaches the next one. A scroll range would
    // only have one.
    let pos = ringStart(N)
    const seen: number[] = []
    for (let i = 0; i < N; i++) {
      const { to } = ringStep(pos, 1, N)
      pos = to
      seen.push(to)
    }
    expect(seen).toEqual([N + 1, N + 2, N + 3, N + 4])
    // The last press left the band; the settle brings it home...
    expect(rewindTo(pos, N)).toBe(N)
  })

  it('wraps forward from the last position back to the first', () => {
    // At 2n-1 the forward press goes to 2n, whose window equals n's.
    const { to } = ringStep(2 * N - 1, 1, N)
    expect(to).toBe(2 * N)
    expect(rewindTo(to, N)).toBe(N)
  })

  it('wraps backward from the first position to the last', () => {
    const { to } = ringStep(N, -1, N)
    expect(to).toBe(N - 1)
    expect(rewindTo(to, N)).toBe(2 * N - 1)
  })

  it('settles an owed rewind before stepping again', () => {
    // The fast-click case: the previous press ended at 2n and the rewind has
    // not run yet (no transitionend). Stepping from 2n would reach 2n+1,
    // which is past the rendered copies. The step must rewind first.
    const { from, to } = ringStep(2 * N, 1, N)
    expect(from).toBe(N)
    expect(to).toBe(N + 1)
  })

  it('settles a backward rewind too', () => {
    const { from, to } = ringStep(N - 1, -1, N)
    expect(from).toBe(2 * N - 1)
    expect(to).toBe(2 * N - 2)
  })

  it('never leaves the window past the rendered copies', () => {
    // Hammer the ring in both directions from many starting points and
    // assert the invariant after every settle: the window at the current
    // position must be fully within the rendered cards.
    const VISIBLE = 3
    for (const start of [N, N + 1, 2 * N - 1, N - 1, 2 * N]) {
      for (const delta of [1, -1]) {
        let pos = start
        for (let i = 0; i < 20; i++) {
          const step = ringStep(pos, delta, N)
          pos = step.to
          const settled = rewindTo(pos, N) ?? pos
          expect(settled).toBeGreaterThanOrEqual(0)
          expect(settled + VISIBLE - 1).toBeLessThan(ringLength(N))
          pos = settled
        }
      }
    }
  })

  it('is periodic: n presses return to the starting position', () => {
    let pos = ringStart(N)
    for (let i = 0; i < N; i++) {
      pos = ringStep(pos, 1, N).to
      pos = rewindTo(pos, N) ?? pos
    }
    expect(pos).toBe(ringStart(N))
  })

  it('five presses forward equal one press forward', () => {
    // A ring of four: +5 ≡ +1. Walking forward must not drift.
    const walk = (count: number): number => {
      let pos = ringStart(N)
      for (let i = 0; i < count; i++) {
        pos = ringStep(pos, 1, N).to
        pos = rewindTo(pos, N) ?? pos
      }
      return pos
    }
    expect(walk(5)).toBe(walk(1))
    expect(walk(8)).toBe(walk(0))
  })
})

describe('ring geometry — other card counts', () => {
  it('holds the window invariant for a five-card ring', () => {
    const n = 5
    const VISIBLE = 3
    let pos = ringStart(n)
    for (let i = 0; i < 30; i++) {
      pos = ringStep(pos, i % 3 === 0 ? -1 : 1, n).to
      pos = rewindTo(pos, n) ?? pos
      expect(pos + VISIBLE - 1).toBeLessThan(ringLength(n))
    }
  })
})