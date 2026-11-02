/**
 * The browser's own speech recognizer, as two engines from one implementation.
 *
 * - `chrome-local`: Chrome 139+ with `processLocally = true`. Audio stays on
 *   the device. Chrome may need to download a language pack first, which we
 *   trigger with `SpeechRecognition.install()` and report as progress.
 * - `cloud-web-speech`: the classic API. Chrome sends audio to Google, Safari
 *   to Apple. Explicit opt-in only; the registry never picks it by default.
 *
 * Contract mapping: every `result` carries the whole current utterance. Chrome
 * keeps a growing `results` list per session; we commit finals in order and
 * emit the non-final tail as the interim hypothesis. Sessions end on silence,
 * on network hiccups, and (Android) after every phrase, so while active we
 * restart on `end` with a short backoff.
 */
import type {
  EngineAvailability,
  SpeechEngine,
  SpeechEngineEvents,
  SpeechEngineId,
  SpeechEngineState,
} from '../core/contracts'
import { Emitter, cleanText } from './emitter'
import { hintBoost, rankHints, type RankedHint } from './hints'

export type WebSpeechId = Extract<SpeechEngineId, 'chrome-local' | 'cloud-web-speech'>

/** Everything the engine touches in the outside world, injectable for tests. */
export interface WebSpeechEnv {
  Recognition?: DPSpeechRecognitionCtor
  Phrase?: DPSpeechRecognitionPhraseCtor
  /** Android Chrome ignores `continuous` and repeats text across results. */
  android: boolean
  now: () => number
}

export function webSpeechEnv(g: typeof globalThis = globalThis): WebSpeechEnv {
  const w = g as unknown as DPSpeechGlobals
  return {
    Recognition: w.SpeechRecognition ?? w.webkitSpeechRecognition,
    Phrase: w.SpeechRecognitionPhrase,
    android: /Android/i.test(g.navigator?.userAgent ?? ''),
    now: () => Date.now(),
  }
}

/** True when this browser can be told to keep recognition on the device. */
export function supportsLocal(env: WebSpeechEnv): boolean {
  const R = env.Recognition
  return !!R && typeof R.available === 'function' && typeof R.install === 'function' && 'processLocally' in R.prototype
}

/** Probe without starting anything. On-device 'downloading' counts as 'downloadable'. */
export async function probeWebSpeech(id: WebSpeechId, lang: string, env = webSpeechEnv()): Promise<EngineAvailability> {
  const R = env.Recognition
  if (!R) return 'unavailable'
  if (id === 'cloud-web-speech') {
    if (typeof R.available !== 'function') return 'available'
    try {
      return (await R.available({ langs: [lang], processLocally: false })) === 'unavailable' ? 'unavailable' : 'available'
    } catch {
      return 'available'
    }
  }
  if (!supportsLocal(env)) return 'unavailable'
  try {
    const status = await R.available!({ langs: [lang], processLocally: true })
    return status === 'available' ? 'available' : status === 'unavailable' ? 'unavailable' : 'downloadable'
  } catch {
    return 'unavailable'
  }
}

/** Errors after which restarting is pointless. */
const FATAL: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked for speech recognition.',
  'service-not-allowed': 'The browser refused to run speech recognition here.',
  'audio-capture': 'Speech recognition could not read the microphone.',
  'language-not-supported': 'Speech recognition does not support this language.',
}

/** A session shorter than this counts as a "quick end" and backs off the restart. */
const QUICK_END_MS = 1000
const MAX_QUICK_ENDS = 8
const STOP_TIMEOUT_MS = 1500
const INSTALL_POLL_MS = 1000
const INSTALL_TIMEOUT_MS = 10 * 60_000

class EngineError extends Error {}

export class WebSpeechEngine implements SpeechEngine {
  readonly id: WebSpeechId
  private readonly local: boolean
  private readonly env: WebSpeechEnv
  private readonly events = new Emitter<SpeechEngineEvents>()

  private rec: DPSpeechRecognition | null = null
  private track: MediaStreamTrack | undefined
  private active = false
  /** Bumped by every start/stop so stale async work and events are ignored. */
  private gen = 0
  private state: SpeechEngineState = 'idle'

  /** Results [0, committed) of the current session have been emitted as finals. */
  private committed = 0
  /** Last interim text we emitted for the open utterance ('' when none is open). */
  private interim = ''
  /** Android: last final in this session, to drop its frequent duplicates. */
  private lastFinal = ''

  private sessionStart = 0
  private quickEnds = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined

  private hints: RankedHint[] = []
  private hintKey = ''
  private phrasesBroken = false

  constructor(id: WebSpeechId, env: WebSpeechEnv = webSpeechEnv()) {
    this.id = id
    this.local = id === 'chrome-local'
    this.env = env
  }

