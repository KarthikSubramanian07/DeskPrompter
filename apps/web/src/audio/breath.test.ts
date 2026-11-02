import { describe, expect, it } from 'vitest'
import { createBreath } from './breath'
import type { VoiceSample } from '../core/contracts'

const ON: VoiceSample = { level: 0.6, speaking: true }
const OFF: VoiceSample = { level: 0, speaking: false }

/** Run `seconds` at `fps`, returning every value produced. */
function run(b: ReturnType<typeof createBreath>, sample: VoiceSample, seconds: number, fps = 60) {
  const out: number[] = []
  const n = Math.round(seconds * fps)
  for (let i = 0; i < n; i++) out.push(b.update(sample, 1 / fps))
  return out
}

const isMonotonic = (xs: number[], dir: 1 | -1) => xs.every((x, i) => i === 0 || (x - xs[i - 1]!) * dir >= -1e-9)

describe('breath', () => {
  it('rests at zero in silence', () => {
    const b = createBreath()
    expect(run(b, OFF, 2).every((x) => x === 0)).toBe(true)
  })

  it('eases up to full speed in about a quarter second, without overshoot', () => {
    const b = createBreath()
    const up = run(b, ON, 0.25)
    expect(up.at(-1)!).toBeGreaterThan(0.85)
    expect(up.at(-1)!).toBeLessThanOrEqual(1)
    expect(up[0]!).toBeLessThan(0.1) // eases in, doesn't jump
    expect(isMonotonic(up, 1)).toBe(true)
    run(b, ON, 1)
    expect(b.value).toBeCloseTo(1, 3)
  })

  it('holds briefly after speech, then glides to rest over ~0.6 s', () => {
    const b = createBreath()
    run(b, ON, 1)
    const hold = run(b, OFF, 0.12) // default hold
    expect(Math.min(...hold)).toBeGreaterThan(0.99)
    const fall = run(b, OFF, 0.62)
    expect(isMonotonic(fall, -1)).toBe(true)
    expect(fall[Math.round(0.15 * 60)]!).toBeGreaterThan(0.5) // a glide, not a cut
    expect(fall.at(-1)!).toBeLessThan(0.12)
    run(b, OFF, 2)
    expect(b.value).toBe(0)
  })

  it('rides through gate flicker without dipping', () => {
    const b = createBreath()
    run(b, ON, 1)
    run(b, OFF, 0.05)
    const back = run(b, ON, 0.5)
    expect(Math.min(...back)).toBeGreaterThan(0.97)
  })

  it('is continuous when speech stops mid-rise', () => {
    const b = createBreath()
    const xs = [...run(b, ON, 0.08), ...run(b, OFF, 1.5)]
    const maxStep = Math.max(...xs.map((x, i) => (i ? Math.abs(x - xs[i - 1]!) : 0)))
    expect(maxStep).toBeLessThan(0.11) // the spring's peak rate at 60 fps is ~0.098/frame
    expect(Math.max(...xs)).toBeLessThan(0.95) // 0.08 s of speech + the hold never reaches full speed
    expect(xs.at(-1)!).toBeLessThan(0.01)
  })

  it('is frame-rate independent', () => {
    for (const fps of [30, 144]) {
      const a = createBreath()
      const ref = createBreath()
      const x = run(a, ON, 0.2, fps).at(-1)!
      const y = run(ref, ON, 0.2, 60).at(-1)!
      expect(Math.abs(x - y)).toBeLessThan(0.03)
    }
  })

  it('ignores bad dt and stays within 0..1 on long frames', () => {
    const b = createBreath()
    expect(b.update(ON, 0)).toBe(0)
    expect(b.update(ON, -1)).toBe(0)
    expect(b.update(ON, Number.NaN)).toBe(0)
    for (let i = 0; i < 20; i++) {
      const v = b.update(i % 2 ? ON : OFF, 5) // tab refocus
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('honours custom timings and reset', () => {
    const slow = createBreath({ rise: 1 })
    expect(run(slow, ON, 0.25).at(-1)!).toBeLessThan(0.3)
    slow.reset()
    expect(slow.value).toBe(0)
  })
})
