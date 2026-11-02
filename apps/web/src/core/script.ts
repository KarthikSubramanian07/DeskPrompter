/**
 * Script parsing. The canonical parser lives in Rust (crates/aligner) so the
 * tracker and the renderer agree on every word index. This TypeScript twin is
 * the fallback for manual mode if WebAssembly can't load, and follows the
 * same rules:
 *   - blocks are separated by blank lines
 *   - a block whose first line starts with `#` is a heading (rendered, never tracked)
 *   - `[bracketed text]` is a cue token (rendered, never tracked)
 *   - every other whitespace-separated run is a spoken word with a word index
 */
import type { ParsedScript, ScriptBlock, ScriptToken } from './contracts'

export function parseScriptTS(text: string): ParsedScript {
  const blocks: ScriptBlock[] = []
  let wi = 0
  const blockRe = /\S[\s\S]*?(?=\n[ \t]*\n|\s*$)/g
  for (const m of text.matchAll(blockRe)) {
    const start = m.index ?? 0
    const raw = m[0]
    const end = start + raw.length
    const heading = raw.startsWith('#')
    const tokens: ScriptToken[] = []
    // Skip the leading #'s of a heading.
    const bodyOffset = heading ? raw.match(/^#+\s*/)![0].length : 0
    const body = raw.slice(bodyOffset)
    for (const t of body.matchAll(/\[[^\]\n]*\]|[^\s[]+|\[/g)) {
      const s = start + bodyOffset + (t.index ?? 0)
      const value = t[0]
      const isCue = value.startsWith('[') && value.endsWith(']') && value.length > 1
      tokens.push({
        kind: isCue ? 'cue' : 'word',
        text: value,
        start: s,
        end: s + value.length,
        wi: isCue || heading ? -1 : wi++,
      })
    }
    blocks.push({ kind: heading ? 'heading' : 'para', start, end, tokens })
  }
  return { blocks, wordCount: wi }
}

/** Flat list of spoken words in order, for hints and the remote's glance line. */
export function spokenWords(parsed: ParsedScript): string[] {
  const out: string[] = []
  for (const b of parsed.blocks) for (const t of b.tokens) if (t.wi >= 0) out[t.wi] = t.text
  return out
}
