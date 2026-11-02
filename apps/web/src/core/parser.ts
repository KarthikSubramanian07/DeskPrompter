/**
 * One parser for the whole app. Starts with the TypeScript twin, then swaps in
 * the Rust/wasm parser as soon as it loads so word indices match the aligner.
 */
import { signal } from '@preact/signals'
import type { ParsedScript } from './contracts'
import { parseScriptTS } from './script'
import type { AlignerModule } from '../wasm/aligner'

export const aligner = signal<AlignerModule | null>(null)
export const alignerError = signal<string | null>(null)

let loading: Promise<AlignerModule | null> | null = null
export function loadAlignerOnce(): Promise<AlignerModule | null> {
  loading ??= import('../wasm/aligner')
    .then((m) => m.loadAligner())
    .then((m) => (aligner.value = m))
    .catch((e: unknown) => {
      alignerError.value = e instanceof Error ? e.message : String(e)
      console.warn('[parser] wasm aligner unavailable, using the TypeScript parser', e)
      return null
    })
  return loading
}

export function parseScript(text: string): ParsedScript {
  const m = aligner.value
  if (m) {
    try {
      return m.parseScript(text)
    } catch (e) {
      console.warn('[parser] wasm parse failed', e)
    }
  }
  return parseScriptTS(text)
}
