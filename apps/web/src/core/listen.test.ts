import { describe, expect, it } from 'vitest'
import { settledCursor } from './listen'

const r = (p: Partial<Parameters<typeof settledCursor>[0]>) => ({ cursor: -1, lead: -1, confidence: 1, state: 'tracking' as const, changed: true, ...p })

describe('settledCursor', () => {
  it('treats words two behind a confident lead as read', () => {
    expect(settledCursor(r({ cursor: 3, lead: 12 }))).toBe(10)
  })
  it('never goes behind the committed cursor', () => {
    expect(settledCursor(r({ cursor: 9, lead: 10 }))).toBe(9)
  })
  it('only trusts the aligner cursor when holding, lost, or unsure', () => {
    expect(settledCursor(r({ cursor: 3, lead: 12, state: 'holding' }))).toBe(3)
    expect(settledCursor(r({ cursor: 3, lead: 12, state: 'lost' }))).toBe(3)
    expect(settledCursor(r({ cursor: 3, lead: 12, confidence: 0.2 }))).toBe(3)
  })
})

import { SILENT_ENGINE_MS, shouldFallBack } from './listen'

describe('shouldFallBack', () => {
  it('gives up on a Chrome engine that hears speech but returns nothing', () => {
    expect(shouldFallBack('chrome-local', SILENT_ENGINE_MS, 0)).toBe(true)
  })
  it('waits for enough speech before deciding', () => {
    expect(shouldFallBack('chrome-local', SILENT_ENGINE_MS - 1, 0)).toBe(false)
  })
  it('keeps an engine that has returned anything at all', () => {
    expect(shouldFallBack('chrome-local', SILENT_ENGINE_MS * 5, 1)).toBe(false)
  })
  it('never falls back from Moonshine or the cloud engine', () => {
    expect(shouldFallBack('moonshine', SILENT_ENGINE_MS * 5, 0)).toBe(false)
    expect(shouldFallBack('cloud-web-speech', SILENT_ENGINE_MS * 5, 0)).toBe(false)
  })
})
