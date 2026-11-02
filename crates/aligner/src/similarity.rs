//! Word similarity in `[0, 1]` between a heard unit and a script vocab entry.
//!
//! - exact normalized match → 1.0
//! - same phonetic key (homophones, mishearings) → 0.8
//! - plural / -s forms → 0.85
//! - edit-distance ratio for words of 4+ characters (≥ 0.7 ratio) → up to 0.95
//!
//! Prefix credit for a half-heard last word lives in the tracker, because it
//! only applies to the newest interim word.

use crate::model::VocabEntry;

pub const PHONETIC_SIM: f32 = 0.8;

/// A recognized unit, prepared once when it arrives.
#[derive(Clone)]
pub struct Heard {
    pub key: String,
    pub chars: Vec<char>,
    pub phon: String,
}

impl Heard {
    pub fn new(key: String) -> Heard {
        Heard {
            chars: key.chars().collect(),
            phon: crate::phonetic::metaphone(&key),
            key,
        }
    }
}

/// Levenshtein distance, giving up (None) once it must exceed `max`.
fn levenshtein_within(a: &[char], b: &[char], max: usize) -> Option<usize> {
    if a.len().abs_diff(b.len()) > max {
        return None;
    }
    let mut prev: [u16; 40] = [0; 40];
    let mut cur: [u16; 40] = [0; 40];
    if b.len() >= 40 || a.len() >= 40 {
        return None;
    }
    for (j, p) in prev.iter_mut().enumerate().take(b.len() + 1) {
        *p = j as u16;
    }
    for i in 1..=a.len() {
        cur[0] = i as u16;
        let mut row_min = cur[0];
        for j in 1..=b.len() {
            let sub = prev[j - 1] + u16::from(a[i - 1] != b[j - 1]);
            cur[j] = sub.min(prev[j] + 1).min(cur[j - 1] + 1);
            row_min = row_min.min(cur[j]);
        }
        if row_min as usize > max {
            return None;
        }
        prev[..=b.len()].copy_from_slice(&cur[..=b.len()]);
    }
    let d = prev[b.len()] as usize;
    (d <= max).then_some(d)
}

fn plural_of(long: &[char], short: &[char]) -> bool {
    if short.len() < 3 || !long.starts_with(short) {
        return false;
    }
    let tail = &long[short.len()..];
    tail == ['s'] || tail == ['e', 's']
}

pub fn similarity(h: &Heard, v: &VocabEntry) -> f32 {
    if h.key == v.key {
        return 1.0;
    }
    let mut s: f32 = 0.0;
    if !h.phon.is_empty() && h.phon == v.phon {
        s = PHONETIC_SIM;
    }
    let (a, b) = (&h.chars, &v.chars);
    if plural_of(a, b) || plural_of(b, a) {
        s = s.max(0.85);
    }
    let min_len = a.len().min(b.len());
    if min_len >= 4 {
        let max_len = a.len().max(b.len());
        let budget = (max_len * 3) / 10; // ratio ≥ 0.7
        if let Some(d) = levenshtein_within(a, b, budget.max(1)) {
            let ratio = 1.0 - d as f32 / max_len as f32;
            if ratio >= 0.7 {
                s = s.max(0.95 * ratio);
            }
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(key: &str) -> VocabEntry {
        VocabEntry {
            key: key.into(),
            chars: key.chars().collect(),
            phon: crate::phonetic::metaphone(key),
        }
    }
    fn sim(a: &str, b: &str) -> f32 {
        similarity(&Heard::new(a.into()), &v(b))
    }

    #[test]
    fn grades() {
        assert_eq!(sim("hello", "hello"), 1.0);
        assert_eq!(sim("there", "their"), PHONETIC_SIM);
        assert_eq!(sim("right", "write"), PHONETIC_SIM);
        assert!(sim("kubernetis", "kubernetes") > 0.8);
        assert!(sim("words", "word") >= 0.85);
        assert!(sim("teleprompters", "teleprompter") > 0.85);
        assert_eq!(sim("cat", "dog"), 0.0);
        assert!(sim("house", "mouse") < 0.8, "{}", sim("house", "mouse"));
        assert_eq!(sim("ship", "sip"), 0.0);
    }
}
