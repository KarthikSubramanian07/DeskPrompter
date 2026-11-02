//! DeskPrompter aligner: parses a teleprompter script and follows a reader's
//! voice through it.

mod fold_table;
pub mod normalize;
pub mod parse;
pub mod phonetic;

pub use parse::{parse_script, BlockKind, ParsedScript, ScriptBlock, ScriptToken, TokenKind};
