import { describe, expect, it } from 'vitest'
import { MODE_COPY, MODE_ORDER, micLabel, spacingLabel, widthLabel } from './modes'

describe('mode copy', () => {
  it('covers every mode once, simplest first', () => {
    expect(MODE_ORDER).toEqual(['manual', 'voice', 'breath'])
    expect(new Set(MODE_ORDER).size).toBe(Object.keys(MODE_COPY).length)
  })
  it('says which modes need the microphone', () => {
    expect(MODE_COPY.manual.needsMic).toBe(false)
    expect(MODE_COPY.voice.needsMic).toBe(true)
    expect(MODE_COPY.breath.needsMic).toBe(true)
  })
  it('keeps labels short enough for a three-way switch', () => {
    for (const m of MODE_ORDER) expect(MODE_COPY[m].label.length).toBeLessThanOrEqual(14)
  })
})

describe('plain setting labels', () => {
  it('describes line width, spacing and mic sensitivity in words', () => {
    expect([widthLabel(16), widthLabel(26), widthLabel(40)]).toEqual(['Narrow', 'Medium', 'Wide'])
    expect([spacingLabel(1.1), spacingLabel(1.32), spacingLabel(1.7)]).toEqual(['Tight', 'Normal', 'Loose'])
    expect([micLabel(10), micLabel(50), micLabel(90)]).toEqual(['Loud voices only', 'Normal', 'Picks up quiet voices'])
  })
})
