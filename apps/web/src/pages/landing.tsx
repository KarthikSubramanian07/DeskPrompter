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
          DeskPrompter is a free teleprompter for your browser. It follows your voice as you read, so your eyes stay on the camera instead of the
          keyboard.
        </p>
        <div class="hero-cta">
          <a class="btn btn-clay" href="/studio">
            Open the teleprompter
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </a>
          <a class="btn btn-ghost" href="#how">
            See how it works
          </a>
        </div>
        <p class="hero-fine">Free. No sign-up. Your script stays on your device.</p>
      </div>
      <Lamp handle={handle} />
    </section>
  )
}

const STEPS = [
  { title: 'Add your script', body: 'Type it, paste it, or drop in a text file. Your scripts are saved in this browser.' },
  { title: 'Choose how it scrolls', body: 'Let it follow your voice, move only while you talk, or scroll at a steady speed.' },
  { title: 'Press Start and read', body: 'Look at the camera and talk normally. If you skip or repeat a line, it keeps up.' },
]

const MODES = [
  {
    mode: 'voice' as const,
    title: 'Follows your voice',
    body: 'It listens as you read and keeps your current line in view. Skip ahead or go back and it finds your place.',
  },
  {
    mode: 'breath' as const,
    title: 'Moves while you talk',
    body: 'Scrolls when you speak and stops when you pause. It does not need to understand your words, so it works in any language.',
  },
  {
    mode: 'manual' as const,
    title: 'Steady speed',
    body: 'Classic auto-scroll at a speed you choose. Speed it up or slow it down any time.',
  },
]

const EXTRAS = [
  { title: 'Use your phone as a remote', body: 'Scan a code and control the teleprompter from your phone.' },
  { title: 'Works with teleprompter glass', body: 'Flip the text for a mirror rig, or send it to a second screen.' },
  { title: 'Captions from your read', body: 'After reading in voice mode, download subtitles for your video editor.' },
  { title: 'Phones, tablets, offline', body: 'Use it on any device. Install it like an app and it works without internet.' },
]

const FAQ = [
  { q: 'Is it really free?', a: 'Yes. There is no paid plan, no trial and no ads. The code is open source.' },
  { q: 'Do I need an account?', a: 'No. Open the teleprompter and start. Your scripts are saved in your browser.' },
  { q: 'Is my script or my voice uploaded?', a: 'No. Your script stays in your browser and your voice is processed on your device. The privacy page lists every connection the app makes.' },
  {
    q: 'Which browsers work?',
    a: 'Chrome, Edge, Safari and Firefox, on computers, phones and tablets. Voice follow works best in Chrome. The first time you use it elsewhere, it downloads a speech model of about 50 MB.',
  },
  { q: 'Can I use it with a real teleprompter rig?', a: 'Yes. Turn on Flip text in the settings for beam-splitter glass, or open a second screen for the person reading.' },
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
          <a href="#how">How it works</a>
          <a href="#faq">FAQ</a>
          <a class="nav-cta" href="/studio">
            Open the teleprompter
          </a>
        </nav>
      </header>
      <main>
        <div ref={hero}>
          <Hero />
        </div>
        <div class="day">
          <section class="sec how" id="how">
            <div class="sec-head">
              <h2>How it works</h2>
            </div>
            <ol class="steps">
              {STEPS.map((st, i) => (
                <li class="step" key={st.title}>
                  <span class="step-n">{i + 1}</span>
                  <h3>{st.title}</h3>
                  <p>{st.body}</p>
                </li>
              ))}
            </ol>
            <Demo />
          </section>

          <section class="sec modes">
            <div class="sec-head">
              <h2>Three ways to scroll</h2>
              <p class="sec-sub">You can switch any time, even in the middle of reading.</p>
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
            <div class="sec-head">
              <h2>Also included</h2>
            </div>
            <div class="extra-grid">
              {EXTRAS.map((x) => (
                <div class="extra" key={x.title}>
                  <h3>{x.title}</h3>
                  <p>{x.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section class="sec faq" id="faq">
            <div class="sec-head">
              <h2>Questions</h2>
            </div>
            <div class="faq-list">
              {FAQ.map((f) => (
                <details class="faq-item" key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </section>

          <section class="sec end">
            <h2>Ready to read?</h2>
            <p class="sec-sub">It takes a few seconds to start. No sign-up.</p>
            <a class="btn btn-clay" href="/studio">
              Open the teleprompter
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </a>
          </section>

          <footer class="foot">
            <span class="foot-brand">
              <Mark size={18} /> DeskPrompter
            </span>
            <nav class="foot-links" aria-label="More">
              <a href="/about">About</a>
              <a href="/contact">Contact</a>
              <a href="/privacy">Privacy</a>
              <a href="https://github.com/KarthikSubramanian07/DeskPrompter">Source code</a>
            </nav>
            <span class="foot-note">Free and open source.</span>
          </footer>
        </div>
      </main>
    </div>
  )
}

render(<Landing />, mountPoint())
