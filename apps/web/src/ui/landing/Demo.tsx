/**
 * "Watch it follow": a scripted, miniature prompter on the landing page. A
 * pretend speaker reads, skips a sentence, and pauses; the highlight and the
 * waveform show what voice-follow does without asking for a microphone.
 */
import { useEffect, useRef, useState } from 'preact/hooks'

const SENTENCES = [
  'Good evening, and thanks for sticking around.',
  'The office is quiet. The coffee went cold.',
  'There is only one thing left on the list tonight.',
  'Say what you came here to say, and mean it.',
]

const WORDS = SENTENCES.map((s) => s.split(' '))
const FLAT = WORDS.flat()
const START = WORDS.map((_, i) => WORDS.slice(0, i).reduce((n, w) => n + w.length, 0))

type Beat = { wi: number; ms: number; note?: string } | { pause: number; note?: string } | { reset: true }

/** Read sentence 1, skip sentence 2, read 3 and 4, pause, start over. */
function timeline(): Beat[] {
  const beats: Beat[] = []
  const read = (s: number, firstNote?: string) =>
    WORDS[s]!.forEach((w, k) => beats.push({ wi: START[s]! + k, ms: 220 + w.length * 34, note: k === 0 ? firstNote : undefined }))
  read(0)
  beats.push({ pause: 500 })
  read(2, 'You skipped a line, and it followed.')
  read(3)
  beats.push({ pause: 2600, note: 'You paused, so it waits.' })
  beats.push({ reset: true })
  return beats
}

const BARS = 28

export function Demo() {
  const root = useRef<HTMLDivElement>(null)
  const [wi, setWi] = useState(-1)
  const [note, setNote] = useState<string | null>(null)
  const [speaking, setSpeaking] = useState(false)
  const bars = useRef<HTMLSpanElement[]>([])

  useEffect(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const beats = timeline()
    let i = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let visible = false
    let raf = 0
    let talking = false

    const step = () => {
      if (!visible) return
      const b = beats[i++ % beats.length]!
      if ('reset' in b) {
        setWi(-1)
        setNote(null)
        timer = setTimeout(step, 900)
        return
      }
      if ('pause' in b) {
        talking = false
        setSpeaking(false)
        if (b.note) setNote(b.note)
        timer = setTimeout(step, b.pause)
        return
      }
      talking = true
      setSpeaking(true)
      setWi(b.wi)
      if (b.note) setNote(b.note)
      else if (b.wi === START[3]) setNote(null)
      timer = setTimeout(step, reduce ? b.ms * 2 : b.ms)
    }

    // Waveform: cheap pseudo-random envelope, only while on screen.
    const seed = Array.from({ length: BARS }, (_, k) => 0.5 + 0.5 * Math.sin(k * 1.7))
    const wave = (t: number) => {
      if (!visible) return
      for (let k = 0; k < BARS; k++) {
        const el = bars.current[k]
        if (!el) continue
        const amp = talking ? 0.25 + 0.75 * Math.abs(Math.sin(t / 140 + k * 0.6) * seed[k]! * Math.sin(t / 410 + k)) : 0.06
        el.style.transform = `scaleY(${amp.toFixed(3)})`
      }
      raf = requestAnimationFrame(wave)
    }

    const io = new IntersectionObserver(([e]) => {
      const was = visible
      visible = !!e?.isIntersecting
      if (visible && !was) {
        timer = setTimeout(step, 400)
        if (!reduce) raf = requestAnimationFrame(wave)
      } else if (!visible) {
        clearTimeout(timer)
        cancelAnimationFrame(raf)
      }
    })
    io.observe(root.current!)
    return () => {
      io.disconnect()
      clearTimeout(timer)
      cancelAnimationFrame(raf)
    }
  }, [])

  // Keep the active sentence on the reading line.
  const sentence = wi < 0 ? 0 : START.findLastIndex((s) => s <= wi)

  return (
    <div class="demo" ref={root}>
      <div class="demo-screen night" aria-hidden="true">
        <div class="demo-view">
        <div class="demo-line" />
        <div class="demo-text" style={{ transform: `translateY(calc(${-sentence} * var(--demo-row)))` }}>
          {WORDS.map((ws, s) => (
            <p class="demo-sentence" key={s}>
              {ws.map((w, k) => {
                const idx = START[s]! + k
                const cls = idx === wi ? 'now' : idx < wi && s !== 1 ? 'past' : idx < wi ? 'skipped' : ''
                return (
                  <span class={`demo-w ${cls}`} key={k}>
                    {w}{' '}
                  </span>
                )
              })}
            </p>
          ))}
        </div>
        </div>
        <div class={`demo-wave ${speaking ? 'on' : ''}`}>
          {Array.from({ length: BARS }, (_, k) => (
            <span ref={(el) => { if (el) bars.current[k] = el }} />
          ))}
        </div>
        <div class="demo-status">
          <span class={`demo-dot ${speaking ? 'on' : ''}`} />
          <span class="demo-status-text">{speaking ? 'Listening on this device' : wi < 0 ? 'Ready' : 'Waiting for you'}</span>
        </div>
      </div>
      <p class={`demo-note ${note ? 'show' : ''}`} aria-live="polite">
        {note ?? 'A short demo: the highlight follows a pretend speaker.'}
      </p>
      <span class="sr-only">A demo: words light up as a speaker reads, skip a sentence, and pause.</span>
    </div>
  )
}

export const DEMO_WORDS = FLAT.length
