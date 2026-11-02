/**
 * The `moonshine` engine: open-source streaming speech recognition running
 * entirely in this tab (moonshine-wasm, Tiny Streaming model).
 *
 * Load this module with `await import('./moonshine')` (the registry does) so
 * it stays out of the main bundle. The heavy parts live further away still:
 * the transcriber runs in a dedicated worker with its own chunk, and its
 * 13 MB WebAssembly runtime and ~51 MB model are fetched on first use and kept
 * in Cache Storage for offline sessions.
 *
 * Audio: we tap the app's MediaStream with an AudioWorklet (no second
 * getUserMedia), downmix and resample to 16 kHz inside the worklet, and post
 * the PCM over a MessageChannel straight into the worker.
 */
import type { SpeechEngine, SpeechEngineEvents, SpeechEngineState, SpeechResult } from '../core/contracts'
import { Emitter, cleanText } from './emitter'
import { rankHints } from './hints'
import { MOONSHINE_LANGS, moonshineLang, moonshineSupported } from './moonshineSupport'
import type { FromWorker, ToWorker } from './moonshine.worker'

/**
 * Turns Moonshine's line events into the engine contract: a line's changing
 * text is the interim hypothesis for the utterance, its completion is the
 * final. A new line closes any line that never reported completion.
 */
export class LineTracker {
  private open: string | null = null
  private text = ''
  private readonly done: string[] = []

  constructor(private readonly emit: (r: SpeechResult) => void) {}

  update(id: string, raw: string) {
    if (this.done.includes(id)) return
    if (this.open !== null && this.open !== id) this.complete(this.open, this.text)
    this.open = id
    const text = cleanText(raw)
    if (!text || text === this.text) return
    this.text = text
    this.emit({ text, isFinal: false })
  }

  complete(id: string, raw: string) {
    if (this.done.includes(id)) return
    this.done.push(id)
    if (this.done.length > 64) this.done.shift()
    const wasOpen = this.open === id
    const text = cleanText(raw) || (wasOpen ? this.text : '')
    if (wasOpen) {
      this.open = null
      this.text = ''
    }
    if (text) this.emit({ text, isFinal: true })
  }

  /** Close whatever is still open (on stop). */
  flush() {
    if (this.open !== null) this.complete(this.open, this.text)
  }
}

/**
 * Capture worklet. Mixes to mono, resamples linearly to 16 kHz with the
 * fractional read position carried across render quanta, and posts ~64 ms
 * chunks through the port it is handed. Inlined by source because a worklet
 * has its own global scope.
 */
const CAPTURE_WORKLET = `
class DPMoonshineCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.out = null
    this.step = sampleRate / 16000
    this.pos = 0
    this.prev = 0
    this.buf = new Float32Array(1024)
    this.n = 0
    this.port.onmessage = (e) => { this.out = e.data }
  }
  process(inputs) {
    const chans = inputs[0]
    if (!this.out || !chans || !chans.length || !chans[0]) return true
    const len = chans[0].length
    const mono = new Float32Array(len)
    for (const c of chans) for (let i = 0; i < len; i++) mono[i] += c[i] / chans.length
    // pos is relative to mono[0]; index -1 is the previous quantum's last sample.
    while (this.pos < len - 1) {
      const i = Math.floor(this.pos)
      const f = this.pos - i
      const a = i < 0 ? this.prev : mono[i]
      const b = mono[i + 1]
      this.buf[this.n++] = a + (b - a) * f
      if (this.n === this.buf.length) {
        this.out.postMessage(this.buf, [this.buf.buffer])
        this.buf = new Float32Array(1024)
        this.n = 0
      }
      this.pos += this.step
    }
    this.pos -= len
    this.prev = mono[len - 1]
    return true
  }
}
registerProcessor('dp-moonshine-capture', DPMoonshineCapture)
`

/** One worker (and one loaded model) for the page, shared by every engine instance. */
interface Host {
  worker: Worker
  lang: string
  ready: Promise<void>
  listeners: Set<(msg: FromWorker) => void>
}
let host: Host | null = null

function getHost(lang: string, onMsg: (msg: FromWorker) => void): Host {
  if (host && host.lang !== lang) disposeMoonshine()
  if (!host) {
    const worker = new Worker(new URL('./moonshine.worker.ts', import.meta.url), { type: 'module', name: 'dp-moonshine' })
    const listeners = new Set<(msg: FromWorker) => void>()
    const ready = new Promise<void>((resolve, reject) => {
      const onLoad = (msg: FromWorker) => {
        if (msg.t === 'loaded') resolve()
        else if (msg.t === 'error' && msg.fatal) reject(new Error(msg.message))
        else return
        listeners.delete(onLoad)
      }
      listeners.add(onLoad)
      worker.onerror = (e) => reject(new Error(e.message || 'The Moonshine worker failed to start.'))
    })
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      for (const l of [...listeners]) l(e.data)
    }
    host = { worker, lang, ready, listeners }
    // Failed loads shouldn't poison later attempts.
    ready.catch(() => host?.worker === worker && disposeMoonshine())
    host.listeners.add(onMsg)
    send(host, { t: 'load', lang })
    return host
  }
  host.listeners.add(onMsg)
  return host
}

const send = (h: Host, msg: ToWorker, transfer: Transferable[] = []) => h.worker.postMessage(msg, transfer)

