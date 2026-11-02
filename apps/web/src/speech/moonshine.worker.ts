/// <reference lib="webworker" />
/**
 * Moonshine runs here, off the main thread, so a transcription pass never
 * costs the prompter a frame.
 *
 * The page sends one MessagePort wired straight to the capture worklet. 16 kHz
 * mono PCM flows worklet → worker without touching the main thread. We hand
 * it to a streaming transcriber and post line events back to the page.
 */
import { AssetDownloader, ModelArch, Transcriber, loadMoonshineModule, type Stream } from '@moonshine-ai/moonshine-wasm'
import createMoonshineModule from '@moonshine-ai/moonshine-wasm/moonshine.mjs'
import wasmUrl from '@moonshine-ai/moonshine-wasm/moonshine.wasm?url'
import {
  MOONSHINE_ARCH,
  MOONSHINE_DOWNLOAD_BYTES,
  RUNTIME_CACHE,
  readyMarkerUrl,
  type ReadyMarker,
} from './moonshineSupport'

export type ToWorker =
  | { t: 'load'; lang: string }
  | { t: 'audio'; port: MessagePort }
  | { t: 'start' }
  | { t: 'stop' }
  | { t: 'keyterms'; terms: string[] }

export type FromWorker =
  | { t: 'progress'; loaded: number; total: number }
  | { t: 'loaded'; ms: number }
  | { t: 'text'; id: string; text: string }
  | { t: 'line'; id: string; text: string }
  | { t: 'stopped' }
  | { t: 'error'; message: string; fatal: boolean }

declare const self: DedicatedWorkerGlobalScope
const post = (msg: FromWorker) => self.postMessage(msg)

const SAMPLE_RATE = 16000
/** Seconds of new audio between passes. Moonshine's default is 0.5; lower means fresher interims. */
const PASS_INTERVAL = 0.25

let transcriber: Transcriber | undefined
let stream: Stream | undefined
let running = false
let passQueued = false
let pendingTerms: string[] | undefined
let audioPort: MessagePort | undefined

/** Remembers which URLs the model came from, so the registry can tell later whether it's all cached. */
class RecordingDownloader extends AssetDownloader {
  readonly urls: string[] = []
  override fetchFile(url: string) {
    this.urls.push(new URL(url, self.location.href).href)
    return super.fetchFile(url)
  }
}

/** Fetch through Cache Storage so the 13 MB runtime works offline (it's too big for the PWA precache). */
async function cachedBytes(url: string, onBytes: (loaded: number) => void): Promise<Uint8Array> {
  const cache = await caches.open(RUNTIME_CACHE).catch(() => undefined)
  const hit = await cache?.match(url)
  const res = hit ?? (await fetch(url))
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`)
  if (!hit && cache) {
    // Drop runtimes from older builds before storing this one.
    for (const req of await cache.keys()) if (req.url.endsWith('.wasm') && req.url !== url) await cache.delete(req)
    await cache.put(url, res.clone())
  }
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(await res.arrayBuffer())
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    onBytes(loaded)
  }
  const out = new Uint8Array(loaded)
  let at = 0
  for (const c of chunks) out.set(c, (at += c.byteLength) - c.byteLength)
  return out
}

async function load(lang: string) {
  if (transcriber) return post({ t: 'loaded', ms: 0 })
  const t0 = performance.now()
  // One monotonic bar across the runtime and the model files.
  let wasmBytes = 0
  let modelBytes = 0
  let modelTotal: number | undefined
  let reported = 0
  const report = () => {
    const total = Math.max(MOONSHINE_DOWNLOAD_BYTES, wasmBytes + (modelTotal ?? MOONSHINE_DOWNLOAD_BYTES - 13_160_000))
    const loaded = Math.max(reported, Math.min(total, wasmBytes + modelBytes))
    reported = loaded
    post({ t: 'progress', loaded, total })
  }
  const url = new URL(wasmUrl, self.location.href).href
  const wasmBinary = await cachedBytes(url, (n) => {
    wasmBytes = n
    report()
  })
  const module = await loadMoonshineModule({
    factory: (args) => createMoonshineModule({ ...args, wasmBinary }) as never,
  })
  const downloader = new RecordingDownloader({
    onProgress: (loaded, total) => {
      modelBytes = loaded
      if (total) modelTotal = total
      report()
    },
  })
  transcriber = await Transcriber.load({
    language: lang,
    modelArch: MOONSHINE_ARCH as ModelArch,
    module,
    downloader,
    options: {
      transcription_interval: String(PASS_INTERVAL),
      // We only want text; per-line PCM would be copied out of the heap for nothing.
      return_audio_data: 'false',
    },
  })
  const marker: ReadyMarker = { files: downloader.urls, wasm: url }
  await caches
    .open(RUNTIME_CACHE)
    .then((c) => c.put(readyMarkerUrl(lang), new Response(JSON.stringify(marker))))
    .catch(() => undefined)
  if (pendingTerms) setKeyterms(pendingTerms)
  post({ t: 'loaded', ms: Math.round(performance.now() - t0) })
}

function setKeyterms(terms: string[]) {
  if (!transcriber) return void (pendingTerms = terms)
  pendingTerms = undefined
  try {
    transcriber.setKeyterms(terms.filter((t) => t && !t.includes(',')))
  } catch (err) {
    post({ t: 'error', message: `Moonshine ignored the hint words: ${String(err)}`, fatal: false })
  }
}

function ensureStream(): Stream {
  if (!transcriber) throw new Error('Moonshine is not loaded yet.')
  if (!stream) {
    stream = transcriber.createStream({ updateInterval: PASS_INTERVAL })
    stream.addListener({
      onLineStarted: ({ line }) => post({ t: 'text', id: line.id, text: line.text }),
      onLineTextChanged: ({ line }) => post({ t: 'text', id: line.id, text: line.text }),
      onLineCompleted: ({ line }) => post({ t: 'line', id: line.id, text: line.text }),
      onError: ({ error }) => post({ t: 'error', message: String(error), fatal: false }),
    })
  }
  return stream
}

/** Coalesce: however many chunks arrived while a pass ran, run one pass for them. */
function queuePass() {
  if (passQueued) return
  passQueued = true
  setTimeout(() => {
    passQueued = false
    if (!running || !stream) return
    try {
      stream.transcribe()
    } catch (err) {
      post({ t: 'error', message: String(err), fatal: false })
    }
  }, 0)
}

function onAudio(e: MessageEvent<Float32Array>) {
  if (!running || !stream) return
  stream.addAudio(e.data, SAMPLE_RATE)
  queuePass()
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  try {
    switch (msg.t) {
      case 'load':
        await load(msg.lang)
        return
      case 'audio':
        audioPort?.close()
        audioPort = msg.port
        audioPort.onmessage = onAudio
        return
      case 'start':
        ensureStream().start()
        running = true
        return
      case 'stop':
        if (running && stream) {
          running = false
          stream.stop() // flushes the last line as complete
        }
        audioPort?.close()
        audioPort = undefined
        post({ t: 'stopped' })
        return
      case 'keyterms':
        setKeyterms(msg.terms)
        return
    }
  } catch (err) {
    post({ t: 'error', message: err instanceof Error ? err.message : String(err), fatal: msg.t === 'load' || msg.t === 'start' })
  }
}
