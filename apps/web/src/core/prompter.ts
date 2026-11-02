/**
 * The prompter engine: renders a parsed script into a column of word spans,
 * measures where every word sits, and moves the column so the right word is on
 * the reading line. It owns its own rAF loop and touches the DOM directly;
 * Preact only mounts it.
 *
 * Coordinates: `y` is a position in the column (px) that sits on the reading
 * line. The column is translated by (eyelinePx - y).
 */
import type { ParsedScript, PrompterMode } from './contracts'
import { clamp, smoothDamp, type Damped } from './springs'

export interface PrompterOptions {
  mode: PrompterMode
  speed: number // 1..10
  eyeline: number // 0..1
  dimPast: boolean
}

export interface PrompterEvents {
  /** Fired ~10x a second with progress information. */
  tick?: (p: { progress: number; y: number; wordAtLine: number; playing: boolean }) => void
  /** The user scrolled or tapped by hand (voice mode should resync to this word). */
  manualSeek?: (wi: number) => void
  end?: () => void
}

export const speedToWpm = (speed: number) => 80 + (clamp(speed, 1, 10) - 1) * 20

export class Prompter {
  readonly viewport: HTMLElement
  readonly column: HTMLElement
  private parsed: ParsedScript = { blocks: [], wordCount: 0 }
  private spans: HTMLElement[] = []
  private wordY = new Float32Array(0)
  private lineStarts: number[] = [] // word indices that begin a visual line
  private blockFirstWord: number[] = []
  private firstY = 0
  private lastY = 0
  private eyelinePx = 0

  opts: PrompterOptions
  events: PrompterEvents = {}
  playing = false
  /** External multiplier for breath mode (0..1), set every frame by the audio layer. */
  breath = 0
  /** Measured speaking rate for voice mode creep. */
  voiceWpm = 0
  /** Whether the voice gate currently hears speech (for creep). */
  speaking = false

  private y: Damped = { x: 0, v: 0 }
  private vel: Damped = { x: 0, v: 0 }
  private voiceTarget = -1 // word index
  private creep = 0
  private holdUntil = 0
  private cursor = -1
  private lead = -1
  private painted = { cursor: -1, lead: -1 }
  private raf = 0
  private last = 0
  private tickAcc = 0
  private ro: ResizeObserver
  private ended = false

  constructor(viewport: HTMLElement, column: HTMLElement, opts: PrompterOptions) {
    this.viewport = viewport
    this.column = column
    this.opts = opts
    this.ro = new ResizeObserver(() => this.measure())
    this.ro.observe(viewport)
    this.ro.observe(column)
    viewport.addEventListener('wheel', this.onWheel, { passive: false })
    column.addEventListener('click', this.onClick)
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.viewport.removeEventListener('wheel', this.onWheel)
    this.column.removeEventListener('click', this.onClick)
  }

  /* ───────────── content ───────────── */

  setScript(text: string, parsed: ParsedScript) {
    this.parsed = parsed
    const frag = document.createDocumentFragment()
    this.spans = new Array(parsed.wordCount)
    this.blockFirstWord = []
    let headingN = 0
    for (const b of parsed.blocks) {
      const el = document.createElement(b.kind === 'heading' ? 'h2' : 'p')
      el.className = b.kind === 'heading' ? 'pr-head' : 'pr-para'
      if (b.kind === 'heading') {
        const n = document.createElement('span')
        n.className = 'pr-head-n'
        n.textContent = String(++headingN).padStart(2, '0')
        el.append(n)
      }
      let firstWord = -1
      for (let i = 0; i < b.tokens.length; i++) {
        const t = b.tokens[i]!
        if (i > 0) el.append(' ')
        const s = document.createElement('span')
        if (t.kind === 'cue') {
          s.className = 'pr-cue'
          const inner = t.text.slice(1, -1).trim()
          s.textContent = inner
        } else if (t.wi >= 0) {
          s.className = 'w'
          s.dataset.wi = String(t.wi)
          s.textContent = t.text
          this.spans[t.wi] = s
          if (firstWord < 0) firstWord = t.wi
        } else {
          s.textContent = t.text
        }
        el.append(s)
      }
      if (firstWord >= 0) this.blockFirstWord.push(firstWord)
      frag.append(el)
    }
    void text
    this.column.replaceChildren(frag)
    this.painted = { cursor: -1, lead: -1 }
    this.cursor = -1
    this.lead = -1
    this.ended = false
    this.measure()
    this.y.x = this.firstY
    this.y.v = 0
    this.apply()
  }

