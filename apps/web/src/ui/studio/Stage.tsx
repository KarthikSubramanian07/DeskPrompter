/**
 * The stage: full-bleed prompter. Text glides under a reading line, the lamp hangs
 * from the top edge and lights it, and the HUD stays out of the way.
 */
import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import type { ParsedScript, PrompterMode, RemoteCommand } from '../../core/contracts'
import type { HostBridge } from '../../core/bridge'
import { Prompter, speedToWpm } from '../../core/prompter'
import { patchSettings, settings, type Script } from '../../core/store'
import { buildCues, estimateRemainingMs, formatClock, toSrt, toVtt } from '../../core/timing'
import { Listener } from '../../core/listen'
import { spokenWords } from '../../core/script'
import { createLampHandle, Lamp } from '../lamp/Lamp'
import { CameraCheck } from './CameraCheck'
import { Kbd } from './controls'
import { ModeIcon } from '../icons'

export interface StageApi {
  prompter: Prompter
}

export interface StageProps {
  script: Script
  parsed: ParsedScript
  onExit: () => void
  /** Called once the prompter exists, so listening layers can attach. */
  onReady?: (api: StageApi) => void
  /** Live audio level 0..1 and speaking flag, for the HUD meter and the lamp. */
  level?: { value: number; speaking: boolean }
  status?: string
  /** Display-only window: no HUD, no countdown. */
  display?: boolean
  /** Host bridge for phones and talent windows. */
  bridge?: HostBridge
  /** Override mirroring (talent display windows choose their own). */
  mirror?: { x: boolean; y: boolean }
}

const KEYS: [string, string][] = [
  ['space', 'Play or pause'],
  ['↑ ↓', 'Faster or slower (lines in voice mode)'],
  ['← →', 'Back or forward a line'],
  ['PgUp PgDn', 'Back or forward a paragraph'],
  ['Home', 'Back to the top'],
  ['1 2 3', 'Steady, voice or breath'],
  ['m', 'Mirror for glass'],
  ['f', 'Fullscreen'],
  ['+ −', 'Bigger or smaller type'],
  ['esc', 'Back to the desk'],
]

const MODES: { value: PrompterMode; label: string }[] = [
  { value: 'manual', label: 'Steady' },
  { value: 'voice', label: 'Voice' },
  { value: 'breath', label: 'Breath' },
]

