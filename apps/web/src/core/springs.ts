/**
 * Tiny motion toolkit. Two flavours:
 *  - smoothDamp: critically damped, never overshoots. For scrolling and anything you read.
 *  - spring:     under-damped, with follow-through. For the lamp, which is allowed to be alive.
 */

export interface Damped {
  x: number
  v: number
}

/** Critically damped approach to `target` (Game Programming Gems 4, "Critically Damped Ease-In/Ease-Out Smoothing"). */
export function smoothDamp(s: Damped, target: number, smoothTime: number, dt: number, maxSpeed = Infinity): number {
  const st = Math.max(0.0001, smoothTime)
  const omega = 2 / st
  const x = omega * dt
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  let change = s.x - target
  const maxChange = maxSpeed * st
  change = Math.max(-maxChange, Math.min(maxChange, change))
  const t = s.x - change
  const temp = (s.v + omega * change) * dt
  s.v = (s.v - omega * temp) * exp
  let out = t + (change + temp) * exp
  // Prevent overshoot.
  if (target - s.x > 0 === out > target) {
    out = target
    s.v = (out - target) / Math.max(dt, 1e-6)
  }
  s.x = out
  return out
}

/** Damped harmonic spring. `freq` in Hz, `zeta` damping ratio (<1 bounces). Semi-implicit, stable at 60–240 fps. */
export function spring(s: Damped, target: number, freq: number, zeta: number, dt: number): number {
  const w = 2 * Math.PI * freq
  // Sub-step for stability on long frames (tab refocus, slow devices).
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
  const h = dt / steps
  for (let i = 0; i < steps; i++) {
    const a = -w * w * (s.x - target) - 2 * zeta * w * s.v
    s.v += a * h
    s.x += s.v * h
  }
  return s.x
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