  measure() {
    const vh = this.viewport.clientHeight
    this.eyelinePx = vh * this.opts.eyeline
    const n = this.spans.length
    this.wordY = new Float32Array(n)
    this.lineStarts = []
    let lastTop = -Infinity
    for (let i = 0; i < n; i++) {
      const s = this.spans[i]
      if (!s) continue
      const top = s.offsetTop
      this.wordY[i] = top + s.offsetHeight * 0.5
      if (top > lastTop + 2) {
        this.lineStarts.push(i)
        lastTop = top
      }
    }
    this.firstY = n ? this.wordY[0]! : 0
    this.lastY = n ? this.wordY[n - 1]! : 0
    this.viewport.style.setProperty('--eyeline', `${this.eyelinePx}px`)
  }

  /* ───────────── state ───────────── */

  setOptions(p: Partial<PrompterOptions>) {
    const eyelineChanged = p.eyeline !== undefined && p.eyeline !== this.opts.eyeline
    this.opts = { ...this.opts, ...p }
    if (eyelineChanged) this.measure()
  }

  play() {
    if (this.ended) this.seekWord(0, true)
    this.playing = true
  }
  pause() {
    this.playing = false
  }
  toggle() {
    this.playing ? this.pause() : this.play()
  }

  get wordCount() {
    return this.parsed.wordCount
  }

  get progress() {
    const span = this.lastY - this.firstY
    return span > 0 ? clamp((this.y.x - this.firstY) / span, 0, 1) : 0
  }

