/**
 * Andon's skeleton and nervous system.
 *
 * Pure math, no DOM: a two-link arm solved with inverse kinematics, a head that
 * aims its light, and a layer of springs and impulses on top so it moves like
 * something with weight and opinions. Coordinates are SVG-style (y down), in
 * the lamp's own units, with the base at the origin.
 */
import { clamp, spring, type Damped } from '../../core/springs'

export const GEO = {
  shoulderY: -16,
  l1: 118,
  l2: 104,
  shade: 64,
  mouth: 34,
} as const

export type Mood = 'idle' | 'watching' | 'live' | 'paused' | 'asleep'

export interface Pose {
  a1: number // lower arm, radians from straight up, clockwise
  a2: number // elbow, relative to lower arm
  h: number // head direction, absolute
  facing: number // -1..1 (passes through 0 while turning round)
  lift: number // base hop offset (y)
  squash: number // base squash factor ~1
  glow: number // 0..1 light intensity
  tag: number // pendulum angle of the paper tag
}

export interface Vec {
  x: number
  y: number
}

/** Two-link IK. Returns null when the point is unreachable after clamping (never, by construction). */
export function solveArm(target: Vec, l1 = GEO.l1, l2 = GEO.l2): { a1: number; a2: number } {
  const sx = 0
  const sy = GEO.shoulderY
  let dx = target.x - sx
  let dy = target.y - sy
  let d = Math.hypot(dx, dy)
  const max = (l1 + l2) * 0.985
  const min = Math.abs(l1 - l2) + 24
  if (d > max || d < min) {
    const k = clamp(d, min, max) / (d || 1)
    dx *= k
    dy *= k
    d = clamp(d, min, max)
  }
  const phi = Math.atan2(dx, -dy)
  const alpha = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1))
  const beta = Math.PI - Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1))
  // Elbow up and back: the classic desk-lamp silhouette.
  return { a1: phi - alpha, a2: beta }
}

export function forward(p: Pick<Pose, 'a1' | 'a2' | 'h'>) {
  const s = { x: 0, y: GEO.shoulderY }
  const e = { x: s.x + GEO.l1 * Math.sin(p.a1), y: s.y - GEO.l1 * Math.cos(p.a1) }
  const a = p.a1 + p.a2
  const hp = { x: e.x + GEO.l2 * Math.sin(a), y: e.y - GEO.l2 * Math.cos(a) }
  const dir = { x: Math.sin(p.h), y: -Math.cos(p.h) }
  const mouth = { x: hp.x + dir.x * GEO.shade, y: hp.y + dir.y * GEO.shade }
  return { shoulder: s, elbow: e, head: hp, mouth, dir }
}

const D = (x = 0): Damped => ({ x, v: 0 })

/** The brain: turns intent (look there, you're live, nod) into a pose, every frame. */
export class LampRig {
  target: Vec = { x: 160, y: 40 }
  mood: Mood = 'idle'
  energy = 0
  private t = Math.random() * 100
  private a1 = D(-0.35)
  private a2 = D(1.6)
  private h = D(2.4)
  private facing = D(1)
  private lift = D(0)
  private squash = D(1)
  private glow = D(0)
  private tag = D(0)
  private faceSign = 1
  private glance: Vec = { x: 0, y: 0 }
  private nextGlance = 2
  private moodSince = 0
  private lastHeadX = 0
  private lastHeadY = 0
  private powered = false

  /** Light up with a little flicker, like an old filament finding its feet. */
  powerOn() {
    this.powered = true
    this.flickerT = 0
  }
  private flickerT = -1

  nod(strength = 1) {
    this.h.v += 4.5 * strength * this.faceSign
  }

  hop(strength = 1) {
    this.lift.v -= 220 * strength
    this.squash.x = 1 - 0.12 * strength
  }

  shake() {
    this.h.v += 9
    this.shakeT = 0.5
  }
  private shakeT = 0

  setMood(m: Mood) {
    if (m !== this.mood) {
      this.mood = m
      this.moodSince = 0
    }
  }

