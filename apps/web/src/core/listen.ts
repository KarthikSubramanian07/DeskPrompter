/**
 * Listening: microphone → voice gate (Zig/wasm) → speech engine → aligner
 * (Rust/wasm) → prompter. One instance per stage session.
 *
 *  breath mode: the gate alone drives a 0..1 scroll multiplier.
 *  voice mode:  the engine's words are aligned to the script; the prompter
 *               chases the aligner's lead and every committed word is stamped
 *               for caption export.
 */
import { signal } from '@preact/signals'
import type { AlignResult, PrompterMode, ScriptAligner, SpeechEngine, SpeechEngineId, VoiceSample } from './contracts'
import type { Prompter } from './prompter'
import { aligner as alignerModule, loadAlignerOnce } from './parser'
import { rollingWpm, type WordStamp } from './timing'
import { createBreath, type Breath } from '../audio/breath'
import { createVoiceGate, type VoiceGateHandle } from '../audio/voiceGate'

export type ListenState = 'off' | 'starting' | 'listening' | 'error'

export interface ListenOptions {
  engine: SpeechEngineId | 'auto'
  allowCloud: boolean
  sensitivity: number
}

const ENGINE_LABEL: Record<SpeechEngineId, string> = {
  'chrome-local': 'Listening on this device',
  moonshine: 'Listening on this device',
  'cloud-web-speech': 'Listening via your browser’s cloud service',
}

/**
 * Streaming engines only finalize at pauses. While tracking confidently, words
 * two or more behind the lead count as read: an interim hypothesis's prefix is
 * stable, so continuous speech still paints and stamps as you go.
 */
export function settledCursor(r: AlignResult): number {
  if (r.state === 'tracking' && r.confidence >= 0.5) return Math.max(r.cursor, r.lead - 2)
  return r.cursor
}

export class Listener {
  readonly level = signal<VoiceSample>({ level: 0, speaking: false })
  readonly state = signal<ListenState>('off')
  readonly status = signal('')
  readonly track = signal<AlignResult | null>(null)
  readonly stamps: WordStamp[] = []

  private stream: MediaStream | null = null
  private gate: VoiceGateHandle | null = null
  private engine: SpeechEngine | null = null
  private aligner: ScriptAligner | null = null
  private breath: Breath = createBreath()
  private offs: (() => void)[] = []
  private raf = 0
  private t0 = 0
  private mode: PrompterMode = 'manual'
  private run = 0

  constructor(
    private readonly prompter: Prompter,
    private readonly text: string,
    private readonly words: () => string[],
  ) {}

