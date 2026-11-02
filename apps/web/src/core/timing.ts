/**
 * Run timing: words-per-minute, time remaining, and caption export.
 * During a voice-follow run we log when each word was committed. That log is
 * enough to produce SRT/VTT captions you can drop straight into an editor.
 */

export interface WordStamp {
  wi: number
  /** ms since the run started */
  t: number
}

export function estimateRemainingMs(wordsLeft: number, wpm: number): number {
  if (wpm <= 0) return 0
  return (wordsLeft / wpm) * 60_000
}

/** Rolling WPM over the last `windowMs` of stamps. */
export function rollingWpm(stamps: readonly WordStamp[], nowMs: number, windowMs = 15_000): number {
  if (stamps.length < 2) return 0
  const from = nowMs - windowMs
  let first = -1
  for (let i = stamps.length - 1; i >= 0; i--) {
    if (stamps[i]!.t < from) break
    first = i
  }
  if (first < 0 || first >= stamps.length - 1) return 0
  const a = stamps[first]!
  const b = stamps[stamps.length - 1]!
  const minutes = (b.t - a.t) / 60_000
  if (minutes <= 0) return 0
  return Math.max(0, (b.wi - a.wi) / minutes)
}

export interface Cue {
  startMs: number
  endMs: number
  text: string
}

/**
 * Group stamped words into caption cues: break on sentence ends, on pauses
 * longer than `gapMs`, or when a cue would exceed `maxWords` / `maxMs`.
 */
export function buildCues(
  words: readonly string[],
  stamps: readonly WordStamp[],
  opts: { maxWords?: number; maxMs?: number; gapMs?: number; tailMs?: number } = {},
): Cue[] {
  const { maxWords = 8, maxMs = 4000, gapMs = 900, tailMs = 400 } = opts
  // Keep one stamp per word index, monotonic.
  const clean: WordStamp[] = []
  for (const s of stamps) {
    const last = clean.at(-1)
    if (last && s.wi <= last.wi) continue
    clean.push(s)
  }
  const cues: Cue[] = []
  let cur: { start: number; last: number; words: string[] } | null = null
  const flush = (end: number) => {
    if (cur && cur.words.length) cues.push({ startMs: cur.start, endMs: Math.max(end, cur.start + 300), text: cur.words.join(' ') })
    cur = null
  }
  for (let i = 0; i < clean.length; i++) {
    const s = clean[i]!
    const word = words[s.wi]
    if (word === undefined) continue
    if (cur && (s.t - cur.last > gapMs || cur.words.length >= maxWords || s.t - cur.start > maxMs)) flush(cur.last + tailMs)
    if (!cur) cur = { start: s.t, last: s.t, words: [] }
    cur.words.push(word)
    cur.last = s.t
    if (/[.!?…]["”’)]?$/.test(word)) {
      const next = clean[i + 1]
      flush(next ? Math.min(next.t, s.t + tailMs * 2) : s.t + tailMs * 2)
    }
  }
  if (cur) flush((cur as { last: number }).last + tailMs * 2)
  // No overlaps.
  for (let i = 1; i < cues.length; i++) if (cues[i - 1]!.endMs > cues[i]!.startMs) cues[i - 1]!.endMs = cues[i]!.startMs
  return cues
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
function stamp(ms: number, sep: ',' | '.') {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(Math.floor(ms % 1000), 3)}`
}

export function toSrt(cues: readonly Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.startMs, ',')} --> ${stamp(c.endMs, ',')}\n${c.text}\n`).join('\n')
}

export function toVtt(cues: readonly Cue[]): string {
  return 'WEBVTT\n\n' + cues.map((c) => `${stamp(c.startMs, '.')} --> ${stamp(c.endMs, '.')}\n${c.text}\n`).join('\n')
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${pad(m)}:${pad(s)}`
}
