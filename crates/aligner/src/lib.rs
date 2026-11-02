//! DeskPrompter aligner: parses a teleprompter script and follows a reader's
//! voice through it. Pure Rust core: [`parse_script`] and [`Tracker`].

mod fold_table;
pub mod model;
pub mod normalize;
pub mod parse;
pub mod phonetic;
pub mod similarity;
pub mod tracker;

pub use parse::{parse_script, BlockKind, ParsedScript, ScriptBlock, ScriptToken, TokenKind};
pub use tracker::{AlignResult, TrackState, Tracker};