  step(dt: number): Pose {
    dt = Math.min(dt, 1 / 20)
    this.t += dt
    this.moodSince += dt
    const t = this.t

    // Which way are we facing? Turn round on the base with hysteresis.
    if (this.faceSign > 0 && this.target.x < -40) this.faceSign = -1
    else if (this.faceSign < 0 && this.target.x > 40) this.faceSign = 1
    spring(this.facing, this.faceSign, 1.1, 0.72, dt)
    const f = this.faceSign

    // Saccades: idle eyes wander a little.
    this.nextGlance -= dt
    if (this.nextGlance <= 0) {
      const wander = this.mood === 'idle' ? 46 : this.mood === 'paused' ? 20 : 8
      this.glance = { x: (Math.random() - 0.5) * wander * 2, y: (Math.random() - 0.5) * wander }
      this.nextGlance = 2.2 + Math.random() * 4
    }

    const tgt = { x: (this.target.x + this.glance.x) * f, y: this.target.y + this.glance.y }

    // Where should the head be? Lean a little toward what we look at.
    const rest = { x: 46, y: -204 }
    let lean = 0.16
    let drop = 0
    let headBias = 0
    switch (this.mood) {
      case 'live':
        lean = 0.22
        headBias = Math.sin(t * 7.3) * 0.025 * this.energy
        drop = -this.energy * 8
        break
      case 'watching':
        lean = 0.2
        break
      case 'paused':
        lean = 0.1
        drop = 26 + Math.sin(t * 0.9) * 3
        headBias = 0.18
        break
      case 'asleep':
        lean = 0.06
        drop = 70
        headBias = 0.85
        break
      default:
        drop = Math.sin(t * 0.8) * 5
        headBias = Math.sin(t * 0.53) * 0.05
    }
    // Lean toward the target, but stay a lamp: the head keeps above and behind the light.
    const want = {
      x: rest.x + clamp((tgt.x - rest.x) * lean, -50, 60),
      y: rest.y + clamp((tgt.y - rest.y) * lean * 0.6, -24, 46) + drop,
    }
    const arm = solveArm(want)
    const pre = forward({ a1: arm.a1, a2: arm.a2, h: 0 })
    let h = Math.atan2(tgt.x - pre.head.x, -(tgt.y - pre.head.y)) + headBias
    if (this.shakeT > 0) {
      this.shakeT -= dt
      h += Math.sin(this.shakeT * 40) * 0.12 * (this.shakeT / 0.5)
    }

    const stiff = this.mood === 'asleep' ? 0.6 : 1.5
    spring(this.a1, arm.a1, stiff, 0.6, dt)
    spring(this.a2, arm.a2, stiff * 1.1, 0.58, dt)
    spring(this.h, h, stiff * 1.6, 0.5, dt)
    spring(this.lift, 0, 2.6, 0.42, dt)
    spring(this.squash, 1, 3.2, 0.3, dt)

    // Light: flicker on power, breathe with the voice.
    let g = 0
    if (this.powered) {
      g = this.mood === 'asleep' ? 0.22 : this.mood === 'paused' ? 0.55 : this.mood === 'live' ? 0.82 + this.energy * 0.18 : 0.72
      if (this.flickerT >= 0) {
        this.flickerT += dt
        const ft = this.flickerT
        if (ft < 0.6) g *= [0.1, 0.9, 0.2, 0.0, 1, 0.4, 1][Math.floor(ft * 11.6)] ?? 1
        else this.flickerT = -1
      }
    }
    spring(this.glow, g, this.flickerT >= 0 ? 12 : 1.4, 0.9, dt)

    // The paper tag hangs from the neck and swings with head motion.
    const fk = forward({ a1: this.a1.x, a2: this.a2.x, h: this.h.x })
    const ax = (fk.head.x - this.lastHeadX) / dt
    const ay = (fk.head.y - this.lastHeadY) / dt
    this.lastHeadX = fk.head.x
    this.lastHeadY = fk.head.y
    this.tag.v -= (ax * 0.0009 + ay * 0.0002) * f
    spring(this.tag, 0, 1.2, 0.12, dt)

    return {
      a1: this.a1.x,
      a2: this.a2.x,
      h: this.h.x,
      facing: this.facing.x,
      lift: this.lift.x,
      squash: this.squash.x,
      glow: clamp(this.glow.x, 0, 1.2),
      tag: clamp(this.tag.x, -1.2, 1.2),
    }
  }
}
