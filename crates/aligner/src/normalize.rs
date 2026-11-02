//! Text normalization for matching.
//!
//! Every script word and every recognized word goes through [`word_units`],
//! which turns one whitespace-delimited chunk into zero or more *units*: the
//! lowercase, punctuation-free keys the aligner compares. A chunk can expand:
//! `2026` → `twenty twenty six`, `well-known` → `well known`, `50%` →
//! `fifty percent`, and CJK text splits into one unit per character (those
//! scripts don't put spaces between words). Both sides use the same rules, so
//! a recognizer that writes digits and a script that spells numbers out (or
//! the other way round) still meet in the middle.

use crate::fold_table::{MULTI, SINGLE};

/// Hesitation sounds recognizers emit. Dropped from heard text before alignment.
const FILLERS: &[&str] = &[
    "um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "ahh", "hmm", "hm", "mm", "mmm", "mhm",
    "eh",
];

/// Function words: cheap to skip, weak evidence when matched.
const STOPWORDS: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by", "for", "with",
    "from", "as", "is", "are", "was", "were", "be", "been", "am", "it", "its", "this", "that",
    "these", "those", "i", "you", "he", "she", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "our", "their", "so", "like", "just", "do", "does", "did", "not", "no",
    "yes", "oh", "okay", "ok", "well", "then", "than", "there", "here", "what", "which", "who",
    "can", "will", "would", "have", "has", "had", "all", "up", "out", "about", "into", "too",
    "very", "really", "now", "know", "dont", "im", "thats", "its", "youre", "were", "lets",
];

pub fn is_filler(unit: &str) -> bool {
    FILLERS.contains(&unit)
}

pub fn is_stopword(unit: &str) -> bool {
    STOPWORDS.contains(&unit)
}

/// Han, Hiragana, Katakana: languages written without spaces. Each character
/// becomes its own unit so alignment still has something to grip.
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF   // Hiragana, Katakana
        | 0x3400..=0x4DBF // CJK Ext A
        | 0x4E00..=0x9FFF // CJK Unified
        | 0xF900..=0xFAFF // CJK Compatibility
        | 0x20000..=0x2FFFF)
}

fn is_apostrophe(c: char) -> bool {
    matches!(
        c,
        '\'' | '\u{2019}' | '\u{2018}' | '\u{02BC}' | '`' | '\u{00B4}'
    )
}

