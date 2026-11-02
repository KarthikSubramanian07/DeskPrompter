import { describe, expect, it } from 'vitest'
import { cleanMarkdown, titleFromFilename } from './importScript'

describe('importScript', () => {
  it('turns a filename into a title', () => {
    expect(titleFromFilename('keynote_final-v2.md')).toBe('Keynote final v2')
    expect(titleFromFilename('.md')).toBe('Untitled')
  })
  it('keeps sections, paragraphs and cues from Markdown', () => {
    const md = '## Opening\n\nHello **there**, read [the docs](https://x.y) and *smile*. [pause]\n\n- one point\n- `two` points\n\n---\n\n> quoted line'
    expect(cleanMarkdown(md)).toBe('# Opening\n\nHello there, read the docs and smile. [pause]\n\none point\ntwo points\n\nquoted line')
  })
})
