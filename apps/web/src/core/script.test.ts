import { describe, expect, it } from 'vitest'
import { parseScriptTS, spokenWords } from './script'

const src = `# Act one

Good evening. [pause] Welcome — to the 2026 show.
Second line, same paragraph.

Final 🎤 thought.`

describe('parseScriptTS rules shared with the Rust parser', () => {
  it('makes a # line inside a paragraph its own heading', () => {
    const p = parseScriptTS('one two\n# Mid\nthree four')
    expect(p.blocks.map((b) => b.kind)).toEqual(['para', 'heading', 'para'])
    expect(p.wordCount).toBe(4)
  })
  it('gives bare punctuation and emoji no word index', () => {
    const p = parseScriptTS('wait — 🎤 go')
    expect(p.blocks[0]!.tokens.map((t) => t.wi)).toEqual([0, -1, -1, 1])
  })
  it('keeps an unclosed bracket inside its word, and cues stop at line breaks', () => {
    const p = parseScriptTS('a[b c\n[not\nclosed] d')
    expect(p.blocks[0]!.tokens.every((t) => t.kind === 'word')).toBe(true)
    expect(p.blocks[0]!.tokens[0]!.text).toBe('a[b')
  })
})

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
