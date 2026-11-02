import { describe, expect, it } from 'vitest'
import { buildCues, formatClock, rollingWpm, toSrt, toVtt } from './timing'

const words = 'Good evening. Welcome to the show tonight we have a lot to cover.'.split(' ')

describe('timing', () => {
  it('computes rolling wpm', () => {
    const stamps = Array.from({ length: 31 }, (_, i) => ({ wi: i, t: i * 400 })) // 150 wpm
    expect(rollingWpm(stamps, 12_000)).toBeCloseTo(150, 0)
  })

  it('builds cues that break on sentences and never overlap', () => {
    const stamps = words.map((_, i) => ({ wi: i, t: 1000 + i * 350 }))
    const cues = buildCues(words, stamps)
    expect(cues[0]!.text).toBe('Good evening.')
    for (let i = 1; i < cues.length; i++) expect(cues[i - 1]!.endMs).toBeLessThanOrEqual(cues[i]!.startMs)
    expect(cues.map((c) => c.text).join(' ')).toBe(words.join(' '))
  })

  it('ignores backwards stamps', () => {
    const cues = buildCues(words, [
      { wi: 0, t: 0 },
      { wi: 1, t: 300 },
      { wi: 0, t: 600 },
      { wi: 2, t: 900 },
    ])
    expect(cues.map((c) => c.text).join(' ')).toBe('Good evening. Welcome')
  })

  it('formats srt and vtt', () => {
    const cues = [{ startMs: 1500, endMs: 3_725_042, text: 'Hi' }]
    expect(toSrt(cues)).toContain('00:00:01,500 --> 01:02:05,042')
    expect(toVtt(cues)).toMatch(/^WEBVTT\n\n00:00:01\.500 --> 01:02:05\.042\nHi/)
    expect(formatClock(125_000)).toBe('02:05')
  })
})
