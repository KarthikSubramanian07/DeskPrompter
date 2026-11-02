/**
 * Shared contracts between DeskPrompter's modules.
 *
 * The Rust aligner (crates/aligner), the Zig voice gate (zig/vad), the speech
 * engines and the device link all speak these types. Keep this file the single
 * source of truth: change a shape here first, then the implementations.
 */

/* ───────────────────────── Script model (produced by Rust) ───────────────────────── */

/** A word is spoken and tracked. A cue is `[bracketed]` stage direction: shown, never tracked. */
export type TokenKind = 'word' | 'cue'

export interface ScriptToken {
  kind: TokenKind
  /** Exact source text of this token (a word keeps its trailing punctuation for display). */
  text: string
  /** UTF-16 offsets into the original script string, so `script.slice(start, end) === text`. */
  start: number
  end: number
  /** Index among spoken words (0-based). -1 for cues. */
  wi: number
}

/** `# Heading` lines become section markers (not tracked). Everything else is a paragraph. */
export interface ScriptBlock {
  kind: 'heading' | 'para'
  start: number
  end: number
  tokens: ScriptToken[]
}

export interface ParsedScript {
  blocks: ScriptBlock[]
  wordCount: number
}

/* ───────────────────────── Voice-follow alignment ───────────────────────── */

export type TrackState = 'tracking' | 'holding' | 'lost' | 'jumped'

export interface AlignResult {
  /** Committed word index: the last word we are confident was spoken (-1 before the first). */
  cursor: number
  /** Speculative word index from interim speech; always >= cursor. Drives the soft highlight. */
  lead: number
  /** 0..1 confidence of the latest match. */
  confidence: number
  state: TrackState
  /** True if cursor or lead moved on this feed. */
  changed: boolean
}

export interface ScriptAligner {
  readonly wordCount: number
  /**
   * Feed the recognizer's current hypothesis for the *ongoing utterance*.
   * Interim results (isFinal=false) may only move `lead`; finals commit `cursor`.
   */
  feed(text: string, isFinal: boolean): AlignResult
  /** Manual snap (user tapped a word, or scrolled by hand). */
  setCursor(wordIndex: number): void
  dispose(): void
}

/* ───────────────────────── Speech engines ───────────────────────── */

export type SpeechEngineId = 'chrome-local' | 'moonshine' | 'cloud-web-speech'

export type EngineAvailability = 'available' | 'downloadable' | 'unavailable'

export interface SpeechEngineInfo {
  id: SpeechEngineId
  label: string
  /** True if audio never leaves the device. */
  local: boolean
  availability: EngineAvailability
  /** One plain sentence for the settings panel, e.g. "Runs in Chrome, on this device." */
  note: string
}

export interface SpeechResult {
  text: string
  isFinal: boolean
}

export type SpeechEngineState = 'idle' | 'loading' | 'listening' | 'error'

export interface SpeechEngineEvents {
  result: SpeechResult
  state: { state: SpeechEngineState; message?: string }
  /** Model download progress 0..1 for engines that fetch weights. */
  progress: { loaded: number; total: number }
}

export interface SpeechEngine {
  readonly id: SpeechEngineId
  start(opts: { stream: MediaStream; lang: string; hints?: string[] }): Promise<void>
  stop(): Promise<void>
  /** Bias recognition toward the next stretch of script words, where the engine supports it. */
  setHints?(words: string[]): void
  on<K extends keyof SpeechEngineEvents>(event: K, cb: (payload: SpeechEngineEvents[K]) => void): () => void
}

/* ───────────────────────── Voice gate (Zig VAD) ───────────────────────── */

export interface VoiceSample {
  /** Smoothed loudness 0..1, perceptually scaled. */
  level: number
  /** Hysteresis-gated speech presence. */
  speaking: boolean
}

export interface VoiceGate {
  readonly current: VoiceSample
  /** Called at most ~30 times per second. Returns an unsubscribe function. */
  subscribe(cb: (s: VoiceSample) => void): () => void
  stop(): void
}

/* ───────────────────────── Device link (phone remote, talent display) ───────────────────────── */

export type PrompterMode = 'manual' | 'voice' | 'breath'

export interface PrompterSnapshot {
  playing: boolean
  /** User-facing speed on a 1..10 scale (fractional allowed). */
  speed: number
  /** 0..1 through the script. */
  progress: number
  elapsedMs: number
  remainingMs: number
  wpm: number
  mode: PrompterMode
  mirrorX: boolean
  mirrorY: boolean
  title: string
  /** The line currently on the reading line, for the remote's glance view. */
  currentLine: string
}

export type RemoteCommand =
  | { c: 'toggle' | 'play' | 'pause' | 'faster' | 'slower' | 'back' | 'forward' | 'top' | 'mirror' }
  | { c: 'speed'; v: number }
  | { c: 'seek'; v: number }
  | { c: 'nudge'; v: number }

export type LinkRole = 'host' | 'remote' | 'display'

export type LinkMessage =
  | ({ t: 'cmd' } & RemoteCommand)
  | { t: 'state'; s: PrompterSnapshot }
  | { t: 'hello'; role: LinkRole; name?: string }
  | { t: 'script'; title: string; text: string }
  | { t: 'bye' }

export type LinkStatus = 'idle' | 'connecting' | 'waiting' | 'p2p' | 'relay' | 'local' | 'closed' | 'error'

export interface Link {
  readonly status: LinkStatus
  send(msg: LinkMessage): void
  onMessage(cb: (msg: LinkMessage) => void): () => void
  onStatus(cb: (s: LinkStatus) => void): () => void
  close(): void
}
