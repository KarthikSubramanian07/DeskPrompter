//! A compact Metaphone (after Lawrence Philips, 1990), written from the rules.
//!
//! It maps an English word to a rough consonant skeleton so homophones and
//! common recognizer mishearings collide: `their`/`there` → `0R`,
//! `write`/`right` → `RT`, `for`/`four` → `FR`, `night`/`knight` → `NT`.
//! Vowels survive only as a leading `A`. Words that aren't plain ASCII
//! letters get an empty key (no phonetic matching for them).

fn is_vowel(c: u8) -> bool {
    matches!(c, b'A' | b'E' | b'I' | b'O' | b'U')
}

/// Maximum key length; longer words are distinguished by spelling anyway.
const MAX_KEY: usize = 6;

/// Homophones the consonant skeleton alone misses (mostly number words,
/// which recognizers love to swap: "to"/"two", "for"/"four", "won"/"one").
const ALIASES: &[(&str, &str)] = &[
    ("two", "T"),
    ("too", "T"),
    ("to", "T"),
    ("one", "WN"),
    ("won", "WN"),
    ("eight", "AT"),
    ("ate", "AT"),
    ("four", "FR"),
    ("for", "FR"),
    ("fore", "FR"),
];

pub fn metaphone(word: &str) -> String {
    if word.is_empty() || !word.bytes().all(|b| b.is_ascii_alphabetic()) {
        return String::new();
    }
    if let Some((_, k)) = ALIASES.iter().find(|(w, _)| *w == word) {
        return (*k).to_string();
    }
    let up: Vec<u8> = word.bytes().map(|b| b.to_ascii_uppercase()).collect();
    // Collapse doubled letters, except C (accent, success).
    let mut w: Vec<u8> = Vec::with_capacity(up.len());
    for &c in &up {
        if w.last() == Some(&c) && c != b'C' {
            continue;
        }
        w.push(c);
    }
    // Initial exceptions.
    let mut start = 0;
    match (w.first().copied(), w.get(1).copied()) {
        (Some(b'K' | b'G' | b'P'), Some(b'N'))
        | (Some(b'A'), Some(b'E'))
        | (Some(b'W'), Some(b'R')) => start = 1,
        (Some(b'X'), _) => w[0] = b'S',
        (Some(b'W'), Some(b'H')) => {
            w.remove(1);
        }
        _ => {}
    }

    let n = w.len();
    let at = |i: isize| -> u8 {
        if i < 0 || i as usize >= n {
            0
        } else {
            w[i as usize]
        }
    };
    let mut key = String::with_capacity(MAX_KEY);
    let mut i = start;
    while i < n && key.len() < MAX_KEY {
        let c = w[i];
        let ii = i as isize;
        let prev = at(ii - 1);
        let next = at(ii + 1);
        let next2 = at(ii + 2);
        match c {
            b'A' | b'E' | b'I' | b'O' | b'U' => {
                if i == start {
                    key.push('A');
                }
            }
            b'B' => {
                // silent in -MB at the end (dumb, thumb)
                if !(prev == b'M' && i + 1 == n) {
                    key.push('B');
                }
            }
            b'C' => {
                if next == b'I' && next2 == b'A' {
                    key.push('X');
                } else if next == b'H' {
                    if prev == b'S' {
                        key.push('K'); // school
                    } else {
                        key.push('X');
                    }
                    i += 1;
                } else if matches!(next, b'I' | b'E' | b'Y') {
                    if prev != b'S' {
                        key.push('S'); // science: SC before I/E/Y is just S
                    }
                } else {
                    key.push('K');
                }
            }
            b'D' => {
                if next == b'G' && matches!(next2, b'E' | b'Y' | b'I') {
                    key.push('J');
                    i += 1;
                } else {
                    key.push('T');
                }
            }
            b'G' => {
                let silent_gh = next == b'H' && !(i + 2 >= n || is_vowel(next2));
                let silent_gn = next == b'N'
                    && (i + 2 == n || (next2 == b'E' && at(ii + 3) == b'D' && i + 4 == n));
                if silent_gh || silent_gn {
                    // night, sign, signed
                } else if matches!(next, b'I' | b'E' | b'Y') && prev != b'G' {
                    key.push('J');
                } else {
                    key.push('K');
                }
            }
            b'H' => {
                // voiced only before a vowel and not part of CH/SH/PH/TH/GH
                if is_vowel(next) && !matches!(prev, b'C' | b'S' | b'P' | b'T' | b'G') {
                    key.push('H');
                }
            }
            b'K' => {
                if prev != b'C' {
                    key.push('K');
                }
            }
            b'P' => {
                if next == b'H' {
                    key.push('F');
                    i += 1;
                } else {
                    key.push('P');
                }
            }
            b'Q' => key.push('K'),
            b'S' => {
                if next == b'H' {
                    key.push('X');
                    i += 1;
                } else if next == b'I' && matches!(next2, b'O' | b'A') {
                    key.push('X');
                } else {
                    key.push('S');
                }
            }
            b'T' => {
                if next == b'I' && matches!(next2, b'O' | b'A') {
                    key.push('X');
                } else if next == b'H' {
                    key.push('0');
                    i += 1;
                } else if !(next == b'C' && next2 == b'H') {
                    key.push('T');
                }
            }
            b'V' => key.push('F'),
            b'W' | b'Y' => {
                if is_vowel(next) {
                    key.push(c as char);
                }
            }
            b'X' => key.push_str("KS"),
            b'Z' => key.push('S'),
            // F J L M N R
            _ => key.push(c as char),
        }
        i += 1;
    }
    key.truncate(MAX_KEY);
    key
}

#[cfg(test)]
mod tests {
    use super::metaphone;

    fn same(a: &str, b: &str) {
        assert_eq!(
            metaphone(a),
            metaphone(b),
            "{a} vs {b}: {} / {}",
            metaphone(a),
            metaphone(b)
        );
        assert!(!metaphone(a).is_empty());
    }

    #[test]
    fn homophones_collide() {
        same("their", "there");
        same("there", "they're".replace('\'', "").as_str());
        same("write", "right");
        same("for", "four");
        same("night", "knight");
        same("to", "two");
        same("know", "no");
        same("weight", "wait");
        same("by", "buy");
        same("sea", "see");
        same("hear", "here");
        same("one", "won");
        same("eight", "ate");
        same("phase", "faze");
    }

    #[test]
    fn distinct_words_stay_apart() {
        assert_ne!(metaphone("cat"), metaphone("dog"));
        assert_ne!(metaphone("ship"), metaphone("sip"));
        assert_ne!(metaphone("think"), metaphone("sink"));
        assert_ne!(metaphone("teleprompter"), metaphone("telephone"));
    }

    #[test]
    fn known_keys() {
        assert_eq!(metaphone("thumb"), "0M");
        assert_eq!(metaphone("school"), "SKL");
        assert_eq!(metaphone("nation"), "NXN");
        assert_eq!(metaphone("judge"), "JJ");
        assert_eq!(metaphone("xylophone"), "SLFN");
    }

    #[test]
    fn non_ascii_has_no_key() {
        assert_eq!(metaphone("東"), "");
        assert_eq!(metaphone("mp3"), "");
        assert_eq!(metaphone(""), "");
    }
}
