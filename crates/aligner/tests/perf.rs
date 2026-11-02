//! Performance budget: a feed on a 10,000-word script must stay far below
//! 2 ms in release wasm. Native release is ~2–4× faster than wasm, so the
//! native release budget here is 0.5 ms per feed on average; debug builds
//! (plain `cargo test`) only get a loose sanity bound.

mod common;
use std::time::Instant;

use aligner::Tracker;

/// Deterministic pseudo-English: a Zipf-ish mix of function words and a
/// 3,000-word invented vocabulary, with sentence breaks and paragraphs.
fn synth_script(words: usize) -> String {
    const FUNCTION: &[&str] = &[
        "the", "a", "and", "of", "to", "in", "is", "that", "we", "it", "for", "on", "with", "as",
        "you",
    ];
    const SYL: &[&str] = &[
        "ka", "lo", "mi", "ren", "tor", "sa", "vel", "qu", "ne", "dra", "pin", "zo", "bel", "cor",
        "fu", "gan",
    ];
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let vocab: Vec<String> = (0..3000)
        .map(|i| {
            let mut w = String::new();
            let mut n = i + 7;
            for _ in 0..(2 + i % 3) {
                w.push_str(SYL[n % SYL.len()]);
                n = n / SYL.len() + 3;
            }
            w
        })
        .collect();
    let mut out = String::new();
    for k in 0..words {
        let r = rnd();
        let word = if r % 10 < 4 {
            FUNCTION[(r >> 8) as usize % FUNCTION.len()].to_string()
        } else {
            // Skewed toward the head of the vocabulary.
            let a = (r >> 16) as usize % vocab.len();
            let b = (r >> 32) as usize % vocab.len();
            vocab[a.min(b)].clone()
        };
        out.push_str(&word);
        if k % 13 == 12 {
            out.push('.');
        }
        out.push(if k % 120 == 119 { '\n' } else { ' ' });
        if k % 120 == 119 {
            out.push('\n');
        }
    }
    out
}

#[test]
fn ten_thousand_words_thousand_feeds() {
    let script = synth_script(10_000);
    let built = Instant::now();
    let mut t = Tracker::new(&script);
    let build_ms = built.elapsed().as_secs_f64() * 1e3;
    assert_eq!(t.word_count(), 10_000);
    let words = common::spoken_words(&script);

    // Read 1,000 feeds' worth from the middle: 4-word utterances as 4 interims + 1 final.
    // Best of three runs, so a busy machine (CI, parallel builds) can't fail the
    // budget through preemption alone.
    let start = 4_000;
    let mut best_avg = f64::MAX;
    let mut best_worst = 0f64;
    let mut feeds = 0usize;
    for _ in 0..3 {
        t.set_cursor(start as i32 - 1);
        feeds = 0;
        let mut pos = start;
        let mut worst = 0f64;
        let begin = Instant::now();
        while feeds < 1000 {
            let utter = &words[pos..pos + 4];
            for k in 1..=5 {
                let f = Instant::now();
                t.feed(&utter[..k.min(4)].join(" "), k == 5);
                worst = worst.max(f.elapsed().as_secs_f64());
                feeds += 1;
            }
            pos += 4;
        }
        let avg = begin.elapsed().as_secs_f64() * 1e3 / feeds as f64;
        if avg < best_avg {
            best_avg = avg;
            best_worst = worst * 1e3;
        }
        // It also has to be *right* while being fast.
        assert_eq!(
            t.cursor() as usize,
            pos - 1,
            "lost track on the synthetic script ({})",
            t.reason
        );
    }
    let (avg_ms, worst_ms) = (best_avg, best_worst);
    println!("10k-word script: build {build_ms:.2} ms, {feeds} feeds, avg {avg_ms:.4} ms, worst {worst_ms:.3} ms (best of 3)");

    let budget = if cfg!(debug_assertions) { 30.0 } else { 0.5 };
    assert!(
        avg_ms < budget,
        "avg feed {avg_ms:.3} ms over budget {budget} ms"
    );
}

#[test]
fn lost_search_on_ten_thousand_words_is_still_fast() {
    let script = synth_script(10_000);
    let mut t = Tracker::new(&script);
    t.set_cursor(100);
    // Off-script chatter until lost, then measure the widened-window feeds.
    for k in 0..10 {
        t.feed(
            &format!("completely unrelated chatter number {k} about weather and lunch"),
            true,
        );
    }
    let mut avg_ms = f64::MAX;
    for round in 0..3 {
        let begin = Instant::now();
        for k in 0..200 {
            t.feed(
                &format!("more unrelated chatter {round} {k} about nothing"),
                k % 4 == 3,
            );
        }
        avg_ms = avg_ms.min(begin.elapsed().as_secs_f64() * 1e3 / 200.0);
    }
    assert_eq!(t.state(), aligner::TrackState::Lost);
    println!("lost-state feeds: avg {avg_ms:.4} ms (best of 3)");
    let budget = if cfg!(debug_assertions) { 60.0 } else { 1.0 };
    assert!(
        avg_ms < budget,
        "avg lost feed {avg_ms:.3} ms over budget {budget} ms"
    );
}
