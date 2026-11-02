import { describe, expect, it } from 'vitest'
import type { LinkMessage, PrompterSnapshot } from '../core/contracts'
import { decodeLinkMessage, encodeLinkMessage, parseLinkMessage } from './message'
import { MAX_FRAME_BYTES, Reassembler, byteLength, toFrames } from './wire'

const snap: PrompterSnapshot = {
  playing: true,
  speed: 4.5,
  progress: 0.42,
  elapsedMs: 61_000,
  remainingMs: 84_000,
  wpm: 148,
  mode: 'voice',
  mirrorX: false,
  mirrorY: false,
  title: 'Keynote',
  currentLine: 'and that is why we built it',
}

describe('parseLinkMessage', () => {
  const valid: LinkMessage[] = [
    { t: 'cmd', c: 'toggle' },
    { t: 'cmd', c: 'mirror' },
    { t: 'cmd', c: 'speed', v: 6 },
    { t: 'cmd', c: 'seek', v: 0.5 },
    { t: 'cmd', c: 'nudge', v: -3 },
    { t: 'state', s: snap },
    { t: 'hello', role: 'remote' },
    { t: 'hello', role: 'display', name: 'Studio iPad' },
    { t: 'script', title: 'Pilot', text: '# Intro\nHello [pause] world' },
    { t: 'bye' },
  ]

  it.each(valid)('accepts %j', (msg) => {
    expect(parseLinkMessage(msg)).toEqual(msg)
    expect(decodeLinkMessage(encodeLinkMessage(msg))).toEqual(msg)
  })

  const invalid: unknown[] = [
    null,
    undefined,
    42,
    'cmd',
    [],
    {},
    { t: 'nope' },
    { t: 'cmd' },
    { t: 'cmd', c: 'explode' },
    { t: 'cmd', c: 'speed' },
    { t: 'cmd', c: 'speed', v: '6' },
    { t: 'cmd', c: 'seek', v: Number.NaN },
    { t: 'cmd', c: 'nudge', v: Number.POSITIVE_INFINITY },
    { t: 'state' },
    { t: 'state', s: { ...snap, playing: 'yes' } },
    { t: 'state', s: { ...snap, mode: 'turbo' } },
    { t: 'state', s: { ...snap, speed: null } },
    { t: 'state', s: { ...snap, title: 7 } },
    { t: 'hello', role: 'admin' },
    { t: 'hello', role: 'remote', name: 5 },
    { t: 'script', title: 'x' },
    { t: 'script', title: 'x', text: 'y'.repeat(1_000_001) },
  ]

  it.each(invalid)('rejects %j', (v) => {
    expect(parseLinkMessage(v)).toBeNull()
  })

  it('strips unknown fields such as relay routing ids', () => {
    expect(parseLinkMessage({ t: 'cmd', c: 'play', from: 'abcd', to: 'efgh', evil: true })).toEqual({ t: 'cmd', c: 'play' })
    const out = parseLinkMessage({ t: 'state', s: { ...snap, extra: 'x' }, from: 'abcd' })
    expect(out).toEqual({ t: 'state', s: snap })
  })

  it('clamps progress and times into range', () => {
    const out = parseLinkMessage({ t: 'state', s: { ...snap, progress: 1.4, remainingMs: -5 } })
    expect(out).toMatchObject({ s: { progress: 1, remainingMs: 0 } })
  })

  it('returns null for bad JSON', () => {
    expect(decodeLinkMessage('{"t":')).toBeNull()
  })
})

describe('wire framing', () => {
  it('sends small messages as one frame with routing fields', () => {
    const frames = toFrames({ t: 'cmd', c: 'play' }, { from: 'me', to: 'you' })
    expect(frames).toEqual(['{"t":"cmd","c":"play","from":"me","to":"you"}'])
  })

  const scripts = {
    ascii: 'The quick brown fox. '.repeat(4000),
    japanese: '吾輩は猫である。名前はまだ無い。'.repeat(3000),
    emoji: '🎬🎤 take two! '.repeat(4000),
    escapes: '"quoted"\n\t\\ and \u0001 control '.repeat(3000),
  }

  it.each(Object.entries(scripts))('chunks and reassembles a large %s script under the frame budget', (_, text) => {
    const msg: LinkMessage = { t: 'script', title: 'Big', text }
    const frames = toFrames(msg, { from: 'host1234' })
    expect(frames.length).toBeGreaterThan(1)
    for (const f of frames) expect(byteLength(f)).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    const r = new Reassembler()
    // Out of order delivery still works.
    const shuffled = [...frames].reverse()
    let out: LinkMessage | null = null
    for (const f of shuffled) out = r.accept(JSON.parse(f), 'host1234') ?? out
    expect(out).toEqual(msg)
  })

  it('ignores duplicate, malformed and foreign chunks', () => {
    const msg: LinkMessage = { t: 'script', title: 'T', text: 'x'.repeat(40_000) }
    const frames = toFrames(msg).map((f) => JSON.parse(f))
    const r = new Reassembler()
    expect(r.accept(frames[0], 'a')).toBeNull()
    expect(r.accept(frames[0], 'a')).toBeNull() // duplicate
    expect(r.accept({ ...frames[1], i: 99 }, 'a')).toBeNull() // out of range
    expect(r.accept({ ...frames[1], n: 0 }, 'a')).toBeNull()
    // A different sender cannot complete someone else's message.
    for (const f of frames.slice(1)) expect(r.accept(f, 'b')).toBeNull()
    let out: LinkMessage | null = null
    for (const f of frames.slice(1)) out = r.accept(f, 'a') ?? out
    expect(out).toEqual(msg)
  })

  it('drops stale partial messages', () => {
    let now = 0
    const r = new Reassembler(() => now)
    const frames = toFrames({ t: 'script', title: 'T', text: 'y'.repeat(30_000) }).map((f) => JSON.parse(f))
    r.accept(frames[0], 'a')
    now = 31_000
    let out: LinkMessage | null = null
    for (const f of frames.slice(1)) out = r.accept(f, 'a') ?? out
    expect(out).toBeNull()
  })
})
