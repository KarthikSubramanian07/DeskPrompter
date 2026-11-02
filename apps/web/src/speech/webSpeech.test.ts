import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechResult } from '../core/contracts'
import { WebSpeechEngine, probeWebSpeech, supportsLocal, type WebSpeechEnv } from './webSpeech'

/* ───────────── a scriptable SpeechRecognition ───────────── */

type Seg = [text: string, isFinal: boolean]

class MockPhrase {
  constructor(
    readonly phrase: string,
    readonly boost = 1,
  ) {}
}

function makeMock(opts: { status?: DPSpeechAvailability; local?: boolean } = {}) {
  const instances: MockRec[] = []
  class MockRec extends EventTarget {
    static status: DPSpeechAvailability = opts.status ?? 'available'
    static available = vi.fn(async () => MockRec.status)
    static install = vi.fn(async () => {
      MockRec.status = 'available'
      return true
    })
    lang = ''
    continuous = false
    interimResults = false
    maxAlternatives = 1
    phrases: MockPhrase[] = []
    running = false
    starts: (MediaStreamTrack | undefined)[] = []
    onstart: (() => void) | null = null
    onend: (() => void) | null = null
    onresult: ((e: unknown) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    constructor() {
      super()
      instances.push(this)
    }
    start(track?: MediaStreamTrack) {
      if (this.running) throw Object.assign(new Error('already started'), { name: 'InvalidStateError' })
      this.running = true
      this.starts.push(track)
      queueMicrotask(() => this.onstart?.())
    }
    stop() {
      queueMicrotask(() => this.end())
    }
    abort() {
      this.end()
    }
    end() {
      if (!this.running) return
      this.running = false
      this.onend?.()
    }
    /** Fire a result event whose list is `segs` (Chrome's cumulative session list). */
    say(...segs: Seg[]) {
      const results = segs.map(([text, isFinal]) => Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal }))
      this.onresult?.({ resultIndex: 0, results })
    }
    fail(error: string) {
      this.onerror?.({ error, message: '' })
    }
  }
  if (opts.local !== false) Object.defineProperty(MockRec.prototype, 'processLocally', { value: false, writable: true })
  else {
    // A browser without the on-device API.
    ;(MockRec as { available?: unknown }).available = undefined
    ;(MockRec as { install?: unknown }).install = undefined
  }
  return { MockRec, instances }
}

const track = (readyState: MediaStreamTrackState = 'live') => ({ kind: 'audio', readyState }) as unknown as MediaStreamTrack
const stream = (t = track()) => ({ getAudioTracks: () => [t] }) as unknown as MediaStream

