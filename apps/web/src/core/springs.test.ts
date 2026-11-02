import { describe, expect, it } from 'vitest'
import { smoothDamp, spring } from './springs'

describe('smoothDamp', () => {
  it('converges without overshoot', () => {
    const s = { x: 0, v: 0 }
    let max = 0
    for (let i = 0; i < 240; i++) max = Math.max(max, smoothDamp(s, 100, 0.3, 1 / 60))
    expect(max).toBeLessThanOrEqual(100)
    expect(s.x).toBeCloseTo(100, 1)
  })
  it('is frame-rate independent', () => {
    const a = { x: 0, v: 0 }
    const b = { x: 0, v: 0 }
    for (let i = 0; i < 30; i++) smoothDamp(a, 50, 0.4, 1 / 60)
    for (let i = 0; i < 60; i++) smoothDamp(b, 50, 0.4, 1 / 120)
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.5)
  })
})

describe('spring', () => {
  it('overshoots when under-damped, then settles', () => {
    const s = { x: 0, v: 0 }
    let max = 0
    for (let i = 0; i < 600; i++) max = Math.max(max, spring(s, 1, 2, 0.35, 1 / 60))
    expect(max).toBeGreaterThan(1.05)
    expect(s.x).toBeCloseTo(1, 2)
  })
  it('survives a huge dt', () => {
    const s = { x: 0, v: 0 }
    spring(s, 1, 3, 0.5, 2)
    expect(Number.isFinite(s.x)).toBe(true)
    expect(Math.abs(s.x - 1)).toBeLessThan(0.2)
  })
})
