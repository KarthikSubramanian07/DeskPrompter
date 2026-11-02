//! Parser contract: blocks, cues, headings, and UTF-16 offsets that line up
//! with JavaScript's `String.prototype.slice`.

use aligner::{parse_script, BlockKind, ParsedScript, TokenKind};

/// What JS `script.slice(start, end)` returns.
fn js_slice(script: &str, start: u32, end: u32) -> String {
    let u: Vec<u16> = script.encode_utf16().collect();
    String::from_utf16(&u[start as usize..end as usize]).expect("offsets split a surrogate pair")
}

fn check_offsets(script: &str, p: &ParsedScript) {
    for b in &p.blocks {
        assert!(b.start <= b.end);
        for t in &b.tokens {
            assert_eq!(js_slice(script, t.start, t.end), t.text, "token {t:?}");
            assert!(
                t.start >= b.start && t.end <= b.end,
                "token {t:?} outside block {}..{}",
                b.start,
                b.end
            );
        }
    }
}

fn texts(p: &ParsedScript) -> Vec<(String, i32)> {
    p.blocks
        .iter()
        .flat_map(|b| b.tokens.iter().map(|t| (t.text.clone(), t.wi)))
        .collect()
}

#[test]
fn utf16_offsets_survive_emoji_accents_cjk_and_typography() {
    let script = "🎬 Ça va? “Smart quotes” and em—dashes… 北京故宫 👩🏽‍💻 naïve café\n\nZwölf Äpfel — 🚀🚀 fin.";
    let p = parse_script(script);
    check_offsets(script, &p);
    let t = texts(&p);
    // The clapper emoji is shown but never tracked.
    assert_eq!(t[0], ("🎬".into(), -1));
    assert_eq!(t[1], ("Ça".into(), 0));
    assert_eq!(t[3], ("“Smart".into(), 2));
    assert!(t.iter().any(|(s, wi)| s == "em—dashes…" && *wi >= 0));
    assert!(t.iter().any(|(s, wi)| s == "北京故宫" && *wi >= 0));
    assert!(t.iter().any(|(s, wi)| s == "👩🏽‍💻" && *wi == -1));
    assert!(t.iter().any(|(s, wi)| s == "—" && *wi == -1));
    assert_eq!(p.blocks.len(), 2);
    assert_eq!(
        p.word_count as usize,
        t.iter().filter(|(_, wi)| *wi >= 0).count()
    );
    // Word indices are dense and ordered.
    let wis: Vec<i32> = t.iter().map(|x| x.1).filter(|w| *w >= 0).collect();
    assert_eq!(wis, (0..wis.len() as i32).collect::<Vec<_>>());
}

#[test]
fn surrogate_pairs_count_as_two_code_units() {
    let script = "😀 a 😀😀 b";
    let p = parse_script(script);
    let toks = &p.blocks[0].tokens;
    assert_eq!(
        (toks[1].text.as_str(), toks[1].start, toks[1].end),
        ("a", 3, 4)
    );
    assert_eq!(
        (toks[3].text.as_str(), toks[3].start, toks[3].end),
        ("b", 10, 11)
    );
    check_offsets(script, &p);
}

#[test]
fn crlf_and_leading_whitespace() {
    let script = "\r\n  Hello there.\r\n  Second line\r\n\r\n\t# Title\r\nLast";
    let p = parse_script(script);
    check_offsets(script, &p);
    let kinds: Vec<BlockKind> = p.blocks.iter().map(|b| b.kind).collect();
    assert_eq!(
        kinds,
        [BlockKind::Para, BlockKind::Heading, BlockKind::Para]
    );
    assert_eq!(
        js_slice(script, p.blocks[0].start, p.blocks[0].end),
        "Hello there.\r\n  Second line"
    );
    assert_eq!(
        js_slice(script, p.blocks[1].start, p.blocks[1].end),
        "# Title"
    );
    assert_eq!(p.word_count, 5);
}

#[test]
fn blocks_split_on_blank_lines_and_single_newlines_are_whitespace() {
    let script = "one two\nthree\n\n\n   \nfour";
    let p = parse_script(script);
    assert_eq!(p.blocks.len(), 2);
    assert_eq!(p.blocks[0].tokens.len(), 3);
    assert_eq!(p.blocks[1].tokens[0].wi, 3);
}