/// Combining diacritics (for text that arrives already decomposed).
fn is_combining(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

/// Compatibility-fold one character the way NFKD does, with accents removed
/// from Latin/Greek/Cyrillic letters (`é` → `e`, `ﬁ` → `fi`, `Ａ` → `A`,
/// `²` → `2`). A generated table covers the ranges that matter for speech;
/// see `tools/gen_fold.py`, and the test that checks it against real NFKD.
pub fn fold_char(c: char, mut emit: impl FnMut(char)) {
    let cp = c as u32;
    if (0xA0..=0xFFFF).contains(&cp) {
        if let Ok(i) = SINGLE.binary_search_by_key(&(cp as u16), |p| p.0) {
            emit(char::from_u32(SINGLE[i].1 as u32).unwrap_or(c));
            return;
        }
        if let Ok(i) = MULTI.binary_search_by_key(&(cp as u16), |p| p.0) {
            MULTI[i].1.chars().for_each(emit);
            return;
        }
    }
    emit(c);
}

/// Fold one chunk: compatibility forms and accents folded (NFKD-style, so
/// `café` meets `cafe`), lowercased.
fn fold(raw: &str, out: &mut String) {
    out.clear();
    let mut last_base = 0u32;
    for c in raw.chars() {
        if is_combining(c) {
            if last_base >= 0x0530 {
                out.push(c);
            }
            continue;
        }
        fold_char(c, |f| {
            last_base = f as u32;
            for l in f.to_lowercase() {
                out.push(l);
            }
        });
    }
}

/// A piece of a chunk before number expansion.
struct Piece {
    text: String,
    /// Joined to the next piece by an ASCII hyphen.
    hyphen_next: bool,
    cjk: bool,
}

/// Normalize one whitespace-delimited chunk into matching units, appended to `out`.
pub fn word_units(raw: &str, out: &mut Vec<String>) {
    if let Some(unit) = plain_ascii_word(raw) {
        if !unit.is_empty() {
            out.push(unit);
        }
        return;
    }
    let mut folded = String::with_capacity(raw.len());
    fold(raw, &mut folded);
    let chars: Vec<char> = folded.chars().collect();

    let mut pieces: Vec<Piece> = Vec::new();
    let mut cur = String::new();
    let mut dollars = false;
    let mut percent_after: Option<usize> = None;

    let flush = |cur: &mut String, pieces: &mut Vec<Piece>, hyphen: bool| {
        if !cur.is_empty() {
            pieces.push(Piece {
                text: std::mem::take(cur),
                hyphen_next: hyphen,
                cjk: false,
            });
        }
    };

    for (i, &c) in chars.iter().enumerate() {
        if is_cjk(c) {
            flush(&mut cur, &mut pieces, false);
            pieces.push(Piece {
                text: c.to_string(),
                hyphen_next: false,
                cjk: true,
            });
        } else if c.is_alphanumeric() {
            cur.push(c);
        } else if is_apostrophe(c) {
            // don't → dont
        } else if (c == '.' || c == ',')
            && i > 0
            && chars[i - 1].is_ascii_digit()
            && chars.get(i + 1).is_some_and(|n| n.is_ascii_digit())
        {
            cur.push(c);
        } else if c == '-' && !cur.is_empty() {
            flush(&mut cur, &mut pieces, true);
        } else {
            match c {
                '$' => dollars = true,
                '%' => {
                    flush(&mut cur, &mut pieces, false);
                    percent_after = Some(pieces.len());
                }
                '&' => {
                    flush(&mut cur, &mut pieces, false);
                    pieces.push(Piece {
                        text: "and".into(),
                        hyphen_next: false,
                        cjk: false,
                    });
                }
                _ => {}
            }
            flush(&mut cur, &mut pieces, false);
        }
    }
    flush(&mut cur, &mut pieces, false);

    // Re-join hyphenated words with a tiny part (e-mail, co-op, re-read): those
    // are usually recognized as one word.
    let mut joined: Vec<Piece> = Vec::with_capacity(pieces.len());
    for p in pieces {
        if let Some(prev) = joined.last_mut() {
            if prev.hyphen_next {
                let small = |s: &str| s.chars().count() <= 2 && s.chars().all(char::is_alphabetic);
                if small(&prev.text) || small(&p.text) {
                    prev.text.push_str(&p.text);
                    prev.hyphen_next = p.hyphen_next;
                    continue;
                }
            }
        }
        joined.push(p);
    }

    let had_number = joined
        .iter()
        .any(|p| p.text.starts_with(|c: char| c.is_ascii_digit()));
    for (idx, p) in joined.iter().enumerate() {
        if percent_after == Some(idx) {
            out.push("percent".into());
        }
        if p.cjk {
            out.push(p.text.clone());
        } else {
            expand_piece(&p.text, out);
        }
    }
    if percent_after == Some(joined.len()) && had_number {
        out.push("percent".into());
    }
    if dollars && had_number {
        out.push("dollars".into());
    }
}

/// Fast path for the common case: ASCII letters with apostrophes inside and
/// punctuation only at the edges (`Hello,` `don't` `"Yes!"`). Anything with
/// digits, hyphens, symbols or inner punctuation takes the full path.
fn plain_ascii_word(raw: &str) -> Option<String> {
    let b = raw.as_bytes();
    let first = b.iter().position(|c| c.is_ascii_alphabetic())?;
    let last = b.iter().rposition(|c| c.is_ascii_alphabetic())?;
    let edge_ok = |c: &u8| {
        matches!(
            c,
            b'.' | b',' | b'!' | b'?' | b';' | b':' | b'"' | b'\'' | b'(' | b')' | b'*' | b'_'
        )
    };
    if !b[..first].iter().all(edge_ok) || !b[last + 1..].iter().all(edge_ok) {
        return None;
    }
    let mut unit = String::with_capacity(last + 1 - first);
    for &c in &b[first..=last] {
        if c.is_ascii_alphabetic() {
            unit.push(c.to_ascii_lowercase() as char);
        } else if c != b'\'' {
            return None;
        }
    }
    Some(unit)
}

/// Normalize a whole utterance into units. `drop_fillers` removes hesitation sounds.
pub fn text_units(text: &str, drop_fillers: bool) -> Vec<String> {
    let mut out = Vec::new();
    for chunk in text.split_whitespace() {
        let from = out.len();
        word_units(chunk, &mut out);
        if drop_fillers {
            let mut k = from;
            while k < out.len() {
                if is_filler(&out[k]) {
                    out.remove(k);
                } else {
                    k += 1;
                }
            }
        }
    }
    out
}

/* ───────────────────────── numbers → words ───────────────────────── */

const ONES: [&str; 20] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];
const TENS: [&str; 10] = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

