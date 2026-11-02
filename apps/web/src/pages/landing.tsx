import { render } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import '../styles/base.css'
import '../pwa'
import './landing.css'
import { createLampHandle, Lamp } from '../ui/lamp/Lamp'
import { Mark } from '../ui/Mark'
import { mountPoint } from '../mount'
import { ModeIcon } from '../ui/icons'
import { Demo } from '../ui/landing/Demo'

function Hero() {
  const stage = useRef<HTMLDivElement>(null)
  const handle = useRef(createLampHandle()).current

  useEffect(() => {
    const el = stage.current!
    let pointer: { x: number; y: number } | null = null
    let idleT = 0
    const layout = () => {
      const r = el.getBoundingClientRect()
      const small = r.width < 760
      handle.anchor = small
        ? { x: r.width * 0.16, y: r.height * 0.985, scale: 0.56 }
        : { x: Math.max(110, r.width * 0.085), y: r.height * 0.93, scale: Math.min(1.22, r.height / 640) }
    }
    layout()
    // On phones the cone crosses the body copy, so keep it soft.
    handle.beamStrength = el.getBoundingClientRect().width < 760 ? 0.5 : 1
    handle.rig.powerOn()
    handle.rig.setMood('idle')
    const ro = new ResizeObserver(layout)
    ro.observe(el)

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top }
      idleT = 0
      handle.rig.setMood('watching')
    }
    const onDown = () => {
      handle.rig.nod(1.4)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerdown', onDown)

    let raf = 0
    let last = performance.now()
    const pool = { x: 0, y: 0 }
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      idleT += dt
      const r = el.getBoundingClientRect()
      const head = el.querySelector('.hero-title') as HTMLElement
      const hr = head.getBoundingClientRect()
      // Without a pointer, the light drifts slowly across the headline, like someone reading it.
      const auto = {
        x: hr.left - r.left + Math.min(hr.width, 640) * (0.5 + 0.38 * Math.sin(now / 2600)),
        y: hr.top - r.top + hr.height * (0.5 + 0.28 * Math.sin(now / 1700)),
      }
      if (idleT > 4) {
        pointer = null
        handle.rig.setMood('idle')
      }
      const want = pointer ?? auto
      const k = 1 - Math.exp(-dt * (pointer ? 9 : 2.5))
      pool.x += (want.x - pool.x) * k
      pool.y += (want.y - pool.y) * k
      const w = Math.max(260, r.width * 0.3)
      handle.pool = { x: pool.x, y: pool.y, w, h: w * 0.34 }
      el.style.setProperty('--px', `${pool.x}px`)
      el.style.setProperty('--py', `${pool.y}px`)
      el.style.setProperty('--pr', `${w * 0.55}px`)
      el.style.setProperty('--ox', `${hr.left - r.left}px`)
      el.style.setProperty('--oy', `${hr.top - r.top}px`)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerdown', onDown)
    }
  }, [])

  return (
    <section class="hero night" ref={stage}>
      <div class="hero-grid" aria-hidden="true" />
      <div class="hero-copy">
        <p class="hero-note hand" aria-hidden="true">
          go on, read it out loud
          <svg viewBox="0 0 120 70" width="96" height="56" class="hero-arrow">
            <path d="M6 8 C 30 4, 62 10, 78 30 S 92 58, 104 62" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            <path d="M92 60 L105 63 L99 51" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </p>
        <h1 class="hero-title">
          <span class="dim" aria-hidden="true">
            Say it like
            <br />
            you mean it.
          </span>
          <span class="lit">
            Say it like
            <br />
            you mean it.
          </span>
        </h1>
        <p class="hero-sub">
          DeskPrompter is a free teleprompter that scrolls when you speak and waits when you pause. It runs in your browser, works offline, and never
          sends your words anywhere.
        </p>
        <div class="hero-cta">
          <a class="btn btn-clay" href="/studio">
            Open the studio
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </a>
          <a class="btn btn-ghost" href="https://github.com/KarthikSubramanian07/DeskPrompter">
            Read the source
          </a>
        </div>
        <p class="hero-fine">Free. Works offline. Nothing you say leaves your device.</p>
      </div>
      <Lamp handle={handle} />
    </section>
  )
}

const MODES = [
  {
    mode: 'voice' as const,
    title: 'Voice',
    body: 'Follows your words. Skip a line, ad-lib, go back for another take: it finds your place again. Recognition runs on your device.',
  },
  {
    mode: 'breath' as const,
    title: 'Breath',
    body: 'No transcription at all. A tiny voice detector scrolls while you talk and glides to a stop when you pause.',
  },
  {
    mode: 'manual' as const,
    title: 'Steady',
    body: 'The classic glide, set in words per minute. Changes ease in, never jump. Space to pause, arrows to adjust.',
  },
]