  on<K extends keyof SpeechEngineEvents>(event: K, cb: (payload: SpeechEngineEvents[K]) => void): () => void {
    return this.events.on(event, cb)
  }

  async start(opts: { stream: MediaStream; lang: string; hints?: string[] }): Promise<void> {
    if (this.active || this.rec) await this.stop()
    const gen = ++this.gen
    const R = this.env.Recognition
    try {
      if (!R) throw new EngineError('This browser has no built-in speech recognition.')
      this.track = opts.stream.getAudioTracks().find((t) => t.readyState === 'live')
      if (!this.track) throw new EngineError('The microphone stream has no live audio track.')
      if (opts.hints) this.setHints(opts.hints)
      this.setState('loading')
      if (this.local) await this.ensureLocalModel(R, opts.lang, gen)
      if (gen !== this.gen) return

      const rec = new R()
      rec.lang = opts.lang
      // Android ignores continuous anyway; asking for single-shot there makes
      // its sessions behave predictably and we restart after each one.
      rec.continuous = !this.env.android
      rec.interimResults = true
      rec.maxAlternatives = 1
      if (this.local) rec.processLocally = true
      rec.onstart = () => gen === this.gen && this.onSessionStart()
      rec.onresult = (e) => gen === this.gen && this.onResult(e)
      rec.onerror = (e) => gen === this.gen && this.onError(e)
      rec.onend = () => gen === this.gen && this.onEnd()
      this.rec = rec
      this.active = true
      this.quickEnds = 0
      this.applyPhrases()
      this.begin()
    } catch (err) {
      if (gen !== this.gen) return
      this.active = false
      this.rec = null
      const message = err instanceof EngineError ? err.message : `Speech recognition failed to start: ${String(err)}`
      this.setState('error', message)
      throw err instanceof EngineError ? err : new EngineError(message)
    }
  }