function setup(opts: Parameters<typeof makeMock>[0] & { android?: boolean; id?: 'chrome-local' | 'cloud-web-speech' } = {}) {
  const { MockRec, instances } = makeMock(opts)
  let clock = 0
  const env: WebSpeechEnv = {
    Recognition: MockRec as unknown as DPSpeechRecognitionCtor,
    Phrase: MockPhrase as unknown as DPSpeechRecognitionPhraseCtor,
    android: opts.android ?? false,
    now: () => clock,
  }
  const engine = new WebSpeechEngine(opts.id ?? 'chrome-local', env)
  const results: SpeechResult[] = []
  const states: string[] = []
  engine.on('result', (r) => results.push(r))
  engine.on('state', (s) => states.push(s.state + (s.message ? `:${s.message}` : '')))
  return { engine, MockRec, instances, results, states, tick: (ms: number) => (clock += ms), rec: () => instances.at(-1)! }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/* ───────────── tests ───────────── */

describe('WebSpeechEngine result mapping', () => {
  it('emits the whole utterance as it grows, then one final', async () => {
    const t = setup()
    await t.engine.start({ stream: stream(), lang: 'en-US' })
    const rec = t.rec()
    rec.say(['good', false])
    rec.say(['good evening', false])
    rec.say(['good evening', false]) // duplicate: not re-emitted
    rec.say(['Good evening.', true])
    expect(t.results).toEqual([
      { text: 'good', isFinal: false },
      { text: 'good evening', isFinal: false },
      { text: 'Good evening.', isFinal: true },
    ])
  })

  it('starts a fresh utterance after a final, ignoring already-committed results', async () => {
    const t = setup()
    await t.engine.start({ stream: stream(), lang: 'en-US' })
    const rec = t.rec()
    rec.say(['hello there', true], [' and', false])
    rec.say(['hello there', true], [' and welcome', false], [' to', false])
    rec.say(['hello there', true], [' and welcome to the show', true])
    expect(t.results).toEqual([
      { text: 'hello there', isFinal: true },
      { text: 'and', isFinal: false },
      { text: 'and welcome to', isFinal: false },
      { text: 'and welcome to the show', isFinal: true },
    ])
  })

  it('closes a hanging interim as final when the session ends', async () => {
    const t = setup()
    await t.engine.start({ stream: stream(), lang: 'en-US' })
    t.rec().say(['tonight we', false])
    t.rec().end()
    expect(t.results.at(-1)).toEqual({ text: 'tonight we', isFinal: true })
  })

  it('on Android takes only the newest cumulative result and drops repeated finals', async () => {
    const t = setup({ android: true })
    await t.engine.start({ stream: stream(), lang: 'en-US' })
    const rec = t.rec()
    expect(rec.continuous).toBe(false)
    rec.say(['hello', false])
    rec.say(['hello world', false])
    rec.say(['hello', true], ['hello world', true])
    rec.say(['hello', true], ['hello world', true])
    expect(t.results).toEqual([
      { text: 'hello', isFinal: false },
      { text: 'hello world', isFinal: false },
      { text: 'hello world', isFinal: true },
    ])
  })
})

describe('WebSpeechEngine lifecycle', () => {
  it('configures continuous, interim, on-device recognition on the app track', async () => {
    const t = setup()
    const tr = track()
    await t.engine.start({ stream: stream(tr), lang: 'en-GB' })
    const rec = t.rec() as unknown as DPSpeechRecognition & { starts: unknown[] }
    expect(rec.lang).toBe('en-GB')
    expect(rec.continuous).toBe(true)
    expect(rec.interimResults).toBe(true)
    expect(rec.processLocally).toBe(true)
    expect(rec.starts).toEqual([tr])
    await vi.runAllTimersAsync()
    expect(t.states).toEqual(['loading', 'listening'])
  })

  it('cloud mode never sets processLocally', async () => {
    const t = setup({ id: 'cloud-web-speech' })
    await t.engine.start({ stream: stream(), lang: 'en-US' })
    expect((t.rec() as unknown as DPSpeechRecognition).processLocally).toBeFalsy()
    expect(t.MockRec.available).not.toHaveBeenCalled()
  })

  it('auto-restarts on end and after no-speech while active', async () => {
    const t = setup()
    await t.engine.start({ stream: stream(), lang: 'en-US' })
    const rec = t.rec()
    t.tick(5000)
    rec.fail('no-speech')
    rec.end()
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.starts).toHaveLength(2)
    expect(t.states).not.toContain('error')
  })

  it('backs off when sessions keep ending immediately, then gives up', async () => {
    const t = setup()
    await t.engine.start({ stream: stream(), lang: 'en-US' })
    const rec = t.rec()
    rec.end() // lasted 0 ms
    await vi.advanceTimersByTimeAsync(100)
    expect(rec.starts).toHaveLength(1) // waiting out the backoff
    await vi.advanceTimersByTimeAsync(200)
    expect(rec.starts).toHaveLength(2)
    for (let i = 0; i < 10; i++) {
      rec.end()
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(t.states.at(-1)).toMatch(/^error:/)
  })

  it('stops for good on fatal errors', async () => {
    const t = setup()
    await t.engine.start({ stream: stream(), lang: 'en-US' })
    const rec = t.rec()
    rec.fail('not-allowed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(rec.starts).toHaveLength(1)
    expect(t.states.at(-1)).toMatch(/^error:Microphone access/)
  })

  it('stop() delivers the last final, does not restart, and goes idle', async () => {
    const t = setup()
    await t.engine.start({ stream: stream(), lang: 'en-US' })
    const rec = t.rec()
    rec.say(['the end', false])
    const stopped = t.engine.stop()
    await vi.runAllTimersAsync()
    await stopped
    expect(t.results.at(-1)).toEqual({ text: 'the end', isFinal: true })
    expect(rec.starts).toHaveLength(1)
    expect(t.states.at(-1)).toBe('idle')
  })

  it('downloads the on-device model when Chrome reports it downloadable', async () => {
    const t = setup({ status: 'downloadable' })
    const progress: number[] = []
    t.engine.on('progress', (p) => progress.push(p.loaded / p.total))
    await t.engine.start({ stream: stream(), lang: 'en-US' })
    expect(t.MockRec.install).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true })
    expect(progress).toEqual([0, 1])
    expect(t.instances).toHaveLength(1)
  })

  it('refuses to start when the language has no on-device model', async () => {
    const t = setup({ status: 'unavailable' })
    await expect(t.engine.start({ stream: stream(), lang: 'xx' })).rejects.toThrow(/no on-device/)
    expect(t.instances).toHaveLength(0)
    expect(t.states.at(-1)).toMatch(/^error:/)
  })

  it('rejects a stream without a live audio track', async () => {
    const t = setup()
    await expect(t.engine.start({ stream: stream(track('ended')), lang: 'en-US' })).rejects.toThrow(/live audio/)
  })
})

