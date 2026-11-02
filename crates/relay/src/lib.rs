//! DeskPrompter signaling relay.
//!
//! A tiny Cloudflare Worker that pairs a prompter (the *host*) with phone
//! remotes and talent displays. Each six-character room code maps to one
//! Durable Object that holds the room's WebSockets using the Hibernation API,
//! so an idle room costs nothing. The relay forwards opaque JSON text frames
//! between peers (WebRTC signaling, or LinkMessages when a direct data channel
//! cannot be established) and never stores them.
//!
//! All decision logic lives in [`protocol`] and is tested on the host target;
//! the runtime glue in `worker_impl` is compiled only for `wasm32`.

pub mod protocol;

#[cfg(target_arch = "wasm32")]
mod worker_impl;
