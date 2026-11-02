import { describe, expect, it } from 'vitest'
import { forward, GEO, LampRig, solveArm } from './rig'

describe('lamp IK', () => {
  it('reaches a reachable point', () => {
    const target = { x: 80, y: -170 }
    const { a1, a2 } = solveArm(target)
    const fk = forward({ a1, a2, h: 0 })
    expect(Math.hypot(fk.head.x - target.x, fk.head.y - target.y)).toBeLessThan(0.5)
  })
  it('keeps the elbow above the line from shoulder to head', () => {
    const { a1, a2 } = solveArm({ x: 120, y: -120 })
    const fk = forward({ a1, a2, h: 0 })
    // cross product sign: elbow is on the "up/back" side
    const s = fk.shoulder
    const cross = (fk.head.x - s.x) * (fk.elbow.y - s.y) - (fk.head.y - s.y) * (fk.elbow.x - s.x)
    expect(cross).toBeLessThan(0)
  })
  it('clamps unreachable points instead of exploding', () => {
    const { a1, a2 } = solveArm({ x: 4000, y: 4000 })
    expect(Number.isFinite(a1) && Number.isFinite(a2)).toBe(true)
    const fk = forward({ a1, a2, h: 0 })
    expect(Math.hypot(fk.head.x, fk.head.y - GEO.shoulderY)).toBeLessThanOrEqual(GEO.l1 + GEO.l2)
  })
})

describe('LampRig', () => {
  it('settles its head toward the target', () => {
    const rig = new LampRig()
    rig.target = { x: 260, y: 30 }
    rig.setMood('watching')
    let pose = rig.step(1 / 60)
    for (let i = 0; i < 600; i++) pose = rig.step(1 / 60)
    const fk = forward(pose)
    const want = Math.atan2(rig.target.x - fk.head.x, -(rig.target.y - fk.head.y))
    expect(Math.abs(pose.h - want)).toBeLessThan(0.25)
  })
  it('turns around for targets behind it', () => {
    const rig = new LampRig()
    rig.target = { x: -300, y: 0 }
    let pose = rig.step(1 / 60)
    for (let i = 0; i < 300; i++) pose = rig.step(1 / 60)
    expect(pose.facing).toBeLessThan(-0.9)
  })
  it('lights up after powerOn and dims when asleep', () => {
    const rig = new LampRig()
    rig.powerOn()
    let pose = rig.step(1 / 60)
    for (let i = 0; i < 240; i++) pose = rig.step(1 / 60)
    expect(pose.glow).toBeGreaterThan(0.6)
    rig.setMood('asleep')
    for (let i = 0; i < 400; i++) pose = rig.step(1 / 60)
    expect(pose.glow).toBeLessThan(0.35)
  })
})

describe('LampRig robustness', () => {
  it('never produces NaN, even with zero or negative frame times', () => {
    const rig = new LampRig()
    rig.powerOn()
    for (const dt of [0, 0, -0.01, 1 / 60, 0, 5, 1 / 240]) {
      const p = rig.step(dt)
      for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true)
    }
  })
})
