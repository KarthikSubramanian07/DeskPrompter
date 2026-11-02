//! Script parser: plain text → blocks of display tokens.
//!
//! Rules (mirrored by `ParsedScript` in `apps/web/src/core/contracts.ts`):
//! - Blank lines separate blocks. A line whose first non-space character is
//!   `#` is a `heading` block on its own; everything else is a `para`.
//! - `[bracketed text]` is one `cue` token (may span spaces, not lines).
//!   Cues are shown, never tracked: `wi = -1`.
//! - Words split on whitespace and keep attached punctuation for display.
//!   Only words with speakable content in `para` blocks get a word index;
//!   heading words and bare punctuation (`—`, `…`, emoji) get `wi = -1`.
//! - `start`/`end` are UTF-16 code-unit offsets, so in JS
//!   `script.slice(start, end) === text`.

use serde::Serialize;

use crate::normalize::word_units;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenKind {
    Word,
    Cue,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScriptToken {
    pub kind: TokenKind,
    pub text: String,
    pub start: u32,
    pub end: u32,
    pub wi: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    Heading,
    Para,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScriptBlock {
    pub kind: BlockKind,
    pub start: u32,
    pub end: u32,
    pub tokens: Vec<ScriptToken>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedScript {
    pub blocks: Vec<ScriptBlock>,
    pub word_count: u32,
}

/// Everything the aligner needs besides the display model.
pub struct Parsed {
    pub script: ParsedScript,
    /// Matching units for each spoken word, indexed by `wi`.
    pub units: Vec<Vec<String>>,
    /// Word starts a sentence, a line, or follows a cue: readers restart and
    /// skip to such places, so jumps landing there need less evidence.
    pub anchors: Vec<bool>,
}

/// Monotonic byte → UTF-16 offset converter.
struct U16 {
    byte: usize,
    u16: u32,
}

impl U16 {
    fn at(&mut self, text: &str, byte: usize) -> u32 {
        if byte < self.byte {
            self.byte = 0;
            self.u16 = 0;
        }
        for c in text[self.byte..byte].chars() {
            self.u16 += c.len_utf16() as u32;
        }
        self.byte = byte;
        self.u16
    }
}

#[derive(PartialEq)]
enum LineKind {
    Blank,
    Heading,
    Text,
}

pub fn parse_script(text: &str) -> ParsedScript {
    parse(text).script
}

pub fn parse(text: &str) -> Parsed {
    let mut out = Parsed {
        script: ParsedScript {
            blocks: Vec::new(),
            word_count: 0,
        },
        units: Vec::new(),
        anchors: Vec::new(),
    };
    let mut conv = U16 { byte: 0, u16: 0 };

    // Lines as byte ranges (without the '\n').
    let mut lines: Vec<(usize, usize, LineKind)> = Vec::new();
    let mut ls = 0;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            lines.push((ls, i, LineKind::Text));
            ls = i + 1;
        }
    }
    lines.push((ls, text.len(), LineKind::Text));
    for l in lines.iter_mut() {
        let t = text[l.0..l.1].trim_start();
        l.2 = if t.trim_end().is_empty() {
            LineKind::Blank
        } else if t.starts_with('#') {
            LineKind::Heading
        } else {
            LineKind::Text
        };
    }

    let mut i = 0;
    while i < lines.len() {
        let (a, b, ref kind) = lines[i];
        match kind {
            LineKind::Blank => i += 1,
            LineKind::Heading => {
                let lead_ws = text[a..b].len() - text[a..b].trim_start().len();
                let hash_start = a + lead_ws;
                let after_hashes = hash_start
                    + text[hash_start..b]
                        .bytes()
                        .take_while(|&c| c == b'#')
                        .count();
                let end_byte = a + text[a..b].trim_end().len();
                let start = conv.at(text, hash_start);
                let tokens = tokenize(text, after_hashes, end_byte, false, &mut conv, &mut out);
                let end = conv.at(text, end_byte);
                out.script.blocks.push(ScriptBlock {
                    kind: BlockKind::Heading,
                    start,
                    end,
                    tokens,
                });
                i += 1;
            }
            LineKind::Text => {
                let mut j = i;
                while j + 1 < lines.len() && lines[j + 1].2 == LineKind::Text {
                    j += 1;
                }
                let first = a + (text[a..b].len() - text[a..b].trim_start().len());
                let (la, lb, _) = lines[j];
                let last = la + text[la..lb].trim_end().len();
                let start = conv.at(text, first);
                let tokens = tokenize(text, first, last, true, &mut conv, &mut out);
                let end = conv.at(text, last);
                out.script.blocks.push(ScriptBlock {
                    kind: BlockKind::Para,
                    start,
                    end,
                    tokens,
                });
                i = j + 1;
            }
        }
    }
    out.script.word_count = out.units.len() as u32;
    out
}

fn ends_sentence(token_text: &str) -> bool {
    let t = token_text.trim_end_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | ')' | ']' | '\u{201D}' | '\u{2019}' | '»' | '*' | '_'
        )
    });
    t.ends_with([
        '.', '!', '?', ':', ';', '\u{2026}', '\u{3002}', '\u{FF01}', '\u{FF1F}',
    ])
}

