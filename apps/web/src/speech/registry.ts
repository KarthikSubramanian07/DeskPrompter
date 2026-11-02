/**
 * Which speech engines this browser can run, and which one to use.
 *
 * Probing is cheap and side-effect free: it never downloads a model, never
 * opens the microphone, and never loads the Moonshine chunk.
 */
import type { EngineAvailability, SpeechEngine, SpeechEngineId, SpeechEngineInfo } from '../core/contracts'
import { probeMoonshine } from './moonshineSupport'
import { WebSpeechEngine, probeWebSpeech, webSpeechEnv, type WebSpeechEnv } from './webSpeech'

export const ENGINE_IDS: readonly SpeechEngineId[] = ['chrome-local', 'moonshine', 'cloud-web-speech']

const LABELS: Record<SpeechEngineId, string> = {
  'chrome-local': 'Chrome, on this device',
  moonshine: 'Moonshine, in this tab',
  'cloud-web-speech': 'Browser cloud speech',
}

const LOCAL: Record<SpeechEngineId, boolean> = {
  'chrome-local': true,
  moonshine: true,
  'cloud-web-speech': false,
}

const NOTES: Record<SpeechEngineId, Record<EngineAvailability, string>> = {
  'chrome-local': {
    available: 'Runs in Chrome, on this device, so your audio never leaves it.',
    downloadable: 'Runs in Chrome on this device after Chrome fetches its speech model once.',
    unavailable: 'Needs Chrome 139 or newer with on-device speech for this language.',
  },
  moonshine: {
    available: 'Runs an open-source model inside this tab, so your audio never leaves the device.',
    downloadable: 'Runs an open-source model inside this tab after a one-time download of about 65 MB.',
    unavailable: 'Needs a browser with WebAssembly threads, such as current Chrome, Edge, Firefox or Safari.',
  },
  'cloud-web-speech': {
    available: 'Sends your audio to your browser maker’s servers (Google for Chrome, Apple for Safari) to turn it into text.',
    downloadable: 'Sends your audio to your browser maker’s servers (Google for Chrome, Apple for Safari) to turn it into text.',
    unavailable: 'This browser has no built-in speech recognition.',
  },
}

export function engineInfo(id: SpeechEngineId, availability: EngineAvailability): SpeechEngineInfo {
  return { id, label: LABELS[id], local: LOCAL[id], availability, note: NOTES[id][availability] }
}

export interface ProbeOptions {
  /** BCP 47 tag of the script's language. Default: the browser's language, else en-US. */
  lang?: string
  /** Test seam. */
  env?: WebSpeechEnv
  /** Test seam. */
  global?: typeof globalThis
}

const defaultLang = () => globalThis.navigator?.language || 'en-US'

export async function probeEngine(id: SpeechEngineId, opts: ProbeOptions = {}): Promise<EngineAvailability> {
  const lang = opts.lang ?? defaultLang()
  try {
    if (id === 'moonshine') return await probeMoonshine(lang, opts.global)
    return await probeWebSpeech(id, lang, opts.env ?? webSpeechEnv(opts.global))
  } catch {
    return 'unavailable'
  }
}

/** Every engine with its availability and a one-sentence note, in preference order. */
export async function listEngines(opts: ProbeOptions = {}): Promise<SpeechEngineInfo[]> {
  return Promise.all(ENGINE_IDS.map(async (id) => engineInfo(id, await probeEngine(id, opts))))
}

/** Build an engine. Moonshine comes from its own lazy chunk. */
export async function createEngine(id: SpeechEngineId, opts: Pick<ProbeOptions, 'env'> = {}): Promise<SpeechEngine> {
  switch (id) {
    case 'chrome-local':
    case 'cloud-web-speech':
      return new WebSpeechEngine(id, opts.env)
    case 'moonshine': {
      const { MoonshineEngine } = await import('./moonshine')
      return new MoonshineEngine()
    }
  }
}

/**
 * The engine to use when the user chose "auto", or null if none can run.
 *
 * 1. Chrome on-device when it's ready.
 * 2. Moonshine when its model is cached.
 * 3. Chrome on-device when it only needs install(). Chrome reports
 *    'downloadable' to every origin that hasn't called install() yet, even
 *    when the language pack is already on disk, so this is usually instant
 *    and far smaller than Moonshine's first download.
 * 4. Moonshine, downloading its model.
 * 5. Cloud recognition, only if the user opted in.
 */
export function chooseEngine(engines: readonly SpeechEngineInfo[], opts: { allowCloud: boolean }): SpeechEngineId | null {
  const status = (id: SpeechEngineId) => engines.find((e) => e.id === id)?.availability ?? 'unavailable'
  const order: [SpeechEngineId, EngineAvailability][] = [
    ['chrome-local', 'available'],
    ['moonshine', 'available'],
    ['chrome-local', 'downloadable'],
    ['moonshine', 'downloadable'],
  ]
  for (const [id, want] of order) if (status(id) === want) return id
  if (opts.allowCloud && status('cloud-web-speech') !== 'unavailable') return 'cloud-web-speech'
  return null
}

export async function pickDefaultEngine(
  opts: { allowCloud: boolean; engines?: readonly SpeechEngineInfo[] } & ProbeOptions,
): Promise<SpeechEngineId | null> {
  return chooseEngine(opts.engines ?? (await listEngines(opts)), opts)
}
