/**
 * Pure-TS twin of the Zig gate's decision stage, for the AnalyserNode fallback.
 * Feed it speech-band RMS readings at any rate; it returns a VoiceSample.
 * Same ideas as zig/vad: rising-minimum noise floor, steadiness check, Schmitt
 * threshold, 60 ms attack and ~350 ms hangover. No ZCR (the analyser path is band-passed).
 */
import type { VoiceSample } from '../core/contracts'

export const ATTACK_S = 0.06
export const RELEASE_S = 0.36
const WARMUP_S = 0.3
const ABS_FLOOR_DB = -70
const HOLD_MARGIN_DB = 4
const STEADY_FLUX_DB_PER_20MS = 1.25

/** 0 = only loud, close speech; 1 = picks up soft speech. */
export const thresholdDb = (sensitivity: number) => 16 - 10 * clamp01(Number.isFinite(sensitivity) ? sensitivity : 0.5)

export interface LevelGate {
  update(rms: number, dt: number): VoiceSample
  setSensitivity(s: number): void
  readonly current: VoiceSample
}

export function createLevelGate(sensitivity = 0.5): LevelGate {
  let thr = thresholdDb(sensitivity)
  let t = 0
  let floor = NaN
  let prev = NaN
  let flux = 0
  let onFor = 0
  let hang = 0
  const cur: VoiceSample = { level: 0, speaking: false }

  return {
    get current() {
      return cur
    },
    setSensitivity(s) {
      thr = thresholdDb(s)
    },
    update(rms, dt) {
      if (!(dt > 0)) return cur
      dt = Math.min(dt, 0.25)
      t += dt
      const db = 20 * Math.log10(Math.max(rms, 0) + 1e-6)
      const warm = t <= WARMUP_S
      const k = (tau: number) => 1 - Math.exp(-dt / tau)

      // Flux is normalised to "dB per 20 ms" so it matches the wasm thresholds at any tick rate.
      const delta = Number.isNaN(prev) ? 0 : (Math.abs(db - prev) * 0.02) / dt
      prev = db
      flux += (Math.min(delta, 30) - flux) * k(0.3)
      const steady = flux < STEADY_FLUX_DB_PER_20MS

      if (Number.isNaN(floor)) floor = db
      const snr = db - Math.max(floor, ABS_FLOOR_DB)
      const need = cur.speaking ? thr - HOLD_MARGIN_DB : thr
      const cand = !warm && snr >= need && (cur.speaking || !steady)

      if (warm) floor += (db - floor) * k(0.06)
      else if (db < floor) floor += (db - floor) * k(0.05)
      else floor += (db - floor) * k(steady ? 0.5 : 4)

      onFor = cand ? onFor + dt : Math.max(0, onFor - dt)
      if (!cur.speaking) {
        if (onFor >= ATTACK_S - 1e-9) {
          cur.speaking = true
          hang = RELEASE_S
        }
      } else if (cand) {
        hang = RELEASE_S
      } else {
        hang -= dt
        if (hang <= 0) {
          cur.speaking = false
          onFor = 0
        }
      }

      const target = warm ? 0 : clamp01((snr - 3) / 36)
      cur.level += (target - cur.level) * k(target > cur.level ? 0.02 : 0.18)
      return cur
    },
  }
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
