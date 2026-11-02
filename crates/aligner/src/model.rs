//! The script as the aligner sees it: a flat run of matching units with
//! rarity weights, a vocabulary, and inverted indexes for seeding far jumps.

use std::collections::HashMap;

use crate::normalize::is_stopword;
use crate::parse::{parse, Parsed, ParsedScript};
use crate::phonetic::metaphone;

/// One distinct normalized key in the script.
pub struct VocabEntry {
    pub key: String,
    pub chars: Vec<char>,
    pub phon: String,
}

/// One matching unit (a word, or one part of an expanded word like `2026`).
#[derive(Clone, Copy)]
pub struct Unit {
    pub vocab: u32,
    /// Spoken word index this unit belongs to.
    pub wi: u32,
    /// Evidence weight: high for rare content words, low for function words
    /// and words repeated all over the script.
    pub weight: f32,
}

pub struct ScriptModel {
    pub parsed: ParsedScript,
    pub units: Vec<Unit>,
    pub vocab: Vec<VocabEntry>,
    pub vocab_ids: HashMap<String, u32>,
    /// Phonetic key → vocab ids sharing it.
    pub phon_ids: HashMap<String, Vec<u32>>,
    /// Vocab id → unit positions, ascending.
    pub postings: Vec<Vec<u32>>,
    /// Word index → first unit; one extra entry at the end.
    pub word_units: Vec<u32>,
    /// Word starts a sentence/line/block.
    pub anchors: Vec<bool>,
}

impl ScriptModel {
    pub fn new(text: &str) -> ScriptModel {
        let Parsed {
            script,
            units: word_units_list,
            anchors,
        } = parse(text);
        let mut vocab: Vec<VocabEntry> = Vec::new();
        let mut vocab_ids: HashMap<String, u32> = HashMap::new();
        let mut units: Vec<Unit> = Vec::new();
        let mut word_units = Vec::with_capacity(word_units_list.len() + 1);
        for (wi, list) in word_units_list.into_iter().enumerate() {
            word_units.push(units.len() as u32);
            for key in list {
                let id = match vocab_ids.get(&key) {
                    Some(&id) => id,
                    None => {
                        let id = vocab.len() as u32;
                        vocab.push(VocabEntry {
                            chars: key.chars().collect(),
                            phon: metaphone(&key),
                            key: key.clone(),
                        });
                        vocab_ids.insert(key, id);
                        id
                    }
                };
                units.push(Unit {
                    vocab: id,
                    wi: wi as u32,
                    weight: 0.0,
                });
            }
        }
        word_units.push(units.len() as u32);

        let mut postings: Vec<Vec<u32>> = vec![Vec::new(); vocab.len()];
        for (pos, u) in units.iter().enumerate() {
            postings[u.vocab as usize].push(pos as u32);
        }
        let mut phon_ids: HashMap<String, Vec<u32>> = HashMap::new();
        for (id, v) in vocab.iter().enumerate() {
            if !v.phon.is_empty() {
                phon_ids.entry(v.phon.clone()).or_default().push(id as u32);
            }
        }
        // Rarity weight (IDF within the script, Android-tracker style):
        // base × (0.35 + 0.65 / document frequency).
        for u in units.iter_mut() {
            let v = &vocab[u.vocab as usize];
            let base = if is_stopword(&v.key) {
                0.25
            } else if v.chars.len() <= 2 && !v.chars.iter().any(|c| crate::normalize::is_cjk(*c)) {
                0.5
            } else {
                1.0
            };
            let df = postings[u.vocab as usize].len() as f32;
            u.weight = base * (0.35 + 0.65 / df);
        }
        ScriptModel {
            parsed: script,
            units,
            vocab,
            vocab_ids,
            phon_ids,
            postings,
            word_units,
            anchors,
        }
    }

    pub fn word_count(&self) -> u32 {
        self.anchors.len() as u32
    }

    /// Unit range `[first unit of word lo, one past last unit of word hi]`.
    pub fn unit_range(&self, lo_wi: i64, hi_wi: i64) -> (usize, usize) {
        let wc = self.word_count() as i64;
        if wc == 0 {
            return (0, 0);
        }
        let lo = lo_wi.clamp(0, wc - 1) as usize;
        let hi = hi_wi.clamp(0, wc - 1) as usize;
        (
            self.word_units[lo] as usize,
            self.word_units[hi + 1] as usize,
        )
    }
}