  /** Index of the word nearest the reading line. */
  wordAtLine(y = this.y.x): number {
    const a = this.wordY
    if (!a.length) return -1
    let lo = 0
    let hi = a.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (a[mid]! < y) lo = mid + 1
      else hi = mid
    }
    if (lo > 0 && Math.abs(a[lo - 1]! - y) <= Math.abs(a[lo]! - y)) return lo - 1
    return lo
  }

  /** Voice mode: the aligner says where we are. */
  follow(cursor: number, lead: number) {
    if (lead !== this.lead) this.creep = 0
    this.cursor = cursor
    this.lead = Math.max(cursor, lead)
    this.voiceTarget = this.lead
    this.ended = false
  }

  seekWord(wi: number, instant = false) {
    const i = clamp(wi, 0, Math.max(0, this.wordY.length - 1))
    const y = this.wordY[i] ?? this.firstY
    if (instant) {
      this.y.x = y
      this.y.v = 0
    } else {
      this.holdUntil = performance.now() + 50
      this.manualTarget = y
    }
    this.voiceTarget = i
    this.creep = 0
    this.ended = false
  }
  private manualTarget: number | null = null

  seekProgress(p: number) {
    this.manualTarget = this.firstY + clamp(p, 0, 1) * (this.lastY - this.firstY)
    this.ended = false
  }

  /** Jump by visual lines (negative = back). */
  stepLines(n: number) {
    const w = this.wordAtLine()
    let li = 0
    for (let i = 0; i < this.lineStarts.length; i++) if (this.lineStarts[i]! <= w) li = i
    const target = this.lineStarts[clamp(li + n, 0, this.lineStarts.length - 1)] ?? 0
    this.seekWord(target)
    this.events.manualSeek?.(target)
  }

  /** Jump by paragraphs: what presentation clickers expect. */
  stepBlocks(n: number) {
    const w = this.wordAtLine()
    let bi = 0
    for (let i = 0; i < this.blockFirstWord.length; i++) if (this.blockFirstWord[i]! <= w + 1) bi = i
    const target = this.blockFirstWord[clamp(bi + n, 0, this.blockFirstWord.length - 1)] ?? 0
    this.seekWord(target)
    this.events.manualSeek?.(target)
  }

  nudge(px: number) {
    this.y.x = clamp(this.y.x + px, this.firstY - this.eyelinePx * 0.5, this.lastY)
    this.manualTarget = null
    this.holdUntil = performance.now() + 1200
  }

  /* ───────────── loop ───────────── */

  private frame = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000))
    this.last = now
    this.step(dt, now)
    this.apply()
    this.tickAcc += dt
    if (this.tickAcc > 0.1) {
      this.tickAcc = 0
      this.events.tick?.({ progress: this.progress, y: this.y.x, wordAtLine: this.wordAtLine(), playing: this.playing })
    }
    this.raf = requestAnimationFrame(this.frame)
  }

  private pxPerWord() {
    const n = Math.max(1, this.wordY.length - 1)
    return (this.lastY - this.firstY) / n || 1
  }

  private step(dt: number, now: number) {
    if (this.manualTarget !== null) {
      smoothDamp(this.y, this.manualTarget, 0.28, dt)
      if (Math.abs(this.y.x - this.manualTarget) < 0.5) this.manualTarget = null
      return
    }
    if (now < this.holdUntil) return

    const { mode, speed } = this.opts
    if (mode === 'voice') {
      if (this.voiceTarget < 0 || !this.wordY.length) return
      // Optimistic creep: between recognizer updates, drift ahead at your speaking
      // rate (max ~2 words) so motion never stalls while the engine thinks.
      if (this.speaking && this.voiceWpm > 0 && this.playing) this.creep = Math.min(2.2, this.creep + (this.voiceWpm / 60) * dt)
      const i = Math.min(this.wordY.length - 1, this.voiceTarget)
      const base = this.wordY[i]!
      const next = this.wordY[Math.min(this.wordY.length - 1, i + 1)]!
      const target = base + (next - base) * Math.min(1, this.creep) + this.pxPerWord() * Math.max(0, this.creep - 1)
      smoothDamp(this.y, target, 0.42, dt)
    } else {
      const want = this.playing ? (speedToWpm(speed) / 60) * this.pxPerWord() * (mode === 'breath' ? this.breath : 1) : 0
      smoothDamp(this.vel, want, mode === 'breath' ? 0.18 : 0.4, dt)
      this.y.x += this.vel.x * dt
    }
    if (this.y.x >= this.lastY) {
      this.y.x = this.lastY
      if (this.playing && mode !== 'voice' && !this.ended) {
        this.ended = true
        this.playing = false
        this.events.end?.()
      }
    }
    if (this.y.x < this.firstY - this.eyelinePx * 0.5) this.y.x = this.firstY - this.eyelinePx * 0.5
  }

  private apply() {
    this.column.style.transform = `translate3d(0, ${(this.eyelinePx - this.y.x).toFixed(2)}px, 0)`
    if (this.opts.mode === 'voice') this.paintWords(this.cursor, this.lead)
    else if (this.painted.cursor !== -1 || this.painted.lead !== -1) this.paintWords(-1, -1)
  }

  /** Toggle past/lead classes only on the words whose state changed. */
  private paintWords(cursor: number, lead: number) {
    const p = this.painted
    if (p.cursor === cursor && p.lead === lead) return
    const lo = Math.max(0, Math.min(p.cursor, cursor, p.lead, lead))
    const hi = Math.min(this.spans.length - 1, Math.max(p.cursor, cursor, p.lead, lead))
    for (let i = lo; i <= hi; i++) {
      const s = this.spans[i]
      if (!s) continue
      s.classList.toggle('past', i <= cursor)
      s.classList.toggle('lead', i > cursor && i <= lead)
    }
    this.painted = { cursor, lead }
  }

  /* ───────────── input ───────────── */

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY
    this.nudge(dy * (this.opts.mode === 'voice' ? 1 : 0.8))
    clearTimeout(this.wheelTimer)
    this.wheelTimer = setTimeout(() => this.events.manualSeek?.(this.wordAtLine()), 220)
  }
  private wheelTimer: ReturnType<typeof setTimeout> | undefined

  private onClick = (e: MouseEvent) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.w')
    if (!t?.dataset.wi) return
    const wi = Number(t.dataset.wi)
    this.seekWord(wi)
    this.events.manualSeek?.(wi)
  }
}