  async stop(): Promise<void> {
    const rec = this.rec
    this.gen++
    this.active = false
    clearTimeout(this.restartTimer)
    if (rec) {
      // stop() lets the recognizer deliver its last final before `end`.
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          try {
            rec.abort()
          } catch {
            /* already gone */
          }
          done()
        }, STOP_TIMEOUT_MS)
        rec.onresult = (e) => this.onResult(e)
        rec.onerror = null
        rec.onend = () => {
          this.closeUtterance()
          done()
        }
        try {
          rec.stop()
        } catch {
          done()
        }
      })
      rec.onstart = rec.onresult = rec.onerror = rec.onend = null
    }
    this.closeUtterance()
    this.rec = null
    this.track = undefined
    if (this.state !== 'idle') this.setState('idle')
  }

  /**
   * Bias toward the coming script words with SpeechRecognitionPhrase boosts.
   * Applied to the live object; Chrome reads them when a session starts, so
   * they land on the next automatic restart (sessions restart every utterance
   * on Android and after each pause elsewhere).
   */
  setHints(words: string[]): void {
    const ranked = rankHints(words, { max: 32 })
    const key = ranked.map((h) => h.text).join('\u0000')
    if (key === this.hintKey) return
    this.hintKey = key
    this.hints = ranked
    this.applyPhrases()
  }

  /* ───────────── internals ───────────── */

  private setState(state: SpeechEngineState, message?: string) {
    this.state = state
    this.events.emit('state', message === undefined ? { state } : { state, message })
  }

  private async ensureLocalModel(R: DPSpeechRecognitionCtor, lang: string, gen: number) {
    if (!supportsLocal(this.env)) throw new EngineError('On-device speech recognition needs Chrome 139 or newer.')
    const opts = { langs: [lang], processLocally: true }
    let status = await R.available!(opts)
    if (status === 'available') return
    if (status === 'unavailable') throw new EngineError(`Chrome has no on-device speech model for ${lang}.`)
    // 'downloadable' may just be Chrome hiding an installed pack from a new
    // origin; install() resolves at once in that case.
    this.setState('loading', 'Getting Chrome’s on-device speech model ready…')
    this.events.emit('progress', { loaded: 0, total: 1 })
    let ok: boolean
    try {
      ok = await R.install!(opts)
    } catch (err) {
      if ((err as { name?: string })?.name === 'NotAllowedError')
        throw new EngineError('Chrome needs a click to download its on-device speech model. Press start again.')
      throw new EngineError(`Chrome could not install its on-device speech model: ${String(err)}`)
    }
    if (!ok) throw new EngineError(`Chrome could not install an on-device speech model for ${lang}.`)
    const deadline = this.env.now() + INSTALL_TIMEOUT_MS
    // install() may resolve when the download starts rather than ends.
    while ((status = await R.available!(opts)) !== 'available') {
      if (gen !== this.gen) return
      if (status === 'unavailable') throw new EngineError(`Chrome has no on-device speech model for ${lang}.`)
      if (this.env.now() > deadline) throw new EngineError('Chrome’s speech model download timed out.')
      await new Promise((r) => setTimeout(r, INSTALL_POLL_MS))
    }
    this.events.emit('progress', { loaded: 1, total: 1 })
  }

  private begin() {
    const rec = this.rec
    if (!this.active || !rec) return
    this.committed = 0
    this.lastFinal = ''
    this.sessionStart = this.env.now()
    const track = this.track
    if (track && track.readyState !== 'live') return this.fail('The microphone stopped.')
    try {
      // Engines without start(track) ignore the argument and open the default mic.
      if (track) rec.start(track)
      else rec.start()
    } catch (err) {
      // InvalidStateError: a previous session hasn't fully ended. Try again soon.
      if ((err as { name?: string })?.name === 'InvalidStateError') this.scheduleRestart(250)
      else this.fail(`Speech recognition failed to start: ${String(err)}`)
    }
  }

  private onSessionStart() {
    if (this.state !== 'listening') this.setState('listening')
  }

  private onResult(e: SpeechRecognitionEvent) {
    const results = e.results
    if (this.env.android) return this.onAndroidResult(results)
    // Commit finals in order. Anything after the first non-final is the open utterance.
    while (this.committed < results.length && results[this.committed]!.isFinal) {
      this.emitFinal(transcript(results[this.committed]!))
      this.committed++
    }
    let tail = ''
    for (let i = this.committed; i < results.length; i++) tail += ' ' + transcript(results[i]!)
    this.emitInterim(cleanText(tail))
  }

  /**
   * Android Chrome returns one cumulative result per session, sometimes with
   * the same final repeated. The newest result is the whole utterance.
   */
  private onAndroidResult(results: SpeechRecognitionResultList) {
    const last = results[results.length - 1]
    if (!last) return
    const text = cleanText(transcript(last))
    if (last.isFinal) {
      if (text && text === this.lastFinal) return
      this.lastFinal = text
      this.emitFinal(text)
    } else this.emitInterim(text)
  }

  private emitInterim(text: string) {
    if (!text || text === this.interim) return
    this.interim = text
    this.events.emit('result', { text, isFinal: false })
  }

  /** Close the open utterance. An empty final falls back to the last interim, so every utterance ends. */
  private emitFinal(raw: string) {
    const text = cleanText(raw) || this.interim
    this.interim = ''
    if (text) this.events.emit('result', { text, isFinal: true })
  }

  /** Sessions can end mid-utterance; promote the hanging interim so the next result starts fresh. */
  private closeUtterance() {
    if (this.interim) this.emitFinal('')
  }

  private onError(e: SpeechRecognitionErrorEvent) {
    const code = e.error as string
    if (code === 'no-speech' || code === 'aborted') return // `end` follows; we restart there.
    if (code === 'phrases-not-supported') {
      // The session was aborted before it began. Drop biasing and let `end` restart us.
      this.phrasesBroken = true
      if (this.rec) this.rec.phrases = []
      return
    }
    if (code === 'network') return // Cloud only; `end` follows and backoff handles flapping.
    const fatal = FATAL[code]
    if (fatal) this.fail(this.local && code === 'service-not-allowed' ? 'Chrome would not run its on-device speech model.' : fatal)
  }

  private onEnd() {
    this.closeUtterance()
    if (!this.active) return
    const lasted = this.env.now() - this.sessionStart
    this.quickEnds = lasted < QUICK_END_MS ? this.quickEnds + 1 : 0
    if (this.quickEnds > MAX_QUICK_ENDS) return this.fail('Speech recognition keeps stopping. Try another engine.')
    this.scheduleRestart(this.quickEnds ? Math.min(4000, 125 * 2 ** this.quickEnds) : 0)
  }

  private scheduleRestart(ms: number) {
    clearTimeout(this.restartTimer)
    const gen = this.gen
    this.restartTimer = setTimeout(() => gen === this.gen && this.begin(), ms)
  }

  private fail(message: string) {
    this.active = false
    clearTimeout(this.restartTimer)
    try {
      this.rec?.abort()
    } catch {
      /* already gone */
    }
    this.closeUtterance()
    this.setState('error', message)
  }

  private applyPhrases() {
    const rec = this.rec
    const Phrase = this.env.Phrase
    if (!rec || !Phrase || this.phrasesBroken || !('phrases' in rec)) return
    try {
      rec.phrases = this.hints.map((h) => new Phrase(h.text, hintBoost(h.weight)))
    } catch {
      this.phrasesBroken = true
    }
  }
}

const transcript = (r: SpeechRecognitionResult) => r[0]?.transcript ?? ''
