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

function ago(t: number): string {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** On small screens the rail and the setup panel slide up as sheets. */
export const deskSheet = signal<'none' | 'scripts' | 'setup'>('none')

function SheetHead({ title }: { title: string }) {
  return (
    <div class="sheet-head">
      <span class="sheet-grip" aria-hidden="true" />
      <span class="sheet-title">{title}</span>
      <button class="sheet-done" onClick={() => (deskSheet.value = 'none')}>
        Done
      </button>
    </div>
  )
}

function Rail() {
  return (
    <aside class={`rail ${deskSheet.value === 'scripts' ? 'is-open' : ''}`}>
      <SheetHead title="Scripts" />
      <div class="rail-head">
        <span class="rail-heading">Scripts</span>
        <label class="icon-btn" title="Import a .txt or .md file" aria-label="Import a script file">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <input
            type="file"
            accept={IMPORT_ACCEPT}
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
                aria-label={`Delete ${s.title}`}
                title="Delete"
                onClick={() => confirm(`Delete “${s.title || 'Untitled'}”? This can't be undone.`) && deleteScript(s.id)}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      <p class="rail-foot">Saved in this browser. Never uploaded.</p>
    </aside>
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
      <input
        class="page-title"
        value={script.title}
        placeholder="Untitled"
        aria-label="Script title"
        onInput={(e) => updateScript(script.id, { title: (e.target as HTMLInputElement).value })}
      />
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
        placeholder={'Paste or write your script.\n\n# A heading starts a section\n[smile] Brackets are cues: shown, never read.\nA blank line starts a new paragraph.'}
        aria-label="Script"
        onInput={(e) => updateScript(script.id, { text: (e.target as HTMLTextAreaElement).value })}
      />
      <p class="page-hint">
        <span>
          <Kbd>#</Kbd> section
        </span>
        <span>
          <Kbd>[cue]</Kbd> stage note
        </span>
        <span>
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> go
        </span>
      </p>
    </div>
  )
}

function Setup() {
  const s = settings.value
  return (
    <aside class={`setup ${deskSheet.value === 'setup' ? 'is-open' : ''}`}>
      <SheetHead title="Settings" />
      <Section label="Motion">
        <Segmented
          label="Scroll mode"
          value={s.mode}
          onChange={(mode) => patchSettings({ mode })}
          options={[
            { value: 'manual', label: 'Steady', icon: <ModeIcon mode="manual" />, title: 'Scrolls at a steady speed' },
            { value: 'voice', label: 'Voice', icon: <ModeIcon mode="voice" />, title: 'Follows your words' },
            { value: 'breath', label: 'Breath', icon: <ModeIcon mode="breath" />, title: 'Moves while you speak, rests when you pause' },
          ]}
        />
        <p class="setup-note">
          {s.mode === 'manual' && 'A steady glide at the pace you set.'}
          {s.mode === 'voice' && 'Listens and follows your place in the script. Skip, stumble or ad-lib, and it keeps up.'}
          {s.mode === 'breath' && 'No speech recognition. Scrolls while you talk and settles when you stop.'}
        </p>
        {s.mode !== 'voice' && (
          <Slider label="Pace" value={s.speed} min={1} max={10} step={0.5} format={(v) => `${speedToWpm(v)} wpm`} onInput={(speed) => patchSettings({ speed })} />
        )}
      </Section>

      {s.mode !== 'manual' && (
        <Section label="Listening">
          <Slider
            label="Mic sensitivity"
            value={Math.round(s.sensitivity * 100)}
            min={0}
            max={100}
            format={(v) => (v < 34 ? 'Close mic' : v < 67 ? 'Normal' : 'Soft voice')}
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

      <Section label="Type">
        <Slider label="Size" value={s.fontSize} min={28} max={120} format={(v) => `${v}px`} onInput={(fontSize) => patchSettings({ fontSize })} />
        <Slider label="Measure" value={s.measure} min={14} max={48} format={(v) => `${v} ch`} onInput={(measure) => patchSettings({ measure })} />
        <Slider label="Leading" value={s.lineHeight} min={1.05} max={1.9} step={0.01} format={(v) => v.toFixed(2)} onInput={(lineHeight) => patchSettings({ lineHeight })} />
      </Section>

      <Section label="Glass">
        <Slider label="Reading line" value={Math.round(s.eyeline * 100)} min={12} max={70} format={(v) => `${v}% down`} onInput={(v) => patchSettings({ eyeline: v / 100 })} />
        <Toggle label="Mirror horizontally" hint="For beam-splitter glass" checked={s.mirrorX} onChange={(mirrorX) => patchSettings({ mirrorX })} />
        <Toggle label="Mirror vertically" checked={s.mirrorY} onChange={(mirrorY) => patchSettings({ mirrorY })} />
      </Section>

      <Section label="Extras">
        <Toggle label="Countdown" hint="3, 2, 1 before you start" checked={s.countdown} onChange={(countdown) => patchSettings({ countdown })} />
        <Toggle label="Camera check" hint="See yourself under the lens" checked={s.camera} onChange={(camera) => patchSettings({ camera })} />
        <Toggle label="The lamp" hint="It nods along. It means well." checked={s.lamp} onChange={(lamp) => patchSettings({ lamp })} />
        <Toggle label="Dark desk" hint="The stage is always dark" checked={s.theme === 'night'} onChange={(v) => patchSettings({ theme: v ? 'night' : 'paper' })} />
      </Section>
    </aside>
  )
}

export function Desk() {
  const script = useComputed(() => scripts.value.find((s) => s.id === currentId.value))
  const wrap = useRef<HTMLDivElement>(null)
  const handle = useRef(createLampHandle({ beamStrength: 0.55 })).current
  const dragging = useSignal(false)

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
      <div
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
      </div>
      <Setup />
    </div>
  )
}