#[test]
fn headings_are_displayed_not_tracked() {
    let script = "# Intro\nHello world.\n## Part two ##\nMore words";
    let p = parse_script(script);
    check_offsets(script, &p);
    let kinds: Vec<BlockKind> = p.blocks.iter().map(|b| b.kind).collect();
    // A heading line splits the paragraph around it even without blank lines.
    assert_eq!(
        kinds,
        [
            BlockKind::Heading,
            BlockKind::Para,
            BlockKind::Heading,
            BlockKind::Para
        ]
    );
    let h = &p.blocks[0];
    assert_eq!(h.tokens.len(), 1);
    assert_eq!(
        (h.tokens[0].text.as_str(), h.tokens[0].kind, h.tokens[0].wi),
        ("Intro", TokenKind::Word, -1)
    );
    assert!(p.blocks[2].tokens.iter().all(|t| t.wi == -1));
    assert_eq!(p.blocks[1].tokens[0].wi, 0);
    assert_eq!(p.blocks[3].tokens[0].wi, 2);
    assert_eq!(p.word_count, 4);
}

#[test]
fn cues_span_spaces_and_glue_to_words() {
    let script =
        "Hello [look at camera] world.[beat]Next [smile],\n[slow\ndown] end [unclosed bracket";
    let p = parse_script(script);
    check_offsets(script, &p);
    let t: Vec<(String, TokenKind, i32)> = p
        .blocks
        .iter()
        .flat_map(|b| b.tokens.iter().map(|t| (t.text.clone(), t.kind, t.wi)))
        .collect();
    let cue = |s: &str| (s.to_string(), TokenKind::Cue, -1);
    let word = |s: &str, wi: i32| (s.to_string(), TokenKind::Word, wi);
    assert_eq!(
        t,
        vec![
            word("Hello", 0),
            cue("[look at camera]"),
            word("world.", 1),
            cue("[beat]"),
            word("Next", 2),
            cue("[smile]"),
            word(",", -1),
            word("[slow", 3),
            word("down]", 4),
            word("end", 5),
            word("[unclosed", 6),
            word("bracket", 7),
        ]
    );
}

#[test]
fn cues_inside_headings_and_empty_input() {
    let p = parse_script("# Act one [lights up]");
    assert_eq!(p.blocks[0].tokens.last().unwrap().kind, TokenKind::Cue);
    assert_eq!(p.word_count, 0);
    let empty = parse_script("");
    assert!(empty.blocks.is_empty());
    assert_eq!(empty.word_count, 0);
    assert!(parse_script("\n\n  \n").blocks.is_empty());
    let only_hash = parse_script("#");
    assert_eq!(only_hash.blocks.len(), 1);
    assert!(only_hash.blocks[0].tokens.is_empty());
}

#[test]
fn numbers_and_symbols_are_spoken_words() {
    let p = parse_script("In 2026 we grew 50% — to $20M.");
    let t = texts(&p);
    assert_eq!(t.iter().filter(|x| x.1 >= 0).count(), 7, "{t:?}");
    assert_eq!(t[5], ("—".into(), -1));
}

#[test]
fn serializes_to_contract_shape() {
    let v = serde_json::to_value(parse_script("# H\nhi [c]")).unwrap();
    assert_eq!(
        v,
        serde_json::json!({
            "blocks": [
                { "kind": "heading", "start": 0, "end": 3,
                  "tokens": [{ "kind": "word", "text": "H", "start": 2, "end": 3, "wi": -1 }] },
                { "kind": "para", "start": 4, "end": 10,
                  "tokens": [
                      { "kind": "word", "text": "hi", "start": 4, "end": 6, "wi": 0 },
                      { "kind": "cue", "text": "[c]", "start": 7, "end": 10, "wi": -1 }
                  ] }
            ],
            "wordCount": 1
        })
    );
}

#[test]
fn hand_written_json_matches_serde() {
    let script = "# Tïtle \"q\"\n\nSay \"hi\" [beat]\\ back\tslash 😀\r\nend";
    let p = parse_script(script);
    let ours: serde_json::Value = serde_json::from_str(&p.to_json()).expect("valid JSON");
    assert_eq!(ours, serde_json::to_value(&p).unwrap());
}
