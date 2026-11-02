/**
 * Breath mode: turns the voice gate into a 0..1 scroll multiplier.
 *
 * Speak and the script eases into motion; pause and it holds for a beat, then glides
 * to rest. Both directions use a critically damped spring (no overshoot, no snapping),
 * so a word that starts mid-glide picks the motion back up from wherever it is.
 *
 *   speaking ─┐▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔└──────────────   (VAD already adds ~350 ms hangover)
 *   breath    ╱▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔╲___________
 *            rise ≈0.25 s       hold  fall ≈0.6 s
 */
import type { VoiceSample } from '../core/contracts'
import { smoothDamp, type Damped } from '../core/springs'

export interface BreathOptions {
  /** Seconds to get ~90% of the way to full speed after speech starts. */
  rise?: number
  /** Seconds to get ~90% of the way to rest once the hold ends. */
  fall?: number
  /** Seconds to keep full speed after the gate closes, before gliding down. */
  hold?: number
}

export interface Breath {
  /** Advance by `dt` seconds with the latest gate sample; returns the multiplier (0..1). */
  update(sample: VoiceSample, dt: number): number
  readonly value: number
  reset(): void
}

/** A critically damped spring covers ~91% of the distance in two smooth-times. */
const SMOOTH_PER_90 = 0.5
const MAX_DT = 0.1

export function createBreath(opts: BreathOptions = {}): Breath {
  const rise = Math.max(0.01, opts.rise ?? 0.25) * SMOOTH_PER_90
  const fall = Math.max(0.01, opts.fall ?? 0.6) * SMOOTH_PER_90
  const hold = Math.max(0, opts.hold ?? 0.12)

  const s: Damped = { x: 0, v: 0 }
  let holdLeft = 0
  let wasSpeaking = false

  return {
    get value() {
      return s.x
    },
    reset() {
      s.x = 0
      s.v = 0
      holdLeft = 0
      wasSpeaking = false
    },
    update(sample, dt) {
      if (!(dt > 0)) return s.x // 0, negative or NaN: no time passed
      dt = Math.min(dt, MAX_DT)

      if (sample.speaking) holdLeft = hold
      else if (wasSpeaking) holdLeft = hold
      else holdLeft = Math.max(0, holdLeft - dt)
      wasSpeaking = sample.speaking

      const up = sample.speaking || holdLeft > 0
      smoothDamp(s, up ? 1 : 0, up ? rise : fall, dt)
      if (s.x < 0) s.x = 0
      else if (s.x > 1) s.x = 1
      if (s.x < 1e-4 && !up) {
        s.x = 0
        s.v = 0
      }
      return s.x
    },
  }
}