/** Terminate the worker and free the model's memory. The next start reloads it (from cache). */
export function disposeMoonshine() {
  host?.worker.terminate()
  host = null
}

const STOP_TIMEOUT_MS = 2000

export class MoonshineEngine implements SpeechEngine {
  readonly id = 'moonshine' as const
  private readonly events = new Emitter<SpeechEngineEvents>()
  private readonly tracker = new LineTracker((r) => this.events.emit('result', r))
  private host: Host | null = null
  private ctx: AudioContext | null = null
  private nodes: AudioNode[] = []
  private state: SpeechEngineState = 'idle'
  private running = false
  private gen = 0
  private terms: string[] = []
  private termsKey = ''

  private readonly onMsg = (msg: FromWorker) => {
    switch (msg.t) {
      case 'progress':
        this.events.emit('progress', { loaded: msg.loaded, total: msg.total })
        return
      case 'text':
        if (this.running) this.tracker.update(msg.id, msg.text)
        return
      case 'line':
        this.tracker.complete(msg.id, msg.text)
        return
      case 'error':
        // Load failures reject `ready` and surface through start().
        if (msg.fatal && this.running) this.fail(msg.message)
        else console.warn('[moonshine]', msg.message)
        return
    }
  }

  on<K extends keyof SpeechEngineEvents>(event: K, cb: (payload: SpeechEngineEvents[K]) => void): () => void {
    return this.events.on(event, cb)
  }

  async start(opts: { stream: MediaStream; lang: string; hints?: string[] }): Promise<void> {
    if (this.running || this.host) await this.stop()
    const gen = ++this.gen
    const lang = moonshineLang(opts.lang)
    try {
      if (!moonshineSupported()) throw new Error('Moonshine needs WebAssembly threads, which this page or browser does not allow.')
      if (!(MOONSHINE_LANGS as readonly string[]).includes(lang)) throw new Error(`Moonshine has no streaming model for ${opts.lang}.`)
      if (!opts.stream.getAudioTracks().some((t) => t.readyState === 'live'))
        throw new Error('The microphone stream has no live audio track.')
      if (opts.hints) this.setHints(opts.hints)
      this.setState('loading', 'Loading the on-device speech model…')
      const h = (this.host = getHost(lang, this.onMsg))
      await h.ready
      if (gen !== this.gen) return
      if (this.terms.length) send(h, { t: 'keyterms', terms: this.terms })

      const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }))
      if (ctx.state === 'suspended') await ctx.resume()
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      if (gen !== this.gen) return
      const source = ctx.createMediaStreamSource(opts.stream)
      const node = new AudioWorkletNode(ctx, 'dp-moonshine-capture', { numberOfOutputs: 1, outputChannelCount: [1] })
      source.connect(node)
      // The worklet writes silence; connecting it keeps the graph pulling audio.
      node.connect(ctx.destination)
      this.nodes = [source, node]
      const ch = new MessageChannel()
      node.port.postMessage(ch.port1, [ch.port1])
      send(h, { t: 'audio', port: ch.port2 }, [ch.port2])
      send(h, { t: 'start' })
      this.running = true
      this.setState('listening')
    } catch (err) {
      if (gen !== this.gen) return
      const message = err instanceof Error ? err.message : String(err)
      await this.teardown()
      this.setState('error', message)
      throw err instanceof Error ? err : new Error(message)
    }
  }

  async stop(): Promise<void> {
    this.gen++
    const h = this.host
    const wasRunning = this.running
    this.running = false
    // Stop feeding audio first, then let the worker flush its last line.
    for (const n of this.nodes) n.disconnect()
    this.nodes = []
    if (h && wasRunning) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, STOP_TIMEOUT_MS)
        const onStopped = (msg: FromWorker) => msg.t === 'stopped' && done()
        function done() {
          clearTimeout(timer)
          h!.listeners.delete(onStopped)
          resolve()
        }
        h.listeners.add(onStopped)
        send(h, { t: 'stop' })
      })
    }
    await this.teardown()
    if (this.state !== 'idle') this.setState('idle')
  }

  /** Moonshine key terms: the rarest upcoming words. It has no per-term weights, so we keep the list short. */
  setHints(words: string[]): void {
    const terms = rankHints(words, { max: 16 })
      .filter((h) => h.weight >= 0.5)
      .map((h) => h.text)
    const key = terms.join('\u0000')
    if (key === this.termsKey) return
    this.termsKey = key
    this.terms = terms
    if (this.host) send(this.host, { t: 'keyterms', terms })
  }

  private async teardown() {
    for (const n of this.nodes) n.disconnect()
    this.nodes = []
    const ctx = this.ctx
    this.ctx = null
    // Never stop the app's tracks: the stream belongs to the caller.
    await ctx?.close().catch(() => undefined)
    this.tracker.flush()
    this.host?.listeners.delete(this.onMsg)
    this.host = null
  }

  private setState(state: SpeechEngineState, message?: string) {
    this.state = state
    this.events.emit('state', message === undefined ? { state } : { state, message })
  }

  private fail(message: string) {
    if (this.state === 'error') return
    this.gen++
    this.running = false
    void this.teardown()
    this.setState('error', message)
  }
}

export const createMoonshineEngine = () => new MoonshineEngine()
