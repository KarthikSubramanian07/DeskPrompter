/**
 * AudioWorkletProcessor around the Zig voice gate (zig/vad → vad.wasm).
 *
 * The worklet scope has no fetch, so the main thread compiles the wasm and hands
 * the `WebAssembly.Module` over in `processorOptions` (or raw bytes, if the
 * browser refuses to clone a module into the worklet). Instantiation is synchronous.
 *
 * Loaded with `?worker&url`, so Vite bundles this file (and strips its types) into a
 * standalone script. It must not import anything at runtime.
 */
import type { VadWorkletInit, VadWorkletMessage, VadWorkletCommand } from './protocol'

// Ambient worklet globals, declared locally so they don't leak into window code.
declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}

interface VadExports {
  memory: WebAssembly.Memory
  init(sampleRate: number): void
  input_ptr(): number
  input_len(): number
  process(n: number): number
  level(): number
  speaking(): number
  set_sensitivity(s: number): void
}

const SPEAKING = 1
const CHANGED = 2
const POST_HZ = 30

class VadProcessor extends AudioWorkletProcessor {
  private vad: VadExports
  private view: Float32Array
  private viewBuffer: ArrayBuffer
  private ptr: number
  private cap: number
  private sinceLast = 0
  private readonly postEvery: number
  private alive = true

  constructor(options: { processorOptions: VadWorkletInit }) {
    super()
    const o = options.processorOptions
    const mod = o.module instanceof WebAssembly.Module ? o.module : new WebAssembly.Module(o.bytes!)
    const inst = new WebAssembly.Instance(mod, {})
    this.vad = inst.exports as unknown as VadExports
    this.vad.init(sampleRate)
    this.vad.set_sensitivity(o.sensitivity)
    this.ptr = this.vad.input_ptr()
    this.cap = this.vad.input_len()
    this.viewBuffer = this.vad.memory.buffer
    this.view = new Float32Array(this.viewBuffer, this.ptr, this.cap)
    this.postEvery = Math.round(sampleRate / POST_HZ)

    this.port.onmessage = (e: MessageEvent<VadWorkletCommand>) => {
      const m = e.data
      if (m.type === 'sensitivity') this.vad.set_sensitivity(m.value)
      else if (m.type === 'stop') this.alive = false
    }
    this.post({ type: 'ready', sampleRate })
  }

  private post(m: VadWorkletMessage) {
    this.port.postMessage(m)
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.alive) return false
    const chans = inputs[0]
    const first = chans?.[0]
    if (!chans || !first || first.length === 0) return true // nothing connected yet

    // The wasm memory never grows (no allocator), but re-derive the view if it ever does.
    if (this.vad.memory.buffer !== this.viewBuffer) {
      this.viewBuffer = this.vad.memory.buffer
      this.view = new Float32Array(this.viewBuffer, this.ptr, this.cap)
    }

    const n = Math.min(first.length, this.cap)
    const view = this.view
    if (chans.length === 1) {
      view.set(n === first.length ? first : first.subarray(0, n))
    } else {
      // Downmix without allocating.
      const g = 1 / chans.length
      for (let i = 0; i < n; i++) {
        let s = 0
        for (let c = 0; c < chans.length; c++) s += chans[c]![i]!
        view[i] = s * g
      }
    }

    const flags = this.vad.process(n)
    this.sinceLast += n
    if (flags & CHANGED || this.sinceLast >= this.postEvery) {
      this.sinceLast = 0
      this.post({ type: 'sample', level: this.vad.level(), speaking: (flags & SPEAKING) !== 0 })
    }
    return true
  }
}

registerProcessor('deskprompter-vad', VadProcessor)
