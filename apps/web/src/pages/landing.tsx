import { render } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import '../styles/base.css'
import '../pwa'
import './landing.css'
import { createLampHandle, Lamp } from '../ui/lamp/Lamp'
import { Mark } from '../ui/Mark'

const FEATURES = [
  {
    title: 'It listens, and keeps it to itself.',
    body: 'Voice-follow matches what you say against your script, word by word. Skip a line, stumble, ad-lib, go back — it finds you again. Recognition runs on your device.',
    tag: 'Rust → WebAssembly',
  },
  {
    title: 'It breathes with you.',
    body: 'Breath mode needs no speech recognition at all. A tiny voice detector scrolls while you talk and glides to a stop when you pause.',
    tag: 'Zig → WebAssembly',
  },
  {
    title: 'Your phone is the clicker.',
    body: 'Scan a code and your phone becomes the remote. Commands travel peer to peer; your script stays on the laptop.',
    tag: 'WebRTC',
  },
  {
    title: 'Ready for the glass.',
    body: 'Mirror for beam-splitter rigs, park the reading line right under the lens, and open a second window for the talent screen.',
    tag: 'Mirror · eyeline · second screen',
  },
  {
    title: 'Captions on the way out.',
    body: 'Every word you read gets a timestamp. Export SRT or VTT and drop it straight onto your edit timeline.',
    tag: 'SRT · VTT',
  },
]

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
        ? { x: r.width * 0.2, y: r.height * 0.96, scale: 0.78 }
        : { x: Math.max(110, r.width * 0.085), y: r.height * 0.93, scale: Math.min(1.22, r.height / 640) }
    }
    layout()
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
    <section class="hero" ref={stage}>
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
          DeskPrompter scrolls when you speak and waits when you pause. It runs in your browser, works offline, and never
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

function Landing() {
  return (
    <div class="landing grain">
      <header class="nav">
        <a class="brand" href="/">
          <Mark />
          <span>DeskPrompter</span>
        </a>
        <nav>
          <a href="#how">
            How it works
          </a>
          <a href="/studio">
            Studio
          </a>
          <a href="https://github.com/KarthikSubramanian07/DeskPrompter">
            GitHub
          </a>
        </nav>
      </header>
      <main>
        <Hero />
        <section class="features" id="how">
          <header class="features-head">
            <h2>
              A good prompter should feel like it&rsquo;s <em>reading along</em> with you.
            </h2>
          </header>
          <ol class="features-list">
            {FEATURES.map((f, i) => (
              <li class="feature" key={f.title}>
                <span class="feature-n">{i + 1}</span>
                <div>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
                <span class="feature-tag">{f.tag}</span>
              </li>
            ))}
          </ol>
        </section>
        <section class="fine">
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
                <dd>None — scripts live in your browser</dd>
              </div>
              <div>
                <dt>Works offline</dt>
                <dd>Yes, install it like an app</dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>MIT</dd>
              </div>
            </dl>
          </div>
        </section>
      </main>
      <footer class="foot">
        <span class="foot-brand">
          <Mark size={18} /> DeskPrompter
        </span>
        <span>Made late at night. Open source under MIT.</span>
      </footer>
    </div>
  )
}

render(<Landing />, document.getElementById('app')!)
