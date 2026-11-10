import { downloadScript } from '../../core/downloadScript'
/**
 * The writing desk: scripts on the left, the page in the middle, the setup on
 * the right, and the lamp keeping you company in the corner.
 */
import { signal, useComputed, useSignal } from '@preact/signals'
import { useEffect, useMemo, useRef } from 'preact/hooks'
import { parseScript } from '../../core/parser'
import {
  currentId,
  deleteScript,
  newScript,
  patchSettings,
  scripts,
  selectScript,
  settings,
  updateScript,
  type Script,
} from '../../core/store'
import { formatClock } from '../../core/timing'
import { speedToWpm } from '../../core/prompter'
import { createLampHandle, Lamp } from '../lamp/Lamp'
import { caretXY } from './caret'
import { IMPORT_ACCEPT, isImportable, readScriptFile } from '../../core/importScript'
import { Section, Segmented, Slider, Toggle, Kbd } from './controls'
import { ModeIcon } from '../icons'
import { MODE_COPY, MODE_ORDER, micLabel, spacingLabel, widthLabel } from '../../core/modes'
import { dismissGuide, guideDone } from '../../core/guide'

function ago(t: number): string {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** On small screens the rail and the setup panel slide up as sheets. */
export const deskSheet = signal<'none' | 'scripts' | 'setup'>('none')

function SheetHead({ title, id }: { title: string; id: string }) {
  return (
    <div class="sheet-head">
      <span class="sheet-grip" aria-hidden="true" />
      <h2 class="sheet-title" id={id}>
        {title}
      </h2>
      <button class="sheet-done" onClick={() => (deskSheet.value = 'none')}>
        Done
      </button>
    </div>
  )
}

/** Open sheets behave as modal dialogs; closed ones are plain side panels. */
function sheetProps(name: 'scripts' | 'setup', label: string) {
  const open = deskSheet.value === name
  return open
    ? ({ role: 'dialog', 'aria-modal': true, 'aria-labelledby': `sheet-${name}` } as const)
    : ({ role: 'complementary', 'aria-label': label } as const)
}

function Rail() {
  return (
    <section class={`rail ${deskSheet.value === 'scripts' ? 'is-open' : ''}`} {...sheetProps('scripts', 'Scripts')}>
      <SheetHead title="Scripts" id="sheet-scripts" />
      <div class="rail-head">
        <h2 class="rail-heading">Scripts</h2>
        <label class="icon-btn" title="Import a .txt or .md file">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <input
            type="file"
            accept={IMPORT_ACCEPT}
            aria-label="Import a script file"
            class="sr-only"
            onChange={async (e) => {
              const input = e.target as HTMLInputElement
              for (const f of Array.from(input.files ?? [])) if (isImportable(f)) {
                const { title, text } = await readScriptFile(f)
                newScript(title, text)
              }
              input.value = ''
            }}
          />
        </label>
        <button class="icon-btn" title="New script" aria-label="New script" onClick={() => newScript()}>
          +
        </button>
      </div>
      <ul class="rail-list">
        {scripts.value.map((s) => (
          <li key={s.id}>
            <button
              class={`rail-item ${s.id === currentId.value ? 'on' : ''}`}
              aria-current={s.id === currentId.value ? 'true' : undefined}
              onClick={() => {
                selectScript(s.id)
                deskSheet.value = 'none'
              }}
            >
              <span class="rail-dot" aria-hidden="true" />
              <span class="rail-title">{s.title || 'Untitled'}</span>
              <span class="rail-meta">{ago(s.updatedAt)}</span>
            </button>
            {scripts.value.length > 1 && (
              <button
                class="rail-del"
                aria-label={`Delete ${s.title || 'Untitled'}`}
                title="Delete"
                onClick={() => confirm(`Delete “${s.title || 'Untitled'}”? This can't be undone.`) && deleteScript(s.id)}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      <p class="rail-foot">Scripts stay in this browser. Download a copy to keep a backup.</p>
    </section>
  )
}

function Page({ script }: { script: Script }) {
  const ta = useRef<HTMLTextAreaElement>(null)
  const stats = useMemo(() => {
    const p = parseScript(script.text)
    const cues = p.blocks.reduce((n, b) => n + b.tokens.filter((t) => t.kind === 'cue').length, 0)
    return { words: p.wordCount, cues, sections: p.blocks.filter((b) => b.kind === 'heading').length }
  }, [script.text])
  const wpm = speedToWpm(settings.value.speed)

  return (
    <div class="page">
      {!guideDone.value && (
        <section class="guide" aria-label="How to start">
          <ol>
            <li>
              <strong>Add your script.</strong> Type or paste it below, or drop in a text file.
            </li>
            <li>
              <strong>Choose how it scrolls</strong> in the settings. Auto scroll needs no microphone.
            </li>
            <li>
              <strong>Press Start</strong> and read. Press Esc to come back here.
            </li>
          </ol>
          <button class="guide-close" onClick={dismissGuide}>
            Got it
          </button>
        </section>
      )}
      <input
        class="page-title"
        value={script.title}
        placeholder="Untitled"
        aria-label="Script title"
        onInput={(e) => updateScript(script.id, { title: (e.target as HTMLInputElement).value })}
      />
      <button class="script-download" onClick={() => downloadScript(script)}>Download script</button>
      <p class="page-meta">
        <span>{stats.words.toLocaleString()} words</span>
        <span>·</span>
        <span>
          ~{formatClock((stats.words / wpm) * 60_000)} at {wpm} wpm
        </span>
        {stats.cues > 0 && (
          <>
            <span>·</span>
            <span>{stats.cues} cues</span>
          </>
        )}
        {stats.sections > 0 && (
          <>
            <span>·</span>
            <span>{stats.sections} sections</span>
          </>
        )}
      </p>
      <textarea
        ref={ta}
        id="script-editor"
        class="page-text"
        value={script.text}
        spellcheck
        placeholder={'Type or paste your script here.\n\nLeave a blank line between paragraphs.\n# A line starting with # becomes a section heading.\n[Square brackets] are notes to yourself. They show on screen but you don\'t read them.'}
        aria-label="Script"
        onInput={(e) => updateScript(script.id, { text: (e.target as HTMLTextAreaElement).value })}
      />
      <p class="page-hint">
        <span>
          <Kbd>#</Kbd> heading
        </span>
        <span>
          <Kbd>[ ]</Kbd> note to yourself
        </span>
        <span>
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> start
        </span>
      </p>
    </div>
  )
}

function Setup() {
  const s = settings.value
  return (
    <section class={`setup ${deskSheet.value === 'setup' ? 'is-open' : ''}`} {...sheetProps('setup', 'Settings')}>
      <SheetHead title="Settings" id="sheet-setup" />
      <Section label="Scrolling">
        <Segmented
          label="Scroll mode"
          value={s.mode}
          onChange={(mode) => patchSettings({ mode })}
          options={[
            ...MODE_ORDER.map((m) => ({ value: m, label: MODE_COPY[m].label, icon: <ModeIcon mode={m} />, title: MODE_COPY[m].summary })),
          ]}
        />
        <p class="setup-note">
          {MODE_COPY[s.mode].summary}
          {MODE_COPY[s.mode].needsMic && ' Your browser will ask to use the microphone. Audio stays on this device.'}
        </p>
        {s.mode !== 'voice' && (
          <Slider label="Speed" value={s.speed} min={1} max={10} step={0.5} format={(v) => `${speedToWpm(v)} wpm`} onInput={(speed) => patchSettings({ speed })} />
        )}
      </Section>

      {s.mode !== 'manual' && (
        <Section label="Microphone">
          <Slider
            label="Sensitivity"
            value={Math.round(s.sensitivity * 100)}
            min={0}
            max={100}
            format={micLabel}
            onInput={(v) => patchSettings({ sensitivity: v / 100 })}
          />
          {s.mode === 'voice' && (
            <Toggle
              label="Allow cloud recognition"
              hint="Only if on-device isn’t available. Audio goes to your browser’s speech service."
              checked={s.allowCloud}
              onChange={(allowCloud) => patchSettings({ allowCloud })}
            />
          )}
        </Section>
      )}

      <Section label="Text">
        <Slider label="Text size" value={s.fontSize} min={28} max={120} format={(v) => `${v}px`} onInput={(fontSize) => patchSettings({ fontSize })} />
        <Slider label="Line width" value={s.measure} min={14} max={48} format={widthLabel} onInput={(measure) => patchSettings({ measure })} />
        <Slider label="Line spacing" value={s.lineHeight} min={1.05} max={1.9} step={0.01} format={spacingLabel} onInput={(lineHeight) => patchSettings({ lineHeight })} />
      </Section>

      <Section label="Reading screen">
        <Slider label="Where your eyes rest" value={Math.round(s.eyeline * 100)} min={12} max={70} format={(v) => (v < 30 ? 'Near the top' : v < 50 ? 'Upper middle' : 'Middle')} onInput={(v) => patchSettings({ eyeline: v / 100 })} />
        <Toggle label="Flip text" hint="For teleprompter glass that mirrors the screen" checked={s.mirrorX} onChange={(mirrorX) => patchSettings({ mirrorX })} />
        <Toggle label="Flip text vertically" hint="Reflects text from top to bottom" checked={s.mirrorY} onChange={(mirrorY) => patchSettings({ mirrorY })} />
      </Section>

      <Section label="Options">
        <Toggle label="Countdown before starting" hint="3, 2, 1" checked={s.countdown} onChange={(countdown) => patchSettings({ countdown })} />
        <Toggle label="Camera preview" hint="See yourself at the top while you read" checked={s.camera} onChange={(camera) => patchSettings({ camera })} />
        <Toggle label="Show the lamp" hint="Lights up the line you're on" checked={s.lamp} onChange={(lamp) => patchSettings({ lamp })} />
        <Toggle label="Dark editor" hint="The reading screen is always dark" checked={s.theme === 'night'} onChange={(v) => patchSettings({ theme: v ? 'night' : 'paper' })} />
      </Section>
    </section>
  )
}

export function Desk() {
  const script = useComputed(() => scripts.value.find((s) => s.id === currentId.value))
  const wrap = useRef<HTMLDivElement>(null)
  const handle = useRef(createLampHandle({ beamStrength: 0.55 })).current
  const dragging = useSignal(false)
  const opener = useRef<HTMLElement | null>(null)

  // An open sheet is modal: focus moves into it, the rest of the page is inert, Escape closes
  // it, and focus returns to the button that opened it.
  useEffect(() => {
    const name = deskSheet.value
    if (name === 'none') return
    opener.current = document.activeElement as HTMLElement | null
    const sheet = document.querySelector<HTMLElement>(name === 'scripts' ? '.rail' : '.setup')
    const others = [...document.querySelectorAll<HTMLElement>('.studio > .skip-link, .studio > .bar, .studio > .save-error, .desk-center, .rail, .setup')].filter((el) => el !== sheet)
    others.forEach((el) => (el.inert = true))
    sheet?.querySelector<HTMLElement>('.sheet-done')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') deskSheet.value = 'none'
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      others.forEach((el) => (el.inert = false))
      if (opener.current?.isConnected) opener.current.focus()
    }
  }, [deskSheet.value])

  useEffect(() => {
    const el = wrap.current!
    let gaze: { x: number; y: number } | null = null
    let idle = 0
    const layout = () => {
      const r = el.getBoundingClientRect()
      const page = el.querySelector('.page')!.getBoundingClientRect()
      handle.anchor = { x: Math.max(page.right - r.left + 56, r.width - 70), y: r.height - 4, scale: Math.min(0.66, r.height / 1250) }
    }
    layout()
    handle.rig.powerOn()
    const ro = new ResizeObserver(layout)
    ro.observe(el)
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      gaze = { x: e.clientX - r.left, y: e.clientY - r.top }
      idle = 0
    }
    const onKey = () => {
      const ta = el.querySelector<HTMLTextAreaElement>('#script-editor')
      if (document.activeElement !== ta || !ta) return
      const r = el.getBoundingClientRect()
      const c = caretXY(ta)
      gaze = { x: c.x - r.left, y: c.y - r.top }
      idle = 0
      if (Math.random() < 0.12) handle.rig.nod(0.35)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('keyup', onKey)
    el.addEventListener('click', onKey)
    let raf = 0
    let last = performance.now()
    const pool = { x: 0, y: 0 }
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      idle += dt
      const r = el.getBoundingClientRect()
      const page = el.querySelector('.page-text')!.getBoundingClientRect()
      const rest = { x: page.left - r.left + page.width * 0.5, y: page.top - r.top + Math.min(page.height, 420) * 0.4 }
      handle.rig.setMood(idle > 45 ? 'asleep' : idle > 6 ? 'idle' : 'watching')
      // In daylight the beam is invisible anyway; the lamp just keeps you company.
      handle.beamStrength = settings.value.theme === 'paper' ? 0 : 0.55
      const want = idle < 6 && gaze ? gaze : rest
      const k = 1 - Math.exp(-dt * 5)
      pool.x += (want.x - pool.x) * k
      pool.y += (want.y - pool.y) * k
      handle.pool = { x: pool.x, y: pool.y, w: Math.min(560, page.width * 0.8), h: 150 }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('keyup', onKey)
      el.removeEventListener('click', onKey)
    }
  }, [])

  return (
    <div class="desk">
      {deskSheet.value !== 'none' && <div class="sheet-scrim" onClick={() => (deskSheet.value = 'none')} />}
      <Rail />
      <main
        id="desk"
        class={`desk-center ${dragging.value ? 'is-dropping' : ''}`}
        ref={wrap}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types.includes('Files')) return
          e.preventDefault()
          dragging.value = true
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) dragging.value = false
        }}
        onDrop={async (e) => {
          e.preventDefault()
          dragging.value = false
          for (const f of Array.from(e.dataTransfer?.files ?? [])) if (isImportable(f)) {
            const { title, text } = await readScriptFile(f)
            newScript(title, text)
          }
        }}
      >
        {dragging.value && <div class="drop-hint">Drop a .txt or .md file to add it as a new script</div>}
        {script.value && <Page script={script.value} />}
        {settings.value.lamp && <Lamp handle={handle} class="desk-lamp" />}
      </main>
      <Setup />
    </div>
  )
}
