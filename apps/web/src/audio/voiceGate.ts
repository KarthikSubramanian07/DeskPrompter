/**
 * The voice gate: microphone → AudioWorklet → Zig VAD (wasm) → { level, speaking } at ~30 Hz.
 *
 * `createVoiceGate` always resolves. If wasm, AudioWorklet or the processor fails (at
 * start-up or later), it quietly swaps to `createLevelMeter`, a pure Web Audio fallback
 * built on an AnalyserNode, so the app never loses its meter or breath mode.
 */
import type { VoiceGate, VoiceSample } from '../core/contracts'
import vadUrl from '../wasm/generated/vad.wasm?url'
import workletUrl from './vad.worklet.ts?worker&url'
import { createLevelGate } from './levelGate'
import { VAD_PROCESSOR, type VadWorkletInit, type VadWorkletMessage, type VadWorkletCommand } from './protocol'

export interface VoiceGateOptions {
  /** 0 = only loud, close speech; 1 = picks up soft speech. Default 0.5. */
  sensitivity?: number
  /** Reuse an existing context (it won't be closed on stop). Otherwise the gate owns one. */
  audioContext?: AudioContext
}

export interface VoiceGateHandle extends VoiceGate {
  /** Which implementation is running right now. */
  readonly engine: 'wasm' | 'meter'
  setSensitivity(s: number): void
}

const SILENT: VoiceSample = Object.freeze({ level: 0, speaking: false })

/* ───────────────────────── shared plumbing ───────────────────────── */

/** Subscribers + latest sample. Every engine writes into one of these. */
class Hub {
  current: VoiceSample = SILENT
  private subs = new Set<(s: VoiceSample) => void>()

  emit(s: VoiceSample) {
    this.current = s
    for (const cb of this.subs) cb(s)
  }

  subscribe(cb: (s: VoiceSample) => void) {
    this.subs.add(cb)
    return () => void this.subs.delete(cb)
  }

  clear() {
    this.subs.clear()
  }
}

interface Engine {
  readonly kind: 'wasm' | 'meter'
  setSensitivity(s: number): void
  stop(): void
}

interface Ctx {
  ctx: AudioContext
  owned: boolean
}

function contextFor(opts: VoiceGateOptions): Ctx {
  if (opts.audioContext) return { ctx: opts.audioContext, owned: false }
  return { ctx: new AudioContext({ latencyHint: 'interactive' }), owned: true }
}

function release({ ctx, owned }: Ctx) {
  if (owned && ctx.state !== 'closed') void ctx.close().catch(() => {})
}

/** Contexts start suspended without a user gesture; ask, but never block on it. */
function nudge(ctx: AudioContext) {
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
}

/* ───────────────────────── wasm engine ───────────────────────── */

let vadBinary: Promise<{ module: WebAssembly.Module; bytes: ArrayBuffer }> | null = null

function loadVad() {
  vadBinary ??= (async () => {
    const res = await fetch(vadUrl)
    if (!res.ok) throw new Error(`vad.wasm: HTTP ${res.status}`)
    const bytes = await res.arrayBuffer()
    return { module: await WebAssembly.compile(bytes), bytes }
  })().catch((e) => {
    vadBinary = null // allow a retry next time
    throw e
  })
  return vadBinary
}

const workletLoaded = new WeakMap<BaseAudioContext, Promise<void>>()

function loadWorklet(ctx: AudioContext) {
  let p = workletLoaded.get(ctx)
  if (!p) {
    p = ctx.audioWorklet.addModule(workletUrl)
    p.catch(() => workletLoaded.delete(ctx))
    workletLoaded.set(ctx, p)
  }
  return p
}

function makeNode(ctx: AudioContext, init: VadWorkletInit) {
  return new AudioWorkletNode(ctx, VAD_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    // Let the browser downmix to mono before the worklet sees it.
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: init,
  })
}