  /** (Re)start for a mode. Safe to call repeatedly; manual mode just stops. */
  async start(mode: PrompterMode, opts: ListenOptions): Promise<void> {
    const run = ++this.run
    await this.stopInner()
    this.mode = mode
    if (mode === 'manual') return
    this.state.value = 'starting'
    this.status.value = 'Asking for the microphone…'
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      })
    } catch {
      if (run !== this.run) return
      this.fail('Microphone blocked. Allow it in the address bar, or use Steady mode.')
      return
    }
    if (run !== this.run) return this.releaseStream()

    this.gate = await createVoiceGate(this.stream, { sensitivity: opts.sensitivity })
    if (run !== this.run) return
    this.offs.push(this.gate.subscribe((s) => (this.level.value = s)))
    this.loop()

    if (mode === 'breath') {
      this.state.value = 'listening'
      this.status.value = 'Breath mode: scrolls while you speak'
      return
    }

    // Voice mode.
    const mod = alignerModule.value ?? (await loadAlignerOnce())
    if (run !== this.run) return
    if (!mod) return this.fail('Voice-follow couldn’t load here. Try Breath mode.')
    this.aligner = mod.createAligner(this.text)
    const startAt = Math.max(-1, this.prompter.wordAtLine() - 1)
    if (startAt >= 0) this.aligner.setCursor(startAt)

    const registry = await import('../speech/registry')
    const { pickHintWords } = await import('../speech/hints')
    let id: SpeechEngineId | null = opts.engine === 'auto' ? await registry.pickDefaultEngine({ allowCloud: opts.allowCloud }) : opts.engine
    if (run !== this.run) return
    if (!id) return this.fail('No on-device speech engine here. Breath mode works everywhere.')
    try {
      this.engine = await registry.createEngine(id)
    } catch (e) {
      return this.fail(`Couldn’t start speech recognition (${e instanceof Error ? e.message : e}).`)
    }
    if (run !== this.run) return void this.engine.stop()

    const engine = this.engine
    const hint = (cursor: number) => engine.setHints?.(pickHintWords(this.words(), cursor))
    this.offs.push(
      engine.on('state', ({ state, message }) => {
        if (state === 'listening') {
          this.state.value = 'listening'
          this.status.value = ENGINE_LABEL[id!]
        } else if (state === 'loading') {
          this.state.value = 'starting'
          this.status.value = message ?? 'Loading the speech model…'
        } else if (state === 'error') this.fail(message ?? 'Speech recognition stopped.')
      }),
      engine.on('progress', ({ loaded, total }) => {
        if (total > 0) this.status.value = `Downloading the speech model · ${Math.round((loaded / total) * 100)}%`
      }),
      engine.on('result', ({ text, isFinal }) => {
        if (!this.aligner || !this.prompter.playing) return
        const r = this.aligner.feed(text, isFinal)
        this.track.value = r
        if (!r.changed) return
        const settled = settledCursor(r)
        const before = this.stamps.at(-1)?.wi ?? -1
        this.prompter.follow(settled, r.lead)
        if (settled > before) {
          this.stampUpTo(settled)
          hint(settled)
        }
        this.prompter.voiceWpm = rollingWpm(this.stamps, performance.now() - this.t0)
      }),
    )
    // Hand-scrolls and taps resync the tracker.
    const prev = this.prompter.events.manualSeek
    this.prompter.events.manualSeek = (wi) => {
      prev?.(wi)
      this.aligner?.setCursor(Math.max(-1, wi - 1))
    }
    this.offs.push(() => (this.prompter.events.manualSeek = prev))

    this.t0 = performance.now()
    hint(startAt)
    try {
      await engine.start({ stream: this.stream!, lang: navigator.language || 'en-US', hints: pickHintWords(this.words(), startAt) })
    } catch (e) {
      this.fail(`Couldn’t start speech recognition (${e instanceof Error ? e.message : e}).`)
    }
  }

  /** Words between the last stamp and `cursor` get evenly spaced times up to now. */
  private stampUpTo(cursor: number) {
    const now = performance.now() - this.t0
    const last = this.stamps.at(-1)
    const fromWi = (last?.wi ?? -1) + 1
    const fromT = last ? last.t : Math.max(0, now - (cursor - fromWi + 1) * 350)
    const n = cursor - fromWi + 1
    for (let i = 0; i < n; i++) this.stamps.push({ wi: fromWi + i, t: fromT + ((now - fromT) * (i + 1)) / n })
  }

  private loop() {
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const s = this.level.value
      this.prompter.speaking = s.speaking
      if (this.mode === 'breath') this.prompter.breath = this.breath.update(s, dt)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  private fail(msg: string) {
    this.state.value = 'error'
    this.status.value = msg
  }

  private releaseStream() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
  }

  private async stopInner() {
    cancelAnimationFrame(this.raf)
    for (const off of this.offs.splice(0)) off()
    const engine = this.engine
    this.engine = null
    await engine?.stop().catch(() => {})
    this.gate?.stop()
    this.gate = null
    this.aligner?.dispose()
    this.aligner = null
    this.releaseStream()
    this.breath.reset()
    this.prompter.breath = 0
    this.prompter.speaking = false
    this.level.value = { level: 0, speaking: false }
    this.state.value = 'off'
    this.status.value = ''
  }

  async stop() {
    this.run++
    await this.stopInner()
  }
}