fn push_under_100(n: u64, out: &mut Vec<String>) {
    if n < 20 {
        out.push(ONES[n as usize].into());
    } else {
        out.push(TENS[(n / 10) as usize].into());
        if !n.is_multiple_of(10) {
            out.push(ONES[(n % 10) as usize].into());
        }
    }
}

fn push_under_1000(n: u64, out: &mut Vec<String>) {
    if n >= 100 {
        out.push(ONES[(n / 100) as usize].into());
        out.push("hundred".into());
        if !n.is_multiple_of(100) {
            push_under_100(n % 100, out);
        }
    } else {
        push_under_100(n, out);
    }
}

/// Cardinal English, no "and": 1234 → one thousand two hundred thirty four.
pub fn push_cardinal(n: u64, out: &mut Vec<String>) {
    if n == 0 {
        out.push("zero".into());
        return;
    }
    const SCALES: [(u64, &str); 3] = [
        (1_000_000_000, "billion"),
        (1_000_000, "million"),
        (1_000, "thousand"),
    ];
    let mut rest = n;
    for (scale, name) in SCALES {
        if rest >= scale {
            push_under_1000(rest / scale, out);
            out.push(name.into());
            rest %= scale;
        }
    }
    if rest > 0 {
        push_under_1000(rest, out);
    }
}

/// Years are read in pairs: 1984 → nineteen eighty four, 2026 → twenty twenty six.
fn push_year(n: u64, out: &mut Vec<String>) {
    let (hi, lo) = (n / 100, n % 100);
    push_under_100(hi, out);
    match lo {
        0 => out.push("hundred".into()),
        1..=9 => {
            out.push("oh".into());
            out.push(ONES[lo as usize].into());
        }
        _ => push_under_100(lo, out),
    }
}

fn push_digits(s: &str, out: &mut Vec<String>) {
    for c in s.chars() {
        if let Some(d) = c.to_digit(10) {
            out.push(ONES[d as usize].into());
        }
    }
}

fn ordinalize(word: &str) -> String {
    match word {
        "one" => "first".into(),
        "two" => "second".into(),
        "three" => "third".into(),
        "five" => "fifth".into(),
        "eight" => "eighth".into(),
        "nine" => "ninth".into(),
        "twelve" => "twelfth".into(),
        w if w.ends_with('y') => format!("{}ieth", &w[..w.len() - 1]),
        w => format!("{w}th"),
    }
}

fn push_integer(s: &str, out: &mut Vec<String>) {
    let digits: String = s.chars().filter(|c| *c != ',').collect();
    if digits.is_empty() {
        return;
    }
    if digits.len() > 1 && digits.starts_with('0') || digits.len() > 12 {
        push_digits(&digits, out);
        return;
    }
    let n: u64 = match digits.parse() {
        Ok(n) => n,
        Err(_) => return push_digits(&digits, out),
    };
    let comma = s.contains(',');
    if !comma && digits.len() == 4 && ((1100..2000).contains(&n) || (2010..2100).contains(&n)) {
        push_year(n, out);
    } else {
        push_cardinal(n, out);
    }
}

