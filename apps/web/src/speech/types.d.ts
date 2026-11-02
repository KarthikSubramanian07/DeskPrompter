/**
 * Minimal ambient types for the experimental parts of the Web Speech API.
 *
 * lib.dom ships the event and result types (SpeechRecognitionEvent,
 * SpeechRecognitionErrorEvent, SpeechRecognitionResultList…) but not the
 * SpeechRecognition interface itself, nor Chrome's on-device additions
 * (processLocally, available(), install(), phrases, start(track)). These
 * names are prefixed so a future lib.dom that adds the real ones can't clash.
 *
 * Spec: https://webaudio.github.io/web-speech-api/
 */

type DPSpeechAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

interface DPSpeechRecognitionOptions {
  langs: string[]
  processLocally?: boolean
}

/** `new SpeechRecognitionPhrase(phrase, boost = 1.0)` (Chrome 142+). */
interface DPSpeechRecognitionPhrase {
  readonly phrase: string
  readonly boost: number
}

interface DPSpeechRecognitionPhraseCtor {
  new (phrase: string, boost?: number): DPSpeechRecognitionPhrase
}

interface DPSpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  /** Chrome 139+: keep audio on the device. Undefined where unsupported. */
  processLocally?: boolean
  /** Chrome 142+: contextual biasing. An ObservableArray; assigning an array works. */
  phrases?: DPSpeechRecognitionPhrase[]
  /** Chrome 135+ accepts the MediaStreamTrack to listen to. Older engines ignore the argument. */
  start(audioTrack?: MediaStreamTrack): void
  stop(): void
  abort(): void
  onstart: ((this: DPSpeechRecognition, ev: Event) => unknown) | null
  onend: ((this: DPSpeechRecognition, ev: Event) => unknown) | null
  onresult: ((this: DPSpeechRecognition, ev: SpeechRecognitionEvent) => unknown) | null
  onerror: ((this: DPSpeechRecognition, ev: SpeechRecognitionErrorEvent) => unknown) | null
}

interface DPSpeechRecognitionCtor {
  new (): DPSpeechRecognition
  readonly prototype: DPSpeechRecognition
  /** Chrome 139+. On-device status is masked as 'downloadable' until install() runs for the origin. */
  available?(options: DPSpeechRecognitionOptions): Promise<DPSpeechAvailability>
  /** Chrome 139+. Needs transient activation when it would start a download. */
  install?(options: DPSpeechRecognitionOptions): Promise<boolean>
}

/** Where the constructors live on `globalThis`, when they exist at all. */
interface DPSpeechGlobals {
  SpeechRecognition?: DPSpeechRecognitionCtor
  webkitSpeechRecognition?: DPSpeechRecognitionCtor
  SpeechRecognitionPhrase?: DPSpeechRecognitionPhraseCtor
}

/** The Emscripten factory moonshine-wasm ships untyped. */
declare module '@moonshine-ai/moonshine-wasm/moonshine.mjs' {
  const createMoonshineModule: (args?: Record<string, unknown>) => Promise<unknown>
  export default createMoonshineModule
}
