/**
 * What the registry needs to know about Moonshine without loading it: the
 * feature checks, the model we use, and whether that model is already cached.
 * Kept tiny on purpose; the engine and its 13 MB of WebAssembly load lazily.
 */
import type { EngineAvailability } from '../core/contracts'

/**
 * Tiny Streaming: 34M parameters, the smallest streaming model, ~51 MB
 * quantized. Base languages with a Tiny Streaming checkpoint in the catalog.
 */
export const MOONSHINE_LANGS = ['en', 'es', 'de', 'ar', 'ja', 'zh', 'vi'] as const
/** moonshine-wasm's `ModelArch.TinyStreaming`. */
export const MOONSHINE_ARCH = 2
/** Approximate first-run download in bytes (model files + the WebAssembly runtime). */
export const MOONSHINE_DOWNLOAD_BYTES = 51_430_000 + 13_160_000

/** The Cache Storage bucket moonshine-wasm's AssetDownloader writes model files to. */
export const MODEL_CACHE = 'moonshine-models-v1'
/** Our own bucket: the WebAssembly runtime, plus a marker listing a complete model download. */
export const RUNTIME_CACHE = 'deskprompter-moonshine-v1'
export const readyMarkerUrl = (lang: string) => new URL(`/__moonshine/ready/tiny-streaming-${lang}`, location.href).href

export interface ReadyMarker {
  /** Absolute URLs of every model file, as cached in MODEL_CACHE. */
  files: string[]
  /** Absolute URL of the cached WebAssembly runtime, in RUNTIME_CACHE. */
  wasm: string
}

export const moonshineLang = (lang: string) => lang.toLowerCase().split(/[-_]/)[0] ?? 'en'

/**
 * The published moonshine-wasm build uses WebAssembly threads, which need
 * SharedArrayBuffer, which needs a cross-origin isolated page (COOP + COEP).
 */
export function moonshineSupported(g: typeof globalThis = globalThis): boolean {
  return (
    g.crossOriginIsolated === true &&
    typeof g.SharedArrayBuffer === 'function' &&
    typeof g.WebAssembly === 'object' &&
    typeof g.Worker === 'function' &&
    typeof g.AudioWorkletNode === 'function'
  )
}

/** True once a previous run downloaded every file this language's model needs. */
export async function moonshineCached(lang: string, g: typeof globalThis = globalThis): Promise<boolean> {
  if (typeof g.caches === 'undefined') return false
  try {
    const runtime = await g.caches.open(RUNTIME_CACHE)
    const res = await runtime.match(readyMarkerUrl(moonshineLang(lang)))
    if (!res) return false
    const marker = (await res.json()) as ReadyMarker
    if (!(await runtime.match(marker.wasm))) return false
    const models = await g.caches.open(MODEL_CACHE)
    for (const url of marker.files) if (!(await models.match(url))) return false
    return true
  } catch {
    return false
  }
}

export async function probeMoonshine(lang: string, g: typeof globalThis = globalThis): Promise<EngineAvailability> {
  if (!moonshineSupported(g)) return 'unavailable'
  if (!(MOONSHINE_LANGS as readonly string[]).includes(moonshineLang(lang))) return 'unavailable'
  return (await moonshineCached(lang, g)) ? 'available' : 'downloadable'
}
