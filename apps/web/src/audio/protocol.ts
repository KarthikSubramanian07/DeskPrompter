/** Messages between voiceGate.ts (main thread) and vad.worklet.ts. Types only. */

export interface VadWorkletInit {
  /** Precompiled vad.wasm. */
  module?: WebAssembly.Module
  /** Raw vad.wasm bytes, used when the browser can't clone a Module into the worklet. */
  bytes?: ArrayBuffer
  /** 0..1, see `set_sensitivity` in zig/vad. */
  sensitivity: number
}

export type VadWorkletMessage =
  | { type: 'ready'; sampleRate: number }
  | { type: 'sample'; level: number; speaking: boolean }

export type VadWorkletCommand = { type: 'sensitivity'; value: number } | { type: 'stop' }

export const VAD_PROCESSOR = 'deskprompter-vad'