async function startWasm(
  stream: MediaStream,
  c: Ctx,
  sensitivity: number,
  hub: Hub,
  onFail: (err: unknown) => void,
): Promise<Engine> {
  const { ctx } = c
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet unsupported')
  nudge(ctx)
  const [{ module, bytes }] = await Promise.all([loadVad(), loadWorklet(ctx)])

  let node: AudioWorkletNode
  try {
    node = makeNode(ctx, { module, sensitivity })
  } catch (e) {
    // Some engines can't structured-clone a Module into the worklet scope; send bytes.
    if (!(e instanceof DOMException && e.name === 'DataCloneError')) throw e
    node = makeNode(ctx, { bytes: bytes.slice(0), sensitivity })
  }

  const source = ctx.createMediaStreamSource(stream)
  // A silent sink keeps the node in the rendering graph on every engine.
  const sink = ctx.createGain()
  sink.gain.value = 0
  source.connect(node)
  node.connect(sink)
  sink.connect(ctx.destination)

  let stopped = false
  const teardown = () => {
    if (stopped) return
    stopped = true
    node.port.postMessage({ type: 'stop' } satisfies VadWorkletCommand)
    node.port.onmessage = null
    node.onprocessorerror = null
    source.disconnect()
    node.disconnect()
    sink.disconnect()
  }

  const ready = new Promise<void>((resolve, reject) => {
    node.port.onmessage = (e: MessageEvent<VadWorkletMessage>) => {
      const m = e.data
      if (m.type === 'ready') resolve()
      else if (m.type === 'sample') hub.emit({ level: m.level, speaking: m.speaking })
    }
    node.onprocessorerror = (ev) => {
      const err = new Error(`vad worklet failed: ${(ev as ErrorEvent).message ?? 'processorerror'}`)
      reject(err)
      if (!stopped) {
        teardown()
        onFail(err)
      }
    }
  })
  // A suspended context won't construct the processor until it runs; only wait while running.
  if (ctx.state === 'running') {
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('vad worklet timed out')), 8000))
    try {
      await Promise.race([ready, timeout])
    } catch (e) {
      teardown()
      throw e
    }
  } else {
    ready.catch(() => {}) // handled by onprocessorerror → onFail
  }

  return {
    kind: 'wasm',
    setSensitivity: (s) => node.port.postMessage({ type: 'sensitivity', value: s } satisfies VadWorkletCommand),
    stop: teardown,
  }
}

/* ───────────────────────── AnalyserNode fallback ───────────────────────── */

const METER_HZ = 30

function startMeter(stream: MediaStream, ctx: AudioContext, sensitivity: number, hub: Hub): Engine {
  nudge(ctx)
  const source = ctx.createMediaStreamSource(stream)
  // Same speech band the wasm gate listens to.
  const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 300, Q: Math.SQRT1_2 })
  const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3000, Q: Math.SQRT1_2 })
  const analyser = new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0 })
  source.connect(hp).connect(lp).connect(analyser)

  const gate = createLevelGate(sensitivity)
  const buf = new Float32Array(analyser.fftSize)
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const dt = (now - last) / 1000
    last = now
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
    const s = gate.update(Math.sqrt(sum / buf.length), dt)
    hub.emit({ level: s.level, speaking: s.speaking })
  }, 1000 / METER_HZ)

  return {
    kind: 'meter',
    setSensitivity: (s) => gate.setSensitivity(s),
    stop() {
      clearInterval(timer)
      source.disconnect()
      hp.disconnect()
      lp.disconnect()
      analyser.disconnect()
    },
  }
}

/* ───────────────────────── public API ───────────────────────── */

function handle(hub: Hub, c: Ctx, getEngine: () => Engine | null, setSens: (s: number) => void, onStop: () => void): VoiceGateHandle {
  let stopped = false
  return {
    get current() {
      return hub.current
    },
    get engine() {
      return getEngine()?.kind ?? 'meter'
    },
    subscribe: (cb) => hub.subscribe(cb),
    setSensitivity: setSens,
    stop() {
      if (stopped) return
      stopped = true
      onStop()
      hub.clear()
      hub.current = SILENT
      release(c)
    },
  }
}

/**
 * Pure Web Audio level meter + hysteresis gate. No wasm, no worklet.
 * Used automatically by `createVoiceGate` when the wasm path is unavailable.
 */
export function createLevelMeter(stream: MediaStream, opts: VoiceGateOptions = {}): VoiceGateHandle {
  const hub = new Hub()
  const c = contextFor(opts)
  let sensitivity = opts.sensitivity ?? 0.5
  const engine = startMeter(stream, c.ctx, sensitivity, hub)
  return handle(
    hub,
    c,
    () => engine,
    (s) => {
      sensitivity = s
      engine.setSensitivity(s)
    },
    () => engine.stop(),
  )
}

export async function createVoiceGate(stream: MediaStream, opts: VoiceGateOptions = {}): Promise<VoiceGateHandle> {
  const hub = new Hub()
  const c = contextFor(opts)
  let sensitivity = opts.sensitivity ?? 0.5
  let engine: Engine | null = null
  let stopped = false

  const fallBack = (err: unknown) => {
    if (stopped) return
    console.warn('[voice gate] falling back to the level meter:', err)
    engine = startMeter(stream, c.ctx, sensitivity, hub)
  }

  try {
    engine = await startWasm(stream, c, sensitivity, hub, fallBack)
  } catch (err) {
    fallBack(err)
  }

  return handle(
    hub,
    c,
    () => engine,
    (s) => {
      sensitivity = s
      engine?.setSensitivity(s)
    },
    () => {
      stopped = true
      engine?.stop()
    },
  )
}
