<div align="center">

<img src="apps/web/public/icon-192.png" width="72" alt="DeskPrompter seal" />

# DeskPrompter

**A teleprompter that listens.** It scrolls when you speak, waits when you pause, and finds you again when you skip a line. It runs in your browser, works offline, and never sends your words anywhere.

[**deskprompter.pages.dev**](https://deskprompter.pages.dev) · [Open the studio](https://deskprompter.pages.dev/studio)

`teleprompter` · `voice-follow` · `offline-first` · `pwa` · `rust` · `webassembly` · `zig` · `webrtc` · `cloudflare` · `privacy`

<img src="apps/web/public/og.png" alt="DeskPrompter landing page: a vermilion desk lamp lighting the words 'Say it like you mean it.'" width="760" />

</div>

---

## Why this exists

Good teleprompters keep their best trick, scrolling that follows your voice, behind a subscription because the listening usually happens on someone else's server. DeskPrompter does the listening on your machine and the matching in WebAssembly, so there's nothing to pay for and nothing to leak. Scripts live in your browser's storage. There are no accounts and no analytics.

Meet **Andon** (行灯), the lamp. Its light is the reading line. It nods when you finish a paragraph, leans in while you talk, droops when you pause, and nods off if you leave it alone long enough.

## What's on the menu

| | | |
|---|---|---|
| 一 | **Voice-follow** | Matches what you say against the script, word by word. Skips, stumbles, ad-libs and re-reads are handled. Recognition stays on-device: Chrome's local engine or Moonshine in WebAssembly. |
| 二 | **Breath mode** | No speech recognition at all. A tiny Zig voice detector scrolls while you talk and glides to a stop when you pause. |
| 三 | **Steady mode** | The classic glide, calibrated in words per minute. Speed changes ease in instead of jumping. |
| 四 | **Phone remote** | Scan a QR code and your phone is the clicker. Commands go peer to peer over WebRTC; the script stays on the laptop. |
| 五 | **Glass-ready** | Horizontal and vertical mirroring for beam-splitter rigs, an adjustable reading line under the lens, and a talent window for a second screen. |
| 六 | **Captions** | Every word you read is timed. Export SRT or VTT and drop it onto your edit timeline. |

**Keys (on stage):** `space` play/pause · `↑` `↓` pace · `←` `→` line · `PgUp` `PgDn` paragraph (presentation clickers) · `m` mirror · `f` fullscreen · `+` `−` type size · `1` `2` `3` mode · `esc` back to the desk.

**Script syntax:** a blank line starts a paragraph. `# Heading` marks a section. `[smile]` is a cue: it's shown on stage but never tracked.

## Architecture

```
                         ┌────────────────────────── your browser ──────────────────────────┐
                         │                                                                   │
   mic ──► MediaStream ──┼─► AudioWorklet ──► zig/vad (wasm) ──► level · speaking ──┐        │
                         │                                                          │        │
                         └─► speech engine ──► "and there is only one thing" ──┐    │        │
                             (Chrome on-device │ Moonshine wasm)                │    │        │
                                                                                ▼    ▼        │
   script ──► crates/aligner (Rust → wasm) ──► parse ──► word spans ──►  Prompter engine ──► stage
                      ▲   feed(hypothesis) ──► cursor · lead · confidence ──┘   (rAF, springs)     │
                      └──────────────────────────────────────────────────────────────────────┘
                                                                                  │
             phone ◄── WebRTC data channel (P2P) ◄── signaling ── crates/relay ◄──┘
                                                     (Rust · Cloudflare Durable Object)
```

| Path | Language | What it does |
|---|---|---|
| `apps/web` | TypeScript · Preact · Vite | The PWA: landing page, studio, stage, remote. Bun workspace. |
| `apps/web/src/core/prompter.ts` | TypeScript | The scroll engine. It measures word positions and moves the column under the reading line with critically damped springs. |
| `apps/web/src/ui/lamp` | TypeScript · SVG | Andon: two-link inverse kinematics, under-damped springs for follow-through, a pendulum paper tag. |
| `crates/aligner` | Rust → WebAssembly | The script parser and the voice-follow tracker. Rarity-weighted local alignment over a window ahead of your place, phonetic keys for mishearings, and tiered commits so it never lurches. |
| `zig/vad` | Zig → WebAssembly | Voice activity detection in an AudioWorklet: high-pass filter, adaptive noise floor, hysteresis. No allocator, a few KB. |
| `crates/relay` | Rust → Cloudflare Workers | A Durable Object that introduces your phone to your laptop (WebRTC signaling) and relays only if peer-to-peer fails. |

Why these languages: the aligner runs on every recognizer update and has to be fast and predictable, so it's Rust. The voice detector runs 375 times a second on the audio thread with no garbage collector allowed, so it's Zig. The relay shares Rust's types and runs at the edge for pennies.

## Run it

```sh
bun install
bun run build:wasm   # needs rustup (wasm32-unknown-unknown), wasm-pack, zig
bun run dev          # http://localhost:5173
```

```sh
bun run test         # vitest
cargo test --workspace
(cd zig/vad && zig build test)
```

Pushes to `main` run CI (Rust, Zig, typecheck, tests, build) and deploy to Cloudflare Pages when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set as repository secrets.

## Privacy, plainly

- Scripts are stored in IndexedDB on your device.
- Voice-follow uses on-device recognition by default. Chrome's cloud recognizer is only available if you turn it on yourself, and the setting tells you where the audio goes.
- The relay only ever sees pairing messages and, if WebRTC can't connect, the remote's button presses. Scripts never go through it.

## Credits

Voice-follow ideas were borrowed (not code) from [linefeed](https://github.com/NxTsh/linefeed), [Suflyor](https://github.com/olerast67/voice-teleprompter-android), [Textream](https://github.com/f/textream) and [promptme-ai](https://github.com/larsbaunwall/promptme-ai). Type is set in Newsreader, Geist and Shippori Mincho (all under the SIL Open Font License).

MIT © Karthik Subramanian. Made late at night. 乾杯.