/// Expand one punctuation-free piece. Digits become words; everything else passes through.
fn expand_piece(p: &str, out: &mut Vec<String>) {
    let first_digit = p.starts_with(|c: char| c.is_ascii_digit());
    if !first_digit {
        out.push(p.to_string());
        return;
    }
    let num_end = p
        .char_indices()
        .find(|(_, c)| !(c.is_ascii_digit() || *c == ',' || *c == '.'))
        .map(|(i, _)| i)
        .unwrap_or(p.len());
    let (num, suffix) = p.split_at(num_end);
    match suffix {
        "" => {
            if let Some((int, frac)) = num.split_once('.') {
                push_integer(int, out);
                out.push("point".into());
                push_digits(frac, out);
            } else {
                push_integer(num, out);
            }
        }
        "st" | "nd" | "rd" | "th" if !num.contains('.') => {
            push_integer(num, out);
            if let Some(last) = out.pop() {
                out.push(ordinalize(&last));
            }
        }
        "s" if num.len() == 2 || num.len() == 4 => {
            // 90s → nineties, 1980s → nineteen eighties
            push_integer(num, out);
            if let Some(last) = out.pop() {
                out.push(if last.ends_with('y') {
                    format!("{}ies", &last[..last.len() - 1])
                } else {
                    format!("{last}s")
                });
            }
        }
        // mp3, 4k, covid19: keep as one opaque unit.
        _ => out.push(p.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<String> {
        text_units(s, true)
    }

    #[test]
    fn strips_punctuation_and_case() {
        assert_eq!(u("“Hello,” she said—"), ["hello", "she", "said"]);
        assert_eq!(u("Don’t STOP"), ["dont", "stop"]);
        assert_eq!(u("Café naïve Ångström"), ["cafe", "naive", "angstrom"]);
    }

    #[test]
    fn splits_dashes_and_slashes() {
        assert_eq!(
            u("well-known and/or rock—paper"),
            ["well", "known", "and", "or", "rock", "paper"]
        );
        assert_eq!(u("e-mail co-op"), ["email", "coop"]);
    }

    #[test]
    fn numbers_to_words() {
        assert_eq!(u("2026"), ["twenty", "twenty", "six"]);
        assert_eq!(u("1984"), ["nineteen", "eighty", "four"]);
        assert_eq!(u("1905"), ["nineteen", "oh", "five"]);
        assert_eq!(u("2005"), ["two", "thousand", "five"]);
        assert_eq!(u("10,000"), ["ten", "thousand"]);
        assert_eq!(u("1,500"), ["one", "thousand", "five", "hundred"]);
        assert_eq!(u("42"), ["forty", "two"]);
        assert_eq!(u("3.5"), ["three", "point", "five"]);
        assert_eq!(u("21st 3rd"), ["twenty", "first", "third"]);
        assert_eq!(u("50%"), ["fifty", "percent"]);
        assert_eq!(u("$20"), ["twenty", "dollars"]);
        assert_eq!(u("90s"), ["nineties"]);
        assert_eq!(u("007"), ["zero", "zero", "seven"]);
    }

    #[test]
    fn fillers_dropped_only_when_asked() {
        assert_eq!(u("um so uh yeah"), ["so", "yeah"]);
        assert_eq!(text_units("um so", false), ["um", "so"]);
    }

    #[test]
    fn cjk_splits_per_character() {
        assert_eq!(u("你好世界"), ["你", "好", "世", "界"]);
        assert_eq!(u("北京tower"), ["北", "京", "tower"]);
    }

    #[test]
    fn compatibility_forms_fold() {
        // full-width digits and ligatures
        assert_eq!(u("ＡＢＣ ﬁne １２"), ["abc", "fine", "twelve"]);
    }

    /// The generated fold table must agree with real NFKD (+ accent removal)
    /// on every code point it covers.
    #[test]
    fn fold_table_matches_nfkd() {
        use unicode_normalization::char::is_combining_mark;
        use unicode_normalization::UnicodeNormalization;
        let ranges = [
            (0x00A0, 0x024F),
            (0x0370, 0x03FF),
            (0x0400, 0x04FF),
            (0x1E00, 0x1EFF),
            (0x1F00, 0x1FFF),
            (0x2070, 0x209F),
            (0x2150, 0x218F),
            (0xF900, 0xFAFF),
            (0xFB00, 0xFB06),
            (0xFF01, 0xFFEE),
        ];
        let mut checked = 0;
        let mut newer = Vec::new();
        for (lo, hi) in ranges {
            for cp in lo..=hi {
                let Some(c) = char::from_u32(cp) else {
                    continue;
                };
                let mut want = String::new();
                let mut base = 0u32;
                for d in c.to_string().nfkd() {
                    if is_combining_mark(d) && base < 0x530 {
                        continue;
                    }
                    if !is_combining_mark(d) {
                        base = d as u32;
                    }
                    want.push(d);
                }
                let mut got = String::new();
                fold_char(c, |f| got.push(f));
                if got == c.to_string() && want != got {
                    // Newer Unicode in the crate than in the generator: tolerate a few.
                    newer.push(cp);
                } else if want != c.to_string() || got != c.to_string() {
                    assert_eq!(got, want, "U+{cp:04X} {c}");
                    checked += 1;
                }
            }
        }
        assert!(checked > 1000, "only {checked} folded code points");
        assert!(
            newer.len() <= 8,
            "fold table is stale, regenerate it: {newer:X?}"
        );
    }

    #[test]
    fn emoji_and_bare_punctuation_vanish() {
        assert!(u("🎬 — … !!").is_empty());
    }
}
