//! DeskPrompter aligner: parses a teleprompter script and follows a reader's
//! voice through it. Pure Rust core ([`Tracker`], [`parse_script`]) plus thin
//! `wasm-bindgen` bindings (the private `wasm` module).

mod fold_table;
pub mod model;
pub mod normalize;
pub mod parse;
pub mod phonetic;
pub mod similarity;
pub mod tracker;
mod wasm;

pub use parse::{parse_script, BlockKind, ParsedScript, ScriptBlock, ScriptToken, TokenKind};
pub use tracker::{AlignResult, TrackState, Tracker};
