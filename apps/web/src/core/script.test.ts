import { describe, expect, it } from 'vitest'
import { parseScriptTS, spokenWords } from './script'

const src = `# Act one

Good evening. [pause] Welcome — to the 2026 show.
Second line, same paragraph.

Final 🎤 thought.`

describe('parseScriptTS', () => {
  const p = parseScriptTS(src)
  it('splits blocks and kinds', () => {
    expect(p.blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'para'])
  })
  it('keeps exact UTF-16 offsets', () => {
    for (const b of p.blocks) for (const t of b.tokens) expect(src.slice(t.start, t.end)).toBe(t.text)
  })
  it('never tracks headings or cues', () => {
    const cue = p.blocks[1]!.tokens.find((t) => t.kind === 'cue')!
    expect(cue.text).toBe('[pause]')
    expect(cue.wi).toBe(-1)
    expect(p.blocks[0]!.tokens.every((t) => t.wi === -1)).toBe(true)
  })
  it('numbers spoken words densely', () => {
    const words = spokenWords(p)
    expect(words[0]).toBe('Good')
    expect(words.at(-1)).toBe('thought.')
    expect(words.length).toBe(p.wordCount)
  })
})
