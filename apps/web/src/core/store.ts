/**
 * App state. Signals for everything the UI reads; scripts persist to IndexedDB,
 * settings to localStorage. Nothing here talks to a network.
 */
import { effect, signal } from '@preact/signals'
import { get, set } from 'idb-keyval'
import type { PrompterMode, SpeechEngineId } from './contracts'
import { SAMPLE_SCRIPT, SAMPLE_TITLE } from './sample'

export interface Script {
  id: string
  title: string
  text: string
  updatedAt: number
}

export interface Settings {
  fontSize: number // px at 1440 wide; scaled by viewport
  lineHeight: number
  measure: number // column width in ch
  eyeline: number // 0..1 from top of the stage
  speed: number // 1..10
  mode: PrompterMode
  mirrorX: boolean
  mirrorY: boolean
  theme: 'night' | 'paper'
  countdown: boolean
  camera: boolean
  lamp: boolean
  engine: SpeechEngineId | 'auto'
  allowCloud: boolean
  sensitivity: number // voice gate 0..1
  dimPast: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 56,
  lineHeight: 1.32,
  measure: 26,
  eyeline: 0.3,
  speed: 4,
  mode: 'manual',
  mirrorX: false,
  mirrorY: false,
  theme: 'paper',
  countdown: true,
  camera: false,
  lamp: true,
  engine: 'auto',
  allowCloud: false,
  sensitivity: 0.5,
  dimPast: true,
}

const SETTINGS_KEY = 'dp.settings.v1'
const SCRIPTS_KEY = 'dp.scripts.v1'
const CURRENT_KEY = 'dp.current.v1'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export const settings = signal<Settings>(loadSettings())
export const scripts = signal<Script[]>([])
export const currentId = signal<string>('')
export const ready = signal(false)

export function patchSettings(p: Partial<Settings>) {
  settings.value = { ...settings.value, ...p }
}

effect(() => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value))
  } catch {
    /* private mode */
  }
})

export function uid(): string {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export function currentScript(): Script | undefined {
  return scripts.value.find((s) => s.id === currentId.value)
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function persist() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void set(SCRIPTS_KEY, scripts.value)
    try {
      localStorage.setItem(CURRENT_KEY, currentId.value)
    } catch {
      /* ignore */
    }
  }, 250)
}

export function updateScript(id: string, p: Partial<Pick<Script, 'title' | 'text'>>) {
  scripts.value = scripts.value.map((s) => (s.id === id ? { ...s, ...p, updatedAt: Date.now() } : s))
  persist()
}

export function newScript(title = 'Untitled', text = ''): Script {
  const s: Script = { id: uid(), title, text, updatedAt: Date.now() }
  scripts.value = [s, ...scripts.value]
  currentId.value = s.id
  persist()
  return s
}

export function deleteScript(id: string) {
  scripts.value = scripts.value.filter((s) => s.id !== id)
  if (currentId.value === id) currentId.value = scripts.value[0]?.id ?? newScript().id
  persist()
}

export function selectScript(id: string) {
  currentId.value = id
  persist()
}

export async function hydrate() {
  let list: Script[] | undefined
  try {
    list = await get<Script[]>(SCRIPTS_KEY)
  } catch {
    list = undefined
  }
  if (!list || list.length === 0) list = [{ id: uid(), title: SAMPLE_TITLE, text: SAMPLE_SCRIPT, updatedAt: Date.now() }]
  scripts.value = list
  const saved = (() => {
    try {
      return localStorage.getItem(CURRENT_KEY)
    } catch {
      return null
    }
  })()
  currentId.value = list.some((s) => s.id === saved) ? saved! : list[0]!.id
  ready.value = true
}
