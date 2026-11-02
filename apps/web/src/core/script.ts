/**
 * Script parsing. The canonical parser is Rust (crates/aligner/src/parse.rs),
 * so the tracker and the renderer agree on every word index. This TypeScript
 * twin follows the same rules and is used until the wasm loads, or if it can't:
 *   - blank lines separate blocks
 *   - a line whose first non-space character is `#` is a heading block on its own
 *   - `[bracketed text]` on one line is a cue token (shown, never tracked)
 *   - words split on whitespace and keep their punctuation; only words with
 *     letters or digits, in paragraphs, get a word index
 */
import type { ParsedScript, ScriptBlock, ScriptToken } from './contracts'

const SPEAKABLE = /[\p{L}\p{N}]/u

type LineKind = 'blank' | 'heading' | 'text'

function cueEnd(text: string, p: number, to: number): number {
  const close = text.indexOf(']', p)
  if (close < 0 || close >= to) return -1
  return text.slice(p, close).includes('\n') ? -1 : close + 1
}

function tokenize(text: string, from: number, to: number, spoken: boolean, next: { wi: number }): ScriptToken[] {
  const tokens: ScriptToken[] = []
  let p = from
  while (p < to) {
    const c = text[p]!
    if (/\s/.test(c)) {
      p++
      continue
    }
    if (c === '[') {
      const end = cueEnd(text, p, to)
      if (end > 0) {
        tokens.push({ kind: 'cue', text: text.slice(p, end), start: p, end, wi: -1 })
        p = end
        continue
      }
    }
    let q = p
    while (q < to) {
      const ch = text[q]!
      if (/\s/.test(ch)) break
      if (ch === '[' && q > p && cueEnd(text, q, to) > 0) break
      q++
    }
    const word = text.slice(p, q)
    tokens.push({ kind: 'word', text: word, start: p, end: q, wi: spoken && SPEAKABLE.test(word) ? next.wi++ : -1 })
    p = q
  }
  return tokens
}

export function parseScriptTS(text: string): ParsedScript {
  const lines: { a: number; b: number; kind: LineKind }[] = []
  let ls = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      const t = text.slice(ls, i).trim()
      lines.push({ a: ls, b: i, kind: t === '' ? 'blank' : t.startsWith('#') ? 'heading' : 'text' })
      ls = i + 1
    }
  }
  const blocks: ScriptBlock[] = []
  const next = { wi: 0 }
  const lead = (a: number, b: number) => a + (text.slice(a, b).length - text.slice(a, b).trimStart().length)
  const trail = (a: number, b: number) => a + text.slice(a, b).trimEnd().length
  for (let i = 0; i < lines.length; ) {
    const l = lines[i]!
    if (l.kind === 'blank') {
      i++
    } else if (l.kind === 'heading') {
      const hashStart = lead(l.a, l.b)
      let afterHashes = hashStart
      while (text[afterHashes] === '#') afterHashes++
      const end = trail(l.a, l.b)
      blocks.push({ kind: 'heading', start: hashStart, end, tokens: tokenize(text, afterHashes, end, false, next) })
      i++
    } else {
      let j = i
      while (j + 1 < lines.length && lines[j + 1]!.kind === 'text') j++
      const start = lead(l.a, l.b)
      const end = trail(lines[j]!.a, lines[j]!.b)
      blocks.push({ kind: 'para', start, end, tokens: tokenize(text, start, end, true, next) })
      i = j + 1
    }
  }
  return { blocks, wordCount: next.wi }
}

/** Flat list of spoken words in order, for hints and the remote's glance line. */
export function spokenWords(parsed: ParsedScript): string[] {
  const out: string[] = []
  for (const b of parsed.blocks) for (const t of b.tokens) if (t.wi >= 0) out[t.wi] = t.text
  return out
}
