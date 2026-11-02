#![allow(dead_code)]
//! Shared harness: a fake recognizer that speaks phrases the way real engines
//! report them (growing interim hypotheses, then a final), and checks the
//! tracker's contract on every single feed.

use aligner::{parse_script, AlignResult, TrackState, Tracker};

pub const SPEECH: &str = "# Opening

Good evening, everyone, and welcome to the 2026 Northwind product showcase. My name is Priya, and tonight I want to walk you through three ideas that changed how our team builds software.

[pause]

The first idea is simple: write less code. Every line you write is a line someone has to read, test, and maintain for years. Their time matters more than our cleverness.

The second idea is about listening. We interviewed four hundred customers across eleven countries, and almost every conversation came back to the same complaint: tools that interrupt instead of help.

## Results

So we rebuilt the dashboard from scratch. Load times dropped by 50%, support tickets fell by a third, and the night shift in Rotterdam finally stopped calling us at three in the morning.

The third idea is the hardest one. Ship small, ship often, and tell people the truth about what broke. Trust is built in drops and lost in buckets.

Thank you for being here tonight. Thank you for your patience, your feedback, and your stubborn belief that software can be kind.";

/// Lowercase, letters and digits only: how tests name script words.
pub fn plain(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Spoken words of a script, in word-index order.
pub fn spoken_words(script: &str) -> Vec<String> {
    let parsed = parse_script(script);
    let mut out = Vec::new();
    for b in &parsed.blocks {
        for t in &b.tokens {
            if t.wi >= 0 {
                assert_eq!(t.wi as usize, out.len());
                out.push(plain(&t.text));
            }
        }
    }
    out
}

/// Word index of the last word of `phrase`, at its `nth` occurrence (0-based).
pub fn wi_of(script: &str, phrase: &str, nth: usize) -> i32 {
    let words = spoken_words(script);
    let needle: Vec<String> = phrase.split_whitespace().map(plain).collect();
    let mut seen = 0;
    for s in 0..=words.len().saturating_sub(needle.len()) {
        if words[s..s + needle.len()] == needle[..] {
            if seen == nth {
                return (s + needle.len() - 1) as i32;
            }
            seen += 1;
        }
    }
    panic!("phrase {phrase:?} (#{nth}) not in script");
}

/// The script text of words `a..=b`.
pub fn span(script: &str, a: i32, b: i32) -> String {
    spoken_words(script)[a as usize..=b as usize].join(" ")
}

pub struct Rig {
    pub t: Tracker,
    pub last: AlignResult,
    pub feeds: usize,
    /// Largest cursor ever reported.
    pub max_cursor: i32,
}

impl Rig {
    pub fn new(script: &str) -> Rig {
        let t = Tracker::new(script);
        let last = AlignResult {
            cursor: -1,
            lead: -1,
            confidence: 0.0,
            state: TrackState::Tracking,
            changed: false,
        };
        Rig {
            t,
            last,
            feeds: 0,
            max_cursor: -1,
        }
    }

    /// Feed one hypothesis and enforce the contract.
    pub fn feed(&mut self, text: &str, is_final: bool) -> AlignResult {
        let before = self.last;
        let r = self.t.feed(text, is_final);
        self.feeds += 1;
        let ctx = format!(
            "feed #{} {:?} final={} → {:?} ({})",
            self.feeds, text, is_final, r, self.t.reason
        );
        assert!(r.lead >= r.cursor, "lead < cursor: {ctx}");
        assert!(
            r.cursor >= -1 && (r.cursor as i64) < self.t.word_count() as i64,
            "cursor out of range: {ctx}"
        );
        assert!(
            (0.0..=1.0).contains(&r.confidence),
            "confidence out of range: {ctx}"
        );
        if !is_final {
            assert_eq!(r.cursor, before.cursor, "interim moved the cursor: {ctx}");
        }
        if r.cursor < before.cursor {
            assert!(
                is_final && r.state == TrackState::Jumped,
                "cursor went backwards without a backtrack: {ctx}"
            );
        }
        assert_eq!(
            r.changed,
            r.cursor != before.cursor || r.lead != before.lead,
            "changed flag wrong: {ctx}"
        );
        self.max_cursor = self.max_cursor.max(r.cursor);
        self.last = r;
        r
    }

    /// Speak a phrase: interim hypotheses grow word by word, then the final.
    pub fn say(&mut self, phrase: &str) -> AlignResult {
        let words: Vec<&str> = phrase.split_whitespace().collect();
        for k in 1..=words.len() {
            self.feed(&words[..k].join(" "), false);
        }
        self.feed(phrase, true)
    }

    /// Speak a long passage as several utterances of about `n` words.
    pub fn read(&mut self, passage: &str, n: usize) -> AlignResult {
        let words: Vec<&str> = passage.split_whitespace().collect();
        let mut r = self.last;
        for chunk in words.chunks(n.max(1)) {
            r = self.say(&chunk.join(" "));
        }
        r
    }

    pub fn reason(&self) -> &'static str {
        self.t.reason
    }
}
