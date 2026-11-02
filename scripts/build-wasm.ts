#!/usr/bin/env bun
/**
 * Builds the native cores into the web app:
 *   crates/aligner (Rust) → apps/web/src/wasm/generated/aligner/  (wasm-pack, --target web)
 *   zig/vad        (Zig)  → apps/web/src/wasm/generated/vad.wasm
 */
import { $ } from 'bun'
import { existsSync, mkdirSync } from 'node:fs'

const out = 'apps/web/src/wasm/generated'
mkdirSync(out, { recursive: true })

if (existsSync('crates/aligner/Cargo.toml')) {
  console.log('▸ aligner (rust → wasm)')
  await $`wasm-pack build crates/aligner --release --target web --out-dir ../../${out}/aligner --out-name aligner --no-pack`
}

if (existsSync('zig/vad/build.zig')) {
  console.log('▸ vad (zig → wasm)')
  await $`zig build -Doptimize=ReleaseSmall --prefix ../../${out}/vad-out`.cwd('zig/vad')
  await $`cp ${out}/vad-out/bin/vad.wasm ${out}/vad.wasm`
}