/// If a cue opens at `p` (a `[`), the byte just past its `]`. Cues stay on
/// one line, like the TypeScript fallback parser in `core/script.ts`.
fn cue_end(text: &str, p: usize, to: usize) -> Option<usize> {
    let rest = &text[p..to];
    let close = rest.find(']')?;
    (!rest[..close].contains('\n')).then_some(p + close + 1)
}

/// Tokenize `text[from..to]`, assigning word indices when `spoken`.
fn tokenize(
    text: &str,
    from: usize,
    to: usize,
    spoken: bool,
    conv: &mut U16,
    out: &mut Parsed,
) -> Vec<ScriptToken> {
    let mut tokens = Vec::new();
    let mut p = from;
    // Next word is an anchor (block start, after a sentence end, a cue or a line break).
    let mut anchor_next = true;
    let mut scratch_units = Vec::new();
    while p < to {
        let c = text[p..].chars().next().unwrap();
        if c.is_whitespace() {
            if c == '\n' {
                anchor_next = true;
            }
            p += c.len_utf8();
            continue;
        }
        if c == '[' {
            if let Some(end) = cue_end(text, p, to) {
                let start16 = conv.at(text, p);
                let end16 = conv.at(text, end);
                tokens.push(ScriptToken {
                    kind: TokenKind::Cue,
                    text: text[p..end].to_string(),
                    start: start16,
                    end: end16,
                    wi: -1,
                });
                anchor_next = true;
                p = end;
                continue;
            }
        }
        // A word runs to whitespace, or to a '[' that opens a closed cue.
        let mut q = p;
        while q < to {
            let ch = text[q..].chars().next().unwrap();
            if ch.is_whitespace() {
                break;
            }
            if ch == '[' && q > p && cue_end(text, q, to).is_some() {
                break;
            }
            q += ch.len_utf8();
        }
        let word = &text[p..q];
        scratch_units.clear();
        word_units(word, &mut scratch_units);
        let wi = if spoken && !scratch_units.is_empty() {
            out.units.push(std::mem::take(&mut scratch_units));
            out.anchors.push(anchor_next);
            anchor_next = false;
            (out.units.len() - 1) as i32
        } else {
            -1
        };
        if ends_sentence(word) {
            anchor_next = true;
        }
        let start16 = conv.at(text, p);
        let end16 = conv.at(text, q);
        tokens.push(ScriptToken {
            kind: TokenKind::Word,
            text: word.to_string(),
            start: start16,
            end: end16,
            wi,
        });
        p = q;
    }
    tokens
}

impl ParsedScript {
    /// Hand-rolled JSON (same shape as the serde form). Crossing into JS as one
    /// string and `JSON.parse` is several times faster than building tens of
    /// thousands of objects through the wasm boundary.
    pub fn to_json(&self) -> String {
        fn esc(out: &mut String, s: &str) {
            out.push('"');
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        use std::fmt::Write;
        let mut out = String::with_capacity(
            64 + self
                .blocks
                .iter()
                .map(|b| 64 + b.tokens.len() * 64)
                .sum::<usize>(),
        );
        out.push_str("{\"blocks\":[");
        for (bi, b) in self.blocks.iter().enumerate() {
            if bi > 0 {
                out.push(',');
            }
            let kind = match b.kind {
                BlockKind::Heading => "heading",
                BlockKind::Para => "para",
            };
            let _ = write!(
                out,
                "{{\"kind\":\"{kind}\",\"start\":{},\"end\":{},\"tokens\":[",
                b.start, b.end
            );
            for (ti, t) in b.tokens.iter().enumerate() {
                if ti > 0 {
                    out.push(',');
                }
                let kind = match t.kind {
                    TokenKind::Word => "word",
                    TokenKind::Cue => "cue",
                };
                let _ = write!(out, "{{\"kind\":\"{kind}\",\"text\":");
                esc(&mut out, &t.text);
                let _ = write!(
                    out,
                    ",\"start\":{},\"end\":{},\"wi\":{}}}",
                    t.start, t.end, t.wi
                );
            }
            out.push_str("]}");
        }
        let _ = write!(out, "],\"wordCount\":{}}}", self.word_count);
        out
    }
}