const EXTRAS = [
  { title: 'Your phone is the clicker', body: 'Scan a code and your phone becomes the remote, with the current line and time left. It talks to your laptop directly.' },
  { title: 'Ready for the glass', body: 'Mirror for beam-splitter rigs, put the reading line right under the lens, and send a talent window to a second screen.' },
  { title: 'Captions on the way out', body: 'Every word you read in voice mode is timed. Download SRT or VTT and drop it on your edit timeline.' },
  { title: 'Works offline', body: 'Install it like an app. Scripts live in your browser, and nothing is uploaded, ever.' },
]

const PIPE = [
  { k: 'Microphone', v: 'stays in the tab' },
  { k: 'Voice gate', v: 'Zig → wasm · 3 KB' },
  { k: 'Speech engine', v: 'on-device' },
  { k: 'Aligner', v: 'Rust → wasm · 113 KB' },
  { k: 'Stage', v: 'springs at 60 fps' },
]

function Landing() {
  const hero = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const nav = document.querySelector('.nav') as HTMLElement
    const io = new IntersectionObserver(([e]) => nav.classList.toggle('on-day', !e?.isIntersecting), { rootMargin: '-64px 0px 0px 0px' })
    io.observe(hero.current!.querySelector('.hero')!)
    return () => io.disconnect()
  }, [])

  return (
    <div class="landing">
      <header class="nav">
        <a class="brand" href="/">
          <Mark />
          <span>DeskPrompter</span>
        </a>
        <nav>
          <a href="#follow">How it works</a>
          <a href="https://github.com/KarthikSubramanian07/DeskPrompter">GitHub</a>
          <a class="nav-cta" href="/studio">
            Open the studio
          </a>
        </nav>
      </header>
      <main>
        <div ref={hero}>
          <Hero />
        </div>
        <div class="day">
          <section class="sec follow" id="follow">
            <div class="sec-head">
              <p class="eyebrow">Watch it follow</p>
              <h2>
                It reads <em>along</em> with you.
              </h2>
              <p class="sec-sub">
                The words you&rsquo;ve said fall back, the next ones step forward, and the lamp keeps the line you&rsquo;re on in the light. Skip a sentence and it skips with you. Stop talking and it waits.
              </p>
            </div>
            <Demo />
          </section>

          <section class="sec modes">
            <div class="sec-head">
              <p class="eyebrow">Three ways to scroll</p>
              <h2>Pick how it keeps time.</h2>
            </div>
            <div class="mode-grid">
              {MODES.map((m) => (
                <article class={`mode-card mode-${m.mode}`} key={m.mode}>
                  <span class="mode-icon">
                    <ModeIcon mode={m.mode} size={22} />
                  </span>
                  <h3>{m.title}</h3>
                  <p>{m.body}</p>
                </article>
              ))}
            </div>
          </section>

          <section class="sec extras">
            <div class="extra-grid">
              {EXTRAS.map((x) => (
                <div class="extra" key={x.title}>
                  <h3>{x.title}</h3>
                  <p>{x.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section class="sec under">
            <div class="sec-head">
              <p class="eyebrow">Under the desk</p>
              <h2>Built to be fast, small, and private.</h2>
              <p class="sec-sub">
                Your voice goes through a pipeline that runs entirely in the tab. The heavy parts are compiled to WebAssembly: Rust for the matching, Zig for the audio thread.
              </p>
            </div>
            <ol class="pipe">
              {PIPE.map((p, i) => (
                <li key={p.k}>
                  <span class="pipe-k">{p.k}</span>
                  <span class="pipe-v">{p.v}</span>
                  {i < PIPE.length - 1 && <span class="pipe-arrow" aria-hidden="true" />}
                </li>
              ))}
            </ol>
            <p class="pipe-note hand">nothing on this line touches a server</p>
          </section>

          <section class="sec fine">
            <div class="fine-card">
              <p class="hand fine-title">the fine print</p>
              <dl>
                <div>
                  <dt>Price</dt>
                  <dd>Free, forever</dd>
                </div>
                <div>
                  <dt>Accounts</dt>
                  <dd>None</dd>
                </div>
                <div>
                  <dt>Uploads</dt>
                  <dd>None. Scripts live in your browser</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    <a href="https://github.com/KarthikSubramanian07/DeskPrompter">Open, MIT</a>
                  </dd>
                </div>
              </dl>
            </div>
            <div class="fine-cta">
              <h2>Ready when you are.</h2>
              <a class="btn btn-clay" href="/studio">
                Open the studio
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </a>
            </div>
          </section>

          <footer class="foot">
            <span class="foot-brand">
              <Mark size={18} /> DeskPrompter
            </span>
            <nav class="foot-links" aria-label="More">
              <a href="/about">About</a>
              <a href="/contact">Contact</a>
              <a href="/privacy">Privacy</a>
              <a href="/llms.txt">llms.txt</a>
            </nav>
            <span class="foot-note">Made late at night. Open source under MIT.</span>
          </footer>
        </div>
      </main>
    </div>
  )
}

render(<Landing />, mountPoint())
