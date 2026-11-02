// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dir = fileURLToPath(new URL('./generated/aligner/', import.meta.url))
const wasmPath = `${dir}aligner_bg.wasm`
const built = existsSync(wasmPath)

if (!built) {
  console.warn(`[aligner.test] skipped: ${wasmPath} not found. Run \`bun run build:wasm\` from the repo root first.`)
}

const SCRIPT = `# Welcome

Good evening, everyone \u2014 welcome to the 2026 showcase. [pause]

Tonight I want to walk you through three ideas. 👩🏽‍💻 Let’s begin.`

async function load() {
  const { loadAligner } = await import('./aligner')
  return loadAligner(readFileSync(wasmPath))
}

describe.skipIf(!built)('aligner wasm', () => {
  it('parses with UTF-16 offsets that match String.slice', async () => {
    const { parseScript } = await load()
    const parsed = parseScript(SCRIPT)
    expect(parsed.blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'para'])
    expect(parsed.wordCount).toBe(19)
    for (const block of parsed.blocks) {
      for (const t of block.tokens) expect(SCRIPT.slice(t.start, t.end)).toBe(t.text)
    }
    const cue = parsed.blocks[1]!.tokens.find((t) => t.kind === 'cue')
    expect(cue).toMatchObject({ text: '[pause]', wi: -1 })
    expect(parsed.blocks[0]!.tokens[0]).toMatchObject({ kind: 'word', text: 'Welcome', wi: -1 })
  })

  it('follows a read-through: interims move lead, finals commit cursor', async () => {
    const { createAligner } = await load()
    const aligner = createAligner(SCRIPT)
    expect(aligner.wordCount).toBe(19)

    let r = aligner.feed('good evening everyone', false)
    expect(r).toMatchObject({ cursor: -1, lead: 2, state: 'tracking', changed: true })
    r = aligner.feed('good evening everyone welcome to the 2026 showcase', true)
    expect(r).toMatchObject({ cursor: 7, lead: 7 })
    expect(r.confidence).toBeGreaterThan(0.5)

    r = aligner.feed('tonight I want to walk you through', false)
    expect(r.cursor).toBe(7)
    expect(r.lead).toBe(14)
    r = aligner.feed('tonight I want to walk you through three ideas', true)
    expect(r.cursor).toBe(16)

    // Off-script: nothing moves.
    r = aligner.feed('sorry my cat just walked across the keyboard', true)
    expect(r).toMatchObject({ cursor: 16, lead: 16, state: 'holding', changed: false })

    aligner.setCursor(0)
    r = aligner.feed('evening everyone welcome', true)
    expect(r.cursor).toBe(3)
    aligner.dispose()
    expect(() => aligner.feed('x', true)).toThrow(/dispose/)
  })

  it('shares one initialized module', async () => {
    const a = await load()
    const b = await load()
    expect(a).toBe(b)
  })
})
