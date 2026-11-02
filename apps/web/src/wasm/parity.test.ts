// @vitest-environment node
/** The TypeScript fallback parser must agree with the Rust parser on every token. */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseScriptTS } from '../core/script'
import { SAMPLE_SCRIPT } from '../core/sample'

const wasmPath = fileURLToPath(new URL('./generated/aligner/aligner_bg.wasm', import.meta.url))
const built = existsSync(wasmPath)

const CASES = [
  SAMPLE_SCRIPT,
  '# Welcome\n\nGood evening, everyone \u2014 welcome to the 2026 showcase. [pause]\n\nThree ideas. 👩🏽‍💻 Let’s begin.',
  'one two\n# Mid heading\nthree four\n\n\n  five  [cue with spaces]six\n[broken\ncue] end',
  'Smart “quotes” and don’t stop… café naïve \u2014 北京 \u2014 ok',
  '',
  '   \n\n  ',
]

describe.skipIf(!built)('parser parity (TypeScript fallback vs Rust)', () => {
  it.each(CASES.map((c, i) => [i, c] as const))('case %i', async (_i, text) => {
    const { loadAligner } = await import('./aligner')
    const rust = (await loadAligner(readFileSync(wasmPath))).parseScript(text)
    const ts = parseScriptTS(text)
    expect(ts).toEqual(rust)
  })
})
