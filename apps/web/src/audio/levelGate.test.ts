import { describe, expect, it } from 'vitest'
import { createLevelGate } from './levelGate'

const TICK = 1 / 30

/** Feed a function of time (seconds → RMS) for `seconds`; returns per-tick speaking flags. */
function feed(g: ReturnType<typeof createLevelGate>, rms: (t: number) => number, seconds: number, t0 = 0) {
  const out: { t: number; on: boolean; level: number }[] = []
  for (let t = t0; t < t0 + seconds; t += TICK) {
    const s = g.update(rms(t), TICK)
    out.push({ t, on: s.speaking, level: s.level })
  }
  return out
}

let seed = 1
const jitter = () => {
  seed = (seed * 16807) % 2147483647
  return 1 + 0.1 * (seed / 2147483647 - 0.5)
}
const dbToRms = (db: number) => 10 ** (db / 20)
const room = () => dbToRms(-62) * jitter()
/** Syllables at 4 Hz, 35 dB above the room at their peaks. */
const speech = (t: number) => room() + dbToRms(-27) * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t))

describe('level gate (fallback)', () => {
  it('stays closed in a quiet room', () => {
    const g = createLevelGate()
    const r = feed(g, room, 3)
    expect(r.some((x) => x.on)).toBe(false)
    expect(Math.max(...r.map((x) => x.level))).toBeLessThan(0.05)
  })

  it('opens on speech, holds through syllables, releases after ~350 ms', () => {
    const g = createLevelGate()
    feed(g, room, 1)
    const talk = feed(g, speech, 2, 1)
    const on = talk.find((x) => x.on)
    expect(on).toBeDefined()
    expect(on!.t).toBeLessThan(1.3)
    expect(talk.filter((x) => x.t > on!.t).every((x) => x.on)).toBe(true)
    expect(Math.max(...talk.map((x) => x.level))).toBeGreaterThan(0.6)

    const quiet = feed(g, room, 1.5, 3)
    const off = quiet.find((x) => !x.on)!
    expect(off.t - 3).toBeGreaterThan(0.25)
    expect(off.t - 3).toBeLessThan(0.6)
    expect(quiet.filter((x) => x.t > off.t).some((x) => x.on)).toBe(false)
  })

  it('absorbs a steady fan into the floor', () => {
    const g = createLevelGate()
    feed(g, room, 1)
    const fan = () => dbToRms(-30) * jitter()
    const r = feed(g, fan, 8, 1)
    expect(r.filter((x) => x.t > 3).some((x) => x.on)).toBe(false)
  })

  it('lower sensitivity needs louder speech', () => {
    const soft = (t: number) => room() + dbToRms(-52) * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t))
    const hi = createLevelGate(1)
    feed(hi, room, 1)
    expect(feed(hi, soft, 2, 1).some((x) => x.on)).toBe(true)
    const lo = createLevelGate(0)
    feed(lo, room, 1)
    expect(feed(lo, soft, 2, 1).some((x) => x.on)).toBe(false)
  })
})
