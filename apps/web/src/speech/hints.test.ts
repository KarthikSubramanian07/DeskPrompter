import { describe, expect, it } from 'vitest'
import { cleanWord, hintBoost, pickHintWords, rankHints } from './hints'

const script = 'Good evening, and welcome to DeskPrompter. Tonight we talk about Kubernetes, the NASA budget, and the art of speaking clearly to a camera.'.split(' ')

describe('cleanWord', () => {
  it('strips surrounding punctuation but keeps inner apostrophes and hyphens', () => {
    expect(cleanWord('“Kubernetes,”')).toBe('Kubernetes')
    expect(cleanWord('don’t')).toBe("don't")
    expect(cleanWord('(on-device).')).toBe('on-device')
    expect(cleanWord('—')).toBe('')
  })
})

describe('rankHints', () => {
  it('drops stopwords and dedupes case-insensitively, keeping the first spelling', () => {
    const texts = rankHints(['The', 'Camera', 'the', 'camera', 'and', 'of']).map((h) => h.text)
    expect(texts).toEqual(['Camera'])
  })

  it('ranks names, acronyms and long words above everyday words', () => {
    const texts = rankHints(script).map((h) => h.text)
    const at = (w: string) => texts.indexOf(w)
    for (const rare of ['DeskPrompter', 'Kubernetes', 'NASA']) {
      expect(at(rare)).toBeGreaterThanOrEqual(0)
      expect(at(rare)).toBeLessThan(at('evening'))
      expect(at(rare)).toBeLessThan(at('talk'))
    }
    expect(texts).not.toContain('and')
    expect(texts).not.toContain('to')
  })

  it('does not treat a sentence-initial capital as a proper noun', () => {
    const [a] = rankHints(['Tonight'], { prev: 'show.' })
    const [b] = rankHints(['Tonight'], { prev: 'show' })
    expect(b!.weight).toBeGreaterThan(a!.weight)
  })

  it('caps the list and keeps weights in 0..1', () => {
    const ranked = rankHints(script, { max: 5 })
    expect(ranked).toHaveLength(5)
    for (const h of ranked) expect(h.weight).toBeGreaterThanOrEqual(0), expect(h.weight).toBeLessThanOrEqual(1)
  })

  it('is stable on its own output', () => {
    const once = rankHints(script).map((h) => h.text)
    const twice = rankHints(once).map((h) => h.text)
    expect(new Set(twice)).toEqual(new Set(once))
  })
})

describe('pickHintWords', () => {
  it('looks only at the window after the cursor', () => {
    const words = pickHintWords(script, 6, { window: 4 }) // "we talk about Kubernetes,"
    expect(words).toContain('Kubernetes')
    expect(words).not.toContain('DeskPrompter')
    expect(words).not.toContain('NASA')
  })

  it('starts at the top before anything is spoken', () => {
    expect(pickHintWords(script, -1, { window: 6 })).toContain('DeskPrompter')
  })

  it('returns nothing past the end of the script', () => {
    expect(pickHintWords(script, script.length - 1)).toEqual([])
  })
})

describe('hintBoost', () => {
  it('maps weight onto the boost range, clamped', () => {
    expect(hintBoost(0)).toBe(1)
    expect(hintBoost(1)).toBe(5)
    expect(hintBoost(0.5)).toBe(3)
    expect(hintBoost(7)).toBe(5)
  })
})
