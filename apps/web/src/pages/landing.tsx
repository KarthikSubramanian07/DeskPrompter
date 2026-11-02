import { render } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import '../styles/base.css'
import './landing.css'
import { createLampHandle, Lamp } from '../ui/lamp/Lamp'
import { Mark } from '../ui/Mark'

const FEATURES = [
  {
    n: '一',
    title: 'It listens, and it keeps a secret.',
    body: 'Voice-follow scrolling matches what you say against your script, word by word. Skip a line, ad-lib, stumble — it finds you again. Recognition runs on your device.',
    tag: 'rust → wasm · on-device speech',
  },
  {
    n: '二',
    title: 'It breathes with you.',
    body: 'Breath mode needs no speech recognition at all. A tiny voice detector scrolls while you talk and glides to a stop when you pause.',
    tag: 'zig → wasm · audio worklet',
  },
  {
    n: '三',
    title: 'Your phone is the clicker.',
    body: 'Scan a code and your phone becomes a remote. Commands travel peer to peer; your script never leaves the laptop.',
    tag: 'webrtc · rust relay on the edge',
  },
  {
    n: '四',
    title: 'Glass-ready.',
    body: 'Mirror for beam-splitter rigs, pin the reading line under the lens, open a talent window on a second screen.',
    tag: 'mirror · eyeline · second screen',
  },
  {
    n: '五',
    title: 'Captions on the way out.',
    body: 'Every word you read is timed. Export SRT or VTT and drop it straight onto your edit timeline.',
    tag: 'srt · vtt',
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
        <p class="label hero-eyebrow">
          <span class="dot" /> a teleprompter that listens · <span class="kanji">行灯</span>
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
          <a class="btn btn-shu" href="/studio">
            <span class="kanji">開演</span> Open the studio
          </a>
          <a class="btn btn-ghost" href="https://github.com/KarthikSubramanian07/DeskPrompter">
            Read the source
          </a>
        </div>
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
          <a href="#how" class="label">
            How it works
          </a>
          <a href="/studio" class="label">
            Studio
          </a>
          <a href="https://github.com/KarthikSubramanian07/DeskPrompter" class="label">
            GitHub
          </a>
        </nav>
      </header>
      <main>
        <Hero />
        <section class="menu" id="how">
          <header class="menu-head">
            <p class="label">The menu</p>
            <h2>
              Five things on the house<span class="shu">.</span>
            </h2>
          </header>
          <ol class="menu-list">
            {FEATURES.map((f) => (
              <li class="menu-item" key={f.n}>
                <span class="menu-n kanji">{f.n}</span>
                <div>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
                <span class="label menu-tag">{f.tag}</span>
              </li>
            ))}
          </ol>
        </section>
        <section class="tab">
          <div class="tab-card">
            <p class="label">Your tab</p>
            <div class="tab-row">
              <span>Voice-follow, mirroring, phone remote, captions</span>
              <span class="leader" />
              <span class="mono">¥0</span>
            </div>
            <div class="tab-row">
              <span>Accounts, uploads, tracking</span>
              <span class="leader" />
              <span class="mono">none</span>
            </div>
            <div class="tab-row total">
              <span>Total</span>
              <span class="leader" />
              <span class="mono">¥0</span>
            </div>
            <p class="tab-note">Tip the bartender with a star on GitHub. MIT licensed.</p>
          </div>
        </section>
      </main>
      <footer class="foot">
        <span class="label">Made late at night · MIT</span>
        <span class="kanji foot-kanpai">乾杯</span>
      </footer>
    </div>
  )
}

render(<Landing />, document.getElementById('app')!)
