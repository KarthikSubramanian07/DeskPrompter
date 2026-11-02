import { describe, expect, it } from 'vitest'
import type { EngineAvailability, SpeechEngineId } from '../core/contracts'
import { LineTracker } from './moonshine'
import { MODEL_CACHE, RUNTIME_CACHE, probeMoonshine, readyMarkerUrl } from './moonshineSupport'
import { chooseEngine, createEngine, engineInfo, listEngines } from './registry'
import type { SpeechResult } from '../core/contracts'

const engines = (s: Partial<Record<SpeechEngineId, EngineAvailability>>) =>
  (['chrome-local', 'moonshine', 'cloud-web-speech'] as const).map((id) => engineInfo(id, s[id] ?? 'unavailable'))

describe('chooseEngine', () => {
  it('prefers Chrome on-device when it is ready', () => {
    expect(chooseEngine(engines({ 'chrome-local': 'available', moonshine: 'available', 'cloud-web-speech': 'available' }), { allowCloud: true })).toBe('chrome-local')
  })

  it('falls back to Moonshine', () => {
    expect(chooseEngine(engines({ moonshine: 'downloadable', 'cloud-web-speech': 'available' }), { allowCloud: false })).toBe('moonshine')
  })

  it('takes a cached Moonshine over a Chrome model that still needs install()', () => {
    expect(chooseEngine(engines({ 'chrome-local': 'downloadable', moonshine: 'available' }), { allowCloud: false })).toBe('moonshine')
  })

  it('takes Chrome install() over a first-time Moonshine download', () => {
    expect(chooseEngine(engines({ 'chrome-local': 'downloadable', moonshine: 'downloadable' }), { allowCloud: false })).toBe('chrome-local')
  })

  it('never picks cloud without opt-in', () => {
    expect(chooseEngine(engines({ 'cloud-web-speech': 'available' }), { allowCloud: false })).toBeNull()
    expect(chooseEngine(engines({ 'cloud-web-speech': 'available' }), { allowCloud: true })).toBe('cloud-web-speech')
  })
})

describe('engineInfo', () => {
  it('marks only cloud as non-local, and says so in its note', () => {
    const all = engines({ 'chrome-local': 'available', moonshine: 'available', 'cloud-web-speech': 'available' })
    expect(all.map((e) => e.local)).toEqual([true, true, false])
    expect(all[2]!.note).toMatch(/sends your audio to your browser maker’s servers/i)
    for (const e of all) expect(e.note.split(/[.!?](\s|$)/).filter((s) => s && s.trim()).length).toBe(1)
  })
})

describe('listEngines', () => {
  it('probes every engine without touching the network', async () => {
    const g = { navigator: { userAgent: 'test' }, crossOriginIsolated: false } as unknown as typeof globalThis
    const list = await listEngines({ lang: 'en-US', global: g, env: { android: false, now: () => 0 } })
    expect(list.map((e) => [e.id, e.availability])).toEqual([
      ['chrome-local', 'unavailable'],
      ['moonshine', 'unavailable'],
      ['cloud-web-speech', 'unavailable'],
    ])
  })
})

describe('createEngine', () => {
  it('builds Web Speech engines synchronously-cheap and Moonshine from its lazy module', async () => {
    expect((await createEngine('chrome-local')).id).toBe('chrome-local')
    expect((await createEngine('cloud-web-speech')).id).toBe('cloud-web-speech')
    expect((await createEngine('moonshine')).id).toBe('moonshine')
  })
})

/* ───────────── Moonshine pieces that don't need WebAssembly ───────────── */

function fakeCaches(entries: Record<string, Record<string, unknown>>) {
  return {
    open: async (name: string) => ({
      match: async (url: string) => {
        const v = entries[name]?.[url]
        return v === undefined ? undefined : { json: async () => v }
      },
    }),
  }
}

describe('probeMoonshine', () => {
  const isolated = (caches?: unknown) =>
    ({
      crossOriginIsolated: true,
      SharedArrayBuffer,
      WebAssembly,
      Worker: function () {},
      AudioWorkletNode: function () {},
      caches,
    }) as unknown as typeof globalThis

  it('is unavailable without cross-origin isolation', async () => {
    expect(await probeMoonshine('en-US', { ...isolated(), crossOriginIsolated: false } as typeof globalThis)).toBe('unavailable')
  })

  it('is unavailable for languages without a streaming model', async () => {
    expect(await probeMoonshine('ko-KR', isolated(fakeCaches({})))).toBe('unavailable')
  })

  it('is downloadable until every model file and the runtime are cached', async () => {
    const marker = { files: ['https://cdn/a.ort', 'https://cdn/b.ort'], wasm: 'https://app/m.wasm' }
    const partial = fakeCaches({
      [RUNTIME_CACHE]: { [readyMarkerUrl('en')]: marker, 'https://app/m.wasm': {} },
      [MODEL_CACHE]: { 'https://cdn/a.ort': {} },
    })
    expect(await probeMoonshine('en-US', isolated(partial))).toBe('downloadable')
    const full = fakeCaches({
      [RUNTIME_CACHE]: { [readyMarkerUrl('en')]: marker, 'https://app/m.wasm': {} },
      [MODEL_CACHE]: { 'https://cdn/a.ort': {}, 'https://cdn/b.ort': {} },
    })
    expect(await probeMoonshine('en-US', isolated(full))).toBe('available')
  })
})

describe('LineTracker', () => {
  const track = () => {
    const out: SpeechResult[] = []
    return { out, t: new LineTracker((r) => out.push(r)) }
  }

  it('maps line text to interims and completion to one final', () => {
    const { out, t } = track()
    t.update('1', 'The')
    t.update('1', 'The quick')
    t.update('1', ' The  quick ')
    t.complete('1', 'The quick brown fox.')
    t.complete('1', 'The quick brown fox.')
    t.update('1', 'late text for a finished line')
    expect(out).toEqual([
      { text: 'The', isFinal: false },
      { text: 'The quick', isFinal: false },
      { text: 'The quick brown fox.', isFinal: true },
    ])
  })

  it('closes a line that never completed when the next one starts', () => {
    const { out, t } = track()
    t.update('1', 'hello there')
    t.update('2', 'and welcome')
    t.complete('2', '')
    expect(out).toEqual([
      { text: 'hello there', isFinal: false },
      { text: 'hello there', isFinal: true },
      { text: 'and welcome', isFinal: false },
      { text: 'and welcome', isFinal: true },
    ])
  })

  it('flushes the open line on stop and ignores empty lines', () => {
    const { out, t } = track()
    t.update('1', '')
    t.complete('1', '')
    t.update('2', 'tonight')
    t.flush()
    expect(out).toEqual([
      { text: 'tonight', isFinal: false },
      { text: 'tonight', isFinal: true },
    ])
  })
})