describe('WebSpeechEngine hints', () => {
  it('sets deduped phrases with rarer words boosted more', async () => {
    const t = setup()
    await t.engine.start({ stream: stream(), lang: 'en-US', hints: ['the', 'Kubernetes', 'cluster', 'the', 'cluster'] })
    const phrases = t.rec().phrases
    expect(phrases.map((p) => p.phrase)).toEqual(['Kubernetes', 'cluster'])
    expect(phrases[0]!.boost).toBeGreaterThan(phrases[1]!.boost)
  })

  it('drops phrases and keeps going when the browser rejects them', async () => {
    const t = setup()
    await t.engine.start({ stream: stream(), lang: 'en-US', hints: ['Kubernetes'] })
    const rec = t.rec()
    rec.fail('phrases-not-supported')
    rec.end()
    await vi.advanceTimersByTimeAsync(1000)
    expect(rec.phrases).toEqual([])
    expect(rec.starts.length).toBeGreaterThanOrEqual(2)
    t.engine.setHints(['Ceph'])
    expect(rec.phrases).toEqual([])
    expect(t.states).not.toContain('error')
  })
})

describe('probeWebSpeech', () => {
  it('maps on-device statuses onto engine availability', async () => {
    for (const [status, want] of [
      ['available', 'available'],
      ['downloadable', 'downloadable'],
      ['downloading', 'downloadable'],
      ['unavailable', 'unavailable'],
    ] as const) {
      const { MockRec } = makeMock({ status })
      const env = { Recognition: MockRec as unknown as DPSpeechRecognitionCtor, android: false, now: () => 0 }
      expect(await probeWebSpeech('chrome-local', 'en-US', env)).toBe(want)
    }
  })

  it('reports on-device unavailable without the Chrome 139 API, cloud still available', async () => {
    const { MockRec } = makeMock({ local: false })
    const env = { Recognition: MockRec as unknown as DPSpeechRecognitionCtor, android: false, now: () => 0 }
    expect(supportsLocal(env)).toBe(false)
    expect(await probeWebSpeech('chrome-local', 'en-US', env)).toBe('unavailable')
    expect(await probeWebSpeech('cloud-web-speech', 'en-US', env)).toBe('available')
  })

  it('reports everything unavailable without SpeechRecognition', async () => {
    const env = { android: false, now: () => 0 }
    expect(await probeWebSpeech('chrome-local', 'en-US', env)).toBe('unavailable')
    expect(await probeWebSpeech('cloud-web-speech', 'en-US', env)).toBe('unavailable')
  })
})
