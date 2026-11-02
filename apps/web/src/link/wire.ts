/**
 * Wire framing shared by the data channel and the relay WebSocket.
 *
 * A LinkMessage normally travels as one JSON frame. Large ones (a script sent
 * to a talent display) are split into `chunk` frames so every frame stays well
 * under the relay's 16 KB limit and the data channel's portable message size.
 * Relay frames also carry `from` / `to` peer ids next to the payload fields;
 * `parseLinkMessage` drops them on the way in.
 */

import type { LinkMessage } from '../core/contracts'
import { MAX_SCRIPT_CHARS, decodeLinkMessage, parseLinkMessage } from './message'

/** Byte budget per frame (relay hard limit is 16 KiB). */
export const MAX_FRAME_BYTES = 14_000
const MAX_CHUNKS = 400
const CHUNK_TTL_MS = 30_000

const utf8 = new TextEncoder()
export const byteLength = (s: string) => utf8.encode(s).length

export interface ChunkFrame {
  t: 'chunk'
  /** Message id, unique per sender. */
  id: string
  i: number
  n: number
  d: string
}

let seq = 0
const nextId = () => `${Date.now().toString(36)}${(seq++).toString(36)}`

/**
 * Encodes a message into one or more frames, each at most `maxBytes` UTF-8 bytes.
 * `extra` fields (relay routing: `from`, `to`) are merged into every frame.
 */
export function toFrames(msg: LinkMessage, extra: Record<string, string> = {}, maxBytes = MAX_FRAME_BYTES): string[] {
  const whole = JSON.stringify({ ...msg, ...extra })
  if (byteLength(whole) <= maxBytes) return [whole]

  const body = JSON.stringify(msg)
  const id = nextId()
  // Start optimistic, then shrink until the worst piece fits (non-ASCII and
  // escaped characters can make a frame much larger than its slice).
  let size = Math.max(64, Math.floor(maxBytes / 2))
  for (;;) {
    const n = Math.ceil(body.length / size)
    const frames: string[] = []
    let fits = n <= MAX_CHUNKS
    for (let i = 0; fits && i < n; i++) {
      const frame = JSON.stringify({ t: 'chunk', id, i, n, d: body.slice(i * size, (i + 1) * size), ...extra })
      if (byteLength(frame) > maxBytes) fits = false
      else frames.push(frame)
    }
    if (fits) return frames
    if (n > MAX_CHUNKS || size <= 64) throw new Error('message too large to frame')
    size = Math.floor(size / 2)
  }
}

export function isChunkFrame(v: unknown): v is ChunkFrame {
  if (typeof v !== 'object' || v === null) return false
  const f = v as Record<string, unknown>
  return (
    f.t === 'chunk' &&
    typeof f.id === 'string' &&
    f.id.length <= 64 &&
    Number.isInteger(f.i) &&
    Number.isInteger(f.n) &&
    (f.n as number) > 0 &&
    (f.n as number) <= MAX_CHUNKS &&
    (f.i as number) >= 0 &&
    (f.i as number) < (f.n as number) &&
    typeof f.d === 'string'
  )
}

interface Pending {
  parts: (string | undefined)[]
  got: number
  chars: number
  at: number
}

/** Collects chunk frames per sender and yields the message once complete. */
export class Reassembler {
  private pending = new Map<string, Pending>()

  constructor(private now: () => number = Date.now) {}

  /**
   * Feeds one decoded frame object. Returns a validated LinkMessage when a
   * plain frame arrives or a chunked message completes, otherwise null.
   */
  accept(frame: unknown, sender = ''): LinkMessage | null {
    if (!isChunkFrame(frame)) return parseLinkMessage(frame)
    this.gc()
    const key = `${sender}\u0000${frame.id}`
    let p = this.pending.get(key)
    if (!p) {
      if (this.pending.size >= 16) return null
      p = { parts: new Array(frame.n), got: 0, chars: 0, at: this.now() }
      this.pending.set(key, p)
    }
    if (p.parts.length !== frame.n || p.parts[frame.i] !== undefined) return null
    p.parts[frame.i] = frame.d
    p.got++
    p.chars += frame.d.length
    if (p.chars > MAX_SCRIPT_CHARS + 10_000) {
      this.pending.delete(key)
      return null
    }
    if (p.got < frame.n) return null
    this.pending.delete(key)
    return decodeLinkMessage(p.parts.join(''))
  }

  private gc() {
    const cutoff = this.now() - CHUNK_TTL_MS
    for (const [k, p] of this.pending) if (p.at < cutoff) this.pending.delete(k)
  }
}