export function Stage({ script, parsed, onExit, onReady, level, status, display, bridge, mirror }: StageProps) {
  const viewport = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const prompterRef = useRef<Prompter | null>(null)
  const handle = useRef(createLampHandle({ hang: true, beamStrength: 0.9 })).current
  const hudVisible = useSignal(true)
  const playing = useSignal(false)
  const progress = useSignal(0)
  const elapsed = useSignal(0)
  const countdown = useSignal<number | null>(null)
  const help = useSignal(false)
  const wordAt = useSignal(0)
  const s = settings.value
  const listener = useRef<Listener | null>(null)
  const parsedRef = useRef(parsed)
  parsedRef.current = parsed
  const live = listener.current
  if (!level && live && live.state.value !== 'off') {
    const v = live.level.value
    level = { value: v.level, speaking: v.speaking }
  }
  status = status ?? (live?.status.value || undefined)
  const levelRef = useRef(level)
  levelRef.current = level

  // Create the engine once.
  useEffect(() => {
    const p = new Prompter(viewport.current!, column.current!, {
      mode: settings.value.mode,
      speed: settings.value.speed,
      eyeline: settings.value.eyeline,
      dimPast: settings.value.dimPast,
    })
    prompterRef.current = p
    let lastBlockWord = -1
    p.events.tick = (t) => {
      if (bridge) {
        const st = settings.value
        const words = p.wordCount
        const wpmNow = st.mode === 'voice' && p.voiceWpm ? p.voiceWpm : speedToWpm(st.speed)
        bridge.publish({
          playing: t.playing,
          speed: st.speed,
          progress: t.progress,
          elapsedMs: elapsed.value,
          remainingMs: estimateRemainingMs(Math.max(0, words - t.wordAtLine), wpmNow),
          wpm: Math.round(wpmNow),
          mode: st.mode,
          mirrorX: st.mirrorX,
          mirrorY: st.mirrorY,
          title: script.title,
          currentLine: p.lineText(t.wordAtLine),
        })
      }
      progress.value = t.progress
      playing.value = t.playing
      wordAt.value = t.wordAtLine
      // The lamp nods when you reach a new paragraph.
      const para = column.current?.querySelector(`.w[data-wi="${t.wordAtLine}"]`)?.closest('.pr-para')
      const first = para?.querySelector<HTMLElement>('.w')?.dataset.wi
      if (first !== undefined && Number(first) !== lastBlockWord) {
        if (lastBlockWord >= 0 && t.playing) handle.rig.nod(0.8)
        lastBlockWord = Number(first)
      }
    }
    p.events.end = () => {
      playing.value = false
      handle.rig.hop(0.6)
    }
    onReady?.({ prompter: p })
    if (!display) listener.current = new Listener(p, script.text, () => spokenWords(parsedRef.current))
    return () => {
      void listener.current?.stop()
      p.destroy()
    }
  }, [])

  // Listening follows the mode: breath needs the voice gate, voice needs the full chain.
  useEffect(() => {
    void listener.current?.start(s.mode, { engine: s.engine, allowCloud: s.allowCloud, sensitivity: s.sensitivity })
  }, [s.mode, s.engine, s.allowCloud, s.sensitivity])

  // Script content.
  useEffect(() => {
    prompterRef.current?.setScript(script.text, parsed)
  }, [parsed])

  // Settings → engine + CSS.
  useEffect(() => {
    const p = prompterRef.current
    if (!p) return
    p.setOptions({ mode: s.mode, speed: s.speed, eyeline: s.eyeline, dimPast: s.dimPast })
    requestAnimationFrame(() => p.measure())
  }, [s.mode, s.speed, s.eyeline, s.fontSize, s.measure, s.lineHeight, s.dimPast])

  // Elapsed clock.
  useEffect(() => {
    let last = performance.now()
    const id = setInterval(() => {
      const now = performance.now()
      if (prompterRef.current?.playing) elapsed.value += now - last
      last = now
    }, 250)
    return () => clearInterval(id)
  }, [])

  // Lamp placement and mood.
  useEffect(() => {
    let raf = 0
    let pausedFor = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const vp = viewport.current
      const col = column.current
      if (vp && col) {
        const w = vp.clientWidth
        const h = vp.clientHeight
        const colW = col.clientWidth
        const left = (w - colW) / 2
        const eyeY = h * settings.value.eyeline
        handle.anchor = { x: Math.max(70, left * 0.42), y: 14, scale: Math.min(0.95, Math.max(0.55, h / 980)) }
        handle.pool = { x: w / 2, y: eyeY, w: colW * 1.15, h: settings.value.fontSize * settings.value.lineHeight * 1.9 }
        handle.look = null
        const p = prompterRef.current
        const isPlaying = !!p?.playing
        pausedFor = isPlaying ? 0 : pausedFor + dt
        handle.rig.energy = levelRef.current?.value ?? 0
        handle.rig.setMood(isPlaying ? 'live' : pausedFor > 40 ? 'asleep' : 'paused')
      }
      raf = requestAnimationFrame(tick)
    }
    handle.rig.powerOn()
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // HUD autohide.
  useEffect(() => {
    if (display) return
    let t: ReturnType<typeof setTimeout>
    const show = () => {
      hudVisible.value = true
      clearTimeout(t)
      t = setTimeout(() => {
        if (prompterRef.current?.playing) hudVisible.value = false
      }, 2600)
    }
    window.addEventListener('pointermove', show)
    show()
    return () => {
      window.removeEventListener('pointermove', show)
      clearTimeout(t)
    }
  }, [])

  const start = () => {
    const p = prompterRef.current
    if (!p) return
    if (p.playing) {
      p.pause()
      playing.value = false
      hudVisible.value = true
      return
    }
    if (settings.value.countdown && !display && countdown.value === null) {
      countdown.value = 3
      const step = () => {
        if (countdown.value === null) return
        if (countdown.value <= 1) {
          countdown.value = null
          handle.rig.hop(1)
          p.play()
          playing.value = true
          return
        }
        countdown.value -= 1
        setTimeout(step, 800)
      }
      setTimeout(step, 800)
      return
    }
    handle.rig.hop(0.8)
    p.play()
    playing.value = true
  }

  // Commands from a paired phone or another window.
  useEffect(() => {
    if (!bridge) return
    return bridge.onCommand((c: RemoteCommand) => {
      const p = prompterRef.current
      if (!p) return
      const st = settings.value
      hudVisible.value = true
      switch (c.c) {
        case 'toggle':
          startRef.current()
          break
        case 'play':
          if (!p.playing) startRef.current()
          break
        case 'pause':
          if (p.playing) startRef.current()
          break
        case 'faster':
          patchSettings({ speed: Math.min(10, st.speed + 0.5) })
          break
        case 'slower':
          patchSettings({ speed: Math.max(1, st.speed - 0.5) })
          break
        case 'back':
          p.stepLines(-1)
          break
        case 'forward':
          p.stepLines(1)
          break
        case 'top':
          p.seekWord(0)
          elapsed.value = 0
          break
        case 'mirror':
          patchSettings({ mirrorX: !st.mirrorX })
          break
        case 'speed':
          patchSettings({ speed: Math.min(10, Math.max(1, c.v)) })
          break
        case 'seek':
          p.seekProgress(c.v)
          break
        case 'nudge':
          p.nudge(c.v * p.lineHeightPx)
          break
      }
    })
  }, [bridge])

  // Keyboard: the operator's whole vocabulary.
  useEffect(() => {
    if (display) return
    const onKey = (e: KeyboardEvent) => {
      const p = prompterRef.current
      if (!p) return
      if ((e.target as Partial<HTMLElement>)?.closest?.('input, textarea, select')) return
      const st = settings.value
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          start()
          break
        case 'Escape':
          if (help.value) help.value = false
          else if (countdown.value !== null) countdown.value = null
          else onExit()
          break
        case '?':
        case '/':
          help.value = !help.value
          break
        case 'ArrowUp':
          e.preventDefault()
          if (st.mode === 'voice') p.stepLines(-1)
          else patchSettings({ speed: Math.min(10, st.speed + 0.5) })
          break
        case 'ArrowDown':
          e.preventDefault()
          if (st.mode === 'voice') p.stepLines(1)
          else patchSettings({ speed: Math.max(1, st.speed - 0.5) })
          break
        case 'ArrowLeft':
          e.preventDefault()
          p.stepLines(-1)
          break
        case 'ArrowRight':
          e.preventDefault()
          p.stepLines(1)
          break
        case 'PageUp':
          e.preventDefault()
          p.stepBlocks(-1)
          break
        case 'PageDown':
          e.preventDefault()
          p.stepBlocks(1)
          break
        case 'Home':
          p.seekWord(0)
          elapsed.value = 0
          break
        case 'End':
          p.seekProgress(1)
          break
        case 'm':
          patchSettings({ mirrorX: !st.mirrorX })
          break
        case 'f':
          if (document.fullscreenElement) void document.exitFullscreen()
          else void document.documentElement.requestFullscreen?.()
          break
        case '=':
        case '+':
          patchSettings({ fontSize: Math.min(120, st.fontSize + 4) })
          break
        case '-':
          patchSettings({ fontSize: Math.max(28, st.fontSize - 4) })
          break
        case '1':
        case '2':
        case '3':
          patchSettings({ mode: MODES[Number(e.key) - 1]!.value })
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const exportCaptions = (kind: 'srt' | 'vtt') => {
    const l = listener.current
    if (!l) return
    const cues = buildCues(spokenWords(parsed), l.stamps)
    const body = kind === 'srt' ? toSrt(cues) : toVtt(cues)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([body], { type: kind === 'srt' ? 'application/x-subrip' : 'text/vtt' }))
    a.download = `${(script.title || 'script').replace(/[^\w\- ]+/g, '').trim() || 'script'}.${kind}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const startRef = useRef(start)
  startRef.current = start
  const p = prompterRef.current
  const total = parsed.wordCount
  const wordsLeft = Math.max(0, total - wordAt.value)
  const wpm = s.mode === 'voice' && p?.voiceWpm ? Math.round(p.voiceWpm) : speedToWpm(s.speed)
  const remaining = estimateRemainingMs(wordsLeft, wpm)

  return (
    <div
      class={`stage night ${display ? 'is-display' : ''} ${hudVisible.value ? '' : 'hud-hidden'}`}
      style={{
        '--fs': `${s.fontSize}px`,
        '--lh': s.lineHeight,
        '--measure': `${s.measure}ch`,
      }}
    >
      <div class="stage-progress" style={{ transform: `scaleX(${progress.value})` }} />
      <div class="stage-mirror" style={{ transform: `scale(${(mirror?.x ?? s.mirrorX) ? -1 : 1}, ${(mirror?.y ?? s.mirrorY) ? -1 : 1})` }}>
        <div class="stage-viewport" ref={viewport}>
          <div class={`stage-column ${s.mode === 'voice' ? 'is-voice' : ''}`} ref={column} />
          <div class="stage-line" aria-hidden="true">
            <span class="stage-tick l" />
            <span class="stage-tick r" />
          </div>
        </div>
        {s.lamp && <Lamp handle={handle} class="stage-lamp" />}
      </div>

      {s.camera && !display && <CameraCheck />}

      {countdown.value !== null && (
        <div class="countdown" role="status" aria-live="assertive">
          <span class="countdown-n" key={countdown.value}>
            {countdown.value}
          </span>
          <span class="countdown-hint">Esc to cancel</span>
        </div>
      )}

      {!display && (
        <div class="hud" role="toolbar" aria-label="Prompter controls">
          <button class={`hud-play ${playing.value ? 'on' : ''}`} onClick={start} aria-label={playing.value ? 'Pause' : 'Play'} title="Space">
            {playing.value ? (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor" />
                <rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M4 2.5v11a.6.6 0 0 0 .9.5l9-5.5a.6.6 0 0 0 0-1l-9-5.5a.6.6 0 0 0-.9.5Z" fill="currentColor" />
              </svg>
            )}
          </button>
          <div class="hud-modes">
            {MODES.map((m, i) => (
              <button class={`hud-mode ${s.mode === m.value ? 'on' : ''}`} title={`${m.label} (${i + 1})`} onClick={() => patchSettings({ mode: m.value })}>
                <ModeIcon mode={m.value} />
              </button>
            ))}
          </div>
          <span class="hud-sep" />
          {s.mode !== 'voice' ? (
            <div class="hud-speed">
              <button onClick={() => patchSettings({ speed: Math.max(1, s.speed - 0.5) })} aria-label="Slower">
                −
              </button>
              <span class="hud-num">
                {speedToWpm(s.speed)}
                <span class="hud-unit">wpm</span>
              </span>
              <button onClick={() => patchSettings({ speed: Math.min(10, s.speed + 0.5) })} aria-label="Faster">
                +
              </button>
            </div>
          ) : (
            <span class="hud-num">
              {wpm || '…'}
              <span class="hud-unit">wpm</span>
            </span>
          )}
          <span class="hud-sep" />
          <span class="hud-time" title="Elapsed / remaining">
            {formatClock(elapsed.value)}
            <span class="hud-unit">/</span>
            <span class={remaining < 60_000 && playing.value ? 'last-call' : ''}>−{formatClock(remaining)}</span>
          </span>
          {(s.mode !== 'manual' || level) && (
            <>
              <span class="hud-sep" />
              <span class={`hud-meter ${level?.speaking ? 'speaking' : ''}`} title={status ?? 'Microphone'}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <span style={{ transform: `scaleY(${Math.max(0.15, Math.min(1, (level?.value ?? 0) * 1.6 - i * 0.12))})` }} />
                ))}
              </span>
            </>
          )}
          {listener.current && listener.current.stamps.length > 3 && !playing.value && (
            <>
              <span class="hud-sep" />
              <button class="hud-text" onClick={() => exportCaptions('srt')} title="Download timed captions (SRT)">
                SRT
              </button>
              <button class="hud-text" onClick={() => exportCaptions('vtt')} title="Download timed captions (WebVTT)">
                VTT
              </button>
            </>
          )}
          <span class="hud-sep" />
          <button class={`hud-icon ${s.mirrorX ? 'on' : ''}`} onClick={() => patchSettings({ mirrorX: !s.mirrorX })} title="Mirror (M)" aria-label="Mirror">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path d="M8 1.5v13" stroke="currentColor" stroke-dasharray="1.6 1.6" />
              <path d="M6 4 2 12h4zM10 4l4 8h-4z" fill="none" stroke="currentColor" stroke-linejoin="round" />
            </svg>
          </button>
          <button class="hud-icon" onClick={onExit} title="Back to the desk (Esc)" aria-label="Exit">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      )}
      {!display && status && <div class="stage-status">{status}</div>}
      {!display && !playing.value && countdown.value === null && (
        <p class="stage-hint">
          <Kbd>space</Kbd> go · <Kbd>←</Kbd>
          <Kbd>→</Kbd> lines · <Kbd>?</Kbd> all keys · <Kbd>esc</Kbd> desk
        </p>
      )}
      {!display && help.value && (
        <div class="keys" role="dialog" aria-label="Keyboard shortcuts" onClick={() => (help.value = false)}>
          <div class="keys-card" onClick={(e) => e.stopPropagation()}>
            <p class="keys-title">Keys on stage</p>
            <dl>
              {KEYS.map(([k, v]) => (
                <div key={v}>
                  <dt>
                    {k.split(' ').map((x) => (
                      <Kbd>{x}</Kbd>
                    ))}
                  </dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p class="keys-foot">Presentation clickers work too: they send Page Up and Page Down.</p>
          </div>
        </div>
      )}
    </div>
  )
}
