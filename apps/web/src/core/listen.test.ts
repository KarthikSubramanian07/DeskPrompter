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
