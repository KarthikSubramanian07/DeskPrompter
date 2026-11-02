//! Adversarial voice-follow scenarios. Every feed also passes the contract
//! checks in `common::Rig::feed` (lead ≥ cursor, interims never move the
//! cursor, the cursor only goes back on a final backtrack, `changed` honest).

mod common;
use aligner::TrackState;
use common::*;

fn rig() -> Rig {
    Rig::new(SPEECH)
}

fn w(phrase: &str) -> i32 {
    wi_of(SPEECH, phrase, 0)
}

#[test]
fn straight_read_word_by_word_with_interims() {
    let mut r = rig();
    let all = spoken_words(SPEECH).join(" ");
    // Utterances of 7 words, each reported as growing interims, then a final.
    let res = r.read(&all, 7);
    assert_eq!(
        res.cursor,
        spoken_words(SPEECH).len() as i32 - 1,
        "ended at {res:?} ({})",
        r.reason()
    );
    assert_eq!(res.state, TrackState::Tracking);
}

#[test]
fn lead_tracks_every_interim_word() {
    let mut r = rig();
    let words = spoken_words(SPEECH);
    let phrase = words[..9].join(" ");
    let parts: Vec<&str> = phrase.split_whitespace().collect();
    for k in 2..=parts.len() {
        let res = r.feed(&parts[..k].join(" "), false);
        assert_eq!(
            res.lead,
            k as i32 - 1,
            "after {k} words: {res:?} ({})",
            r.reason()
        );
        assert_eq!(res.cursor, -1);
    }
    let res = r.feed(&phrase, true);
    assert_eq!((res.cursor, res.lead), (8, 8));
}

#[test]
fn straight_read_in_one_long_utterance() {
    // Some engines keep a single utterance open for a whole paragraph.
    let mut r = rig();
    let words = spoken_words(SPEECH);
    let para = words[..60].join(" ");
    let res = r.say(&para);
    assert_eq!(res.cursor, 59, "{res:?} ({})", r.reason());
}

#[test]
fn skipping_a_sentence_lands_on_the_next_one() {
    let mut r = rig();
    r.read(
        "good evening everyone and welcome to the 2026 northwind product showcase",
        6,
    );
    assert_eq!(r.last.cursor, w("product showcase"));
    // Skip "My name is Priya ... builds software." entirely.
    let res = r.say("the first idea is simple write less code");
    assert_eq!(res.cursor, w("write less code"), "{res:?} ({})", r.reason());
    let res = r.say("every line you write is a line someone has to read");
    assert_eq!(res.cursor, w("has to read"), "{res:?} ({})", r.reason());
}

#[test]
fn skipping_a_paragraph_is_a_near_jump() {
    let mut r = rig();
    let start = w("the second idea");
    r.t.set_cursor(start - 3);
    r.last.cursor = start - 3;
    r.last.lead = start - 3;
    // Reader skips the whole second-idea paragraph and the heading.
    let res = r.say("so we rebuilt the dashboard from scratch");
    assert_eq!(
        res.cursor,
        w("dashboard from scratch"),
        "{res:?} ({})",
        r.reason()
    );
    assert_eq!(res.state, TrackState::Jumped);
    let res = r.say("load times dropped by 50%");
    assert_eq!(res.cursor, w("dropped by 50"), "{res:?}");
    assert_eq!(res.state, TrackState::Tracking);
}

#[test]
fn jumping_back_to_reread_a_sentence() {
    let mut r = rig();
    let to = w("our cleverness");
    let words = spoken_words(SPEECH);
    r.read(
        &words[w("the first idea") as usize - 2..=to as usize].join(" "),
        6,
    );
    assert_eq!(r.last.cursor, to);
    // The reader stumbles and re-reads the previous sentence from its start.
    let res = r.say("every line you write is a line someone has to read");
    assert_eq!(res.cursor, w("has to read"), "{res:?} ({})", r.reason());
    assert_eq!(res.state, TrackState::Jumped);
    // ...and carries on from there.
    let res = r.say("test and maintain for years");
    assert_eq!(
        res.cursor,
        w("maintain for years"),
        "{res:?} ({})",
        r.reason()
    );
}

#[test]
fn a_repeated_word_or_two_does_not_backtrack() {
    let mut r = rig();
    r.read("the first idea is simple write less code", 4);
    let at = r.last.cursor;
    let res = r.say("less code");
    assert_eq!(res.cursor, at, "{res:?} ({})", r.reason());
}

#[test]
fn ad_lib_sentence_holds_position() {
    let mut r = rig();
    r.read("the first idea is simple write less code", 8);
    let at = r.last.cursor;
    let res = r.say("honestly I could talk about this all day but my producer is waving at me");
    assert_eq!(res.cursor, at, "{res:?} ({})", r.reason());
    assert_eq!(res.lead, at);
    assert_eq!(res.state, TrackState::Holding);
    // Back on script: picks up right where we left off.
    let res = r.say("every line you write is a line");
    assert_eq!(res.cursor, w("is a line"), "{res:?} ({})", r.reason());
    assert_eq!(res.state, TrackState::Tracking);
}

#[test]
fn ad_lib_full_of_script_words_does_not_lurch() {
    // Off-script talk that reuses common script vocabulary out of order.
    let mut r = rig();
    r.read("the first idea is simple write less code", 8);
    let at = r.last.cursor;
    let res = r.say("you know the idea about code is that it is simple to read");
    assert!(
        res.cursor <= at + 3 && res.cursor >= at,
        "lurched to {res:?} ({})",
        r.reason()
    );
}

#[test]
fn long_off_script_talk_goes_lost_then_recovers() {
    let mut r = rig();
    r.read("the first idea is simple write less code", 8);
    let at = r.last.cursor;
    r.say("before we go on let me tell you a quick story about my grandmother");
    r.say("she used to bake bread every sunday morning in a tiny kitchen");
    let res = r.say("and the whole street could smell it from the corner shop");
    assert_eq!(res.state, TrackState::Lost, "{res:?}");
    assert_eq!(res.cursor, at);
    let res = r.say("every line you write is a line someone has to read");
    assert_eq!(res.cursor, w("has to read"), "{res:?} ({})", r.reason());
    assert_eq!(res.state, TrackState::Tracking);
}

#[test]
fn homophones_and_mishearings_still_track() {
    let mut r = rig();
    r.read("the first idea is simple", 5);
    // write→right, their→there, for→four's opposite, test→text, cleverness→cleverest
    let res = r.say("right less code every line you right is a line someone has to read");
    assert_eq!(res.cursor, w("has to read"), "{res:?} ({})", r.reason());
    let res = r.say("text and maintain four years there time matters more than our cleverest");
    assert_eq!(res.cursor, w("our cleverness"), "{res:?} ({})", r.reason());
    let res = r.say("the second idea is about listening we interviewed for hundred customers");
    assert_eq!(
        res.cursor,
        w("four hundred customers"),
        "{res:?} ({})",
        r.reason()
    );
}

#[test]
fn dropped_words_and_inserted_fillers() {
    let mut r = rig();
    // Recognizer drops "and", reader inserts fillers and a stray word.
    let res =
        r.say("um good evening everyone uh welcome to the uh 2026 northwind like product showcase");
    assert_eq!(
        res.cursor,
        w("product showcase"),
        "{res:?} ({})",
        r.reason()
    );
}

#[test]
fn repeated_structure_does_not_lurch_to_the_wrong_idea() {
    // "The first/second/third idea is ..." – reading the third must not snap to the first,
    // and reading the first must not run ahead to the third.
    let mut r = rig();
    r.read("the first idea is simple write less code", 3);
    assert_eq!(r.last.cursor, w("write less code"));
    assert!(r.max_cursor <= w("write less code"));
    let third = w("the third idea");
    r.t.set_cursor(third - 3);
    r.last.cursor = third - 3;
    r.last.lead = third - 3;
    let res = r.say("the third idea is the hardest one");
    assert_eq!(res.cursor, w("the hardest one"), "{res:?} ({})", r.reason());
}

#[test]
fn repeated_phrase_resolves_to_the_nearest_occurrence() {
    let mut r = rig();
    let first = w("thank you for being") - 3;
    r.t.set_cursor(first - 1);
    r.last.cursor = first - 1;
    r.last.lead = first - 1;
    // "Thank you for" occurs twice, five words apart.
    let res = r.say("thank you for");
    assert_eq!(
        res.cursor,
        w("thank you for being") - 1,
        "{res:?} ({})",
        r.reason()
    );
    let res = r.say("being here tonight");
    assert_eq!(res.cursor, w("here tonight"));
    let res = r.say("thank you for");
    assert_eq!(
        res.cursor,
        wi_of(SPEECH, "thank you for", 1),
        "{res:?} ({})",
        r.reason()
    );
}

#[test]
fn refrain_repeated_back_to_back() {
    let script = "We will rise. We will rise. We will rise again tomorrow, together.";
    let mut r = Rig::new(script);
    let res = r.say("we will rise");
    assert_eq!(res.cursor, 2, "{res:?} ({})", r.reason());
    let res = r.say("we will rise");
    assert_eq!(res.cursor, 5, "{res:?} ({})", r.reason());
    let res = r.say("we will rise again");
    assert_eq!(res.cursor, 9, "{res:?} ({})", r.reason());
}

#[test]
fn numbers_match_digits_and_words_both_ways() {
    let script = "In 2026 we grew 50% to $20 million across 11 countries.";
    let mut r = Rig::new(script);
    let res = r.say("in twenty twenty six we grew fifty percent to twenty dollars million across eleven countries");
    assert_eq!(res.cursor, 10, "{res:?} ({})", r.reason());

    let spelled = "We interviewed four hundred customers in twenty twenty six.";
    let mut r = Rig::new(spelled);
    let res = r.say("we interviewed 400 customers in 2026");
    assert_eq!(res.cursor, 8, "{res:?} ({})", r.reason());
}

#[test]
fn half_heard_last_word_gets_prefix_credit_but_no_jump() {
    let script =
        "Please welcome our keynote speaker, the brilliant teleprompter inventor Margaret Okafor.";
    let mut r = Rig::new(script);
    r.say("please welcome our keynote speaker the brilliant");
    let res = r.feed("tele", false);
    assert_eq!(
        res.lead,
        7,
        "prefix should nudge lead: {res:?} ({})",
        r.reason()
    );
    let res = r.feed("teleprompter inventor", false);
    assert_eq!(res.lead, 8);
}

#[test]
fn interim_revisions_can_pull_lead_back_but_never_cursor() {
    let mut r = rig();
    r.say("good evening everyone and welcome");
    let c = r.last.cursor;
    let res = r.feed("to the 2026 northwind product", false);
    assert_eq!(res.lead, w("northwind product"));
    // The engine changes its mind about the last words.
    let res = r.feed("to the 2026", false);
    assert!(res.lead >= c && res.lead <= w("the 2026"), "{res:?}");
    let res = r.feed("to the 2026 northwind product showcase", true);
    assert_eq!(res.cursor, w("product showcase"));
}

#[test]
fn far_jump_needs_confirmation() {
    let mut r = rig();
    r.read("good evening everyone and welcome to the 2026", 8);
    let at = r.last.cursor;
    // The reader jumps to the closing lines, far outside the near window.
    let phrase = "your stubborn belief that software can be kind";
    let words: Vec<&str> = phrase.split_whitespace().collect();
    let mut verdicts = Vec::new();
    let mut first_move = None;
    for k in 1..=words.len() {
        let res = r.feed(&words[..k].join(" "), false);
        verdicts.push(r.reason());
        if res.lead != at && first_move.is_none() {
            first_move = Some(k);
            assert_eq!(res.state, TrackState::Jumped);
            assert_eq!(res.lead, wi_of(SPEECH, &words[..k].join(" "), 0), "{res:?}");
        }
    }
    let k = first_move.unwrap_or_else(|| panic!("never jumped: {verdicts:?}"));
    // One convincing update is never enough: the jump is pending first.
    assert!(
        verdicts[..k - 1].contains(&"far jump pending"),
        "{verdicts:?}"
    );
    let res = r.feed(phrase, true);
    assert_eq!(res.cursor, w("can be kind"));
}

#[test]
fn single_rare_word_does_not_teleport() {
    let mut r = rig();
    r.read("good evening everyone and welcome", 5);
    let at = r.last.cursor;
    let res = r.say("rotterdam");
    assert_eq!(res.cursor, at, "{res:?} ({})", r.reason());
    let res = r.say("i love rotterdam buckets");
    assert_eq!(res.cursor, at, "{res:?} ({})", r.reason());
}

#[test]
fn starting_mid_script_without_a_cursor() {
    let mut r = rig();
    let res = r.read(
        "so we rebuilt the dashboard from scratch load times dropped",
        5,
    );
    assert_eq!(
        res.cursor,
        w("load times dropped"),
        "{res:?} ({})",
        r.reason()
    );
}

#[test]
fn manual_set_cursor_resets_context() {
    let mut r = rig();
    r.read("good evening everyone and welcome to the 2026", 8);
    r.t.set_cursor(w("the third idea"));
    assert_eq!(
        (r.t.cursor(), r.t.lead()),
        (w("the third idea"), w("the third idea"))
    );
    r.last.cursor = r.t.cursor();
    r.last.lead = r.t.lead();
    let res = r.say("is the hardest one");
    assert_eq!(res.cursor, w("the hardest one"), "{res:?} ({})", r.reason());
    r.t.set_cursor(-5);
    assert_eq!(r.t.cursor(), -1);
    r.t.set_cursor(1_000_000);
    assert_eq!(r.t.cursor(), spoken_words(SPEECH).len() as i32 - 1);
}

#[test]
fn identical_resend_changes_nothing() {
    let mut r = rig();
    r.feed("good evening everyone", false);
    let res = r.feed("good evening everyone", false);
    assert!(!res.changed);
    let res = r.feed("good evening everyone", true);
    assert_eq!(res.cursor, 2);
    let res = r.feed("", false);
    assert!(!res.changed);
}

#[test]
fn final_commits_lead_even_if_it_ends_off_script() {
    let mut r = rig();
    r.feed("good evening everyone and welcome to the", false);
    let res = r.feed(
        "good evening everyone and welcome to the uh whatever banana",
        true,
    );
    assert_eq!(res.cursor, w("welcome to the"), "{res:?} ({})", r.reason());
}

#[test]
fn empty_and_cue_only_scripts_never_panic() {
    for script in ["", "[pause]", "# Only a heading", "— … 🎬"] {
        let mut r = Rig::new(script);
        let res = r.say("hello there everyone");
        assert_eq!((res.cursor, res.lead), (-1, -1));
        r.t.set_cursor(3);
        assert_eq!(r.t.cursor(), -1);
    }
}

#[test]
fn cjk_script_follows_character_by_character() {
    let script = "今天我们讨论人工智能。明天我们去北京。";
    let mut r = Rig::new(script);
    let res = r.say("今天我们讨论人工智能");
    // One word token per whitespace chunk, so the whole sentence is word 0.
    assert_eq!(res.cursor, 0, "{res:?} ({})", r.reason());
}

#[test]
fn accents_and_case_are_ignored() {
    let script = "Le café naïve de Zoë est très bon.";
    let mut r = Rig::new(script);
    let res = r.say("le cafe naive de zoe est tres bon");
    assert_eq!(res.cursor, 7, "{res:?} ({})", r.reason());
}

#[test]
fn speaker_reads_a_paragraph_with_one_skipped_word_per_sentence() {
    let mut r = rig();
    // Skips "and", "the", "someone" – the reader paraphrases slightly.
    r.read("the first idea is simple write less code every line you write is a line has to read test maintain for years", 6);
    assert_eq!(r.last.cursor, w("maintain for years"), "({})", r.reason());
}

#[test]
fn backtrack_needs_two_agreeing_updates() {
    // Engines without interims (final-only): one re-read phrase is not enough.
    let mut r = rig();
    let words = spoken_words(SPEECH);
    r.read(
        &words[w("the first idea") as usize - 2..=w("our cleverness") as usize].join(" "),
        6,
    );
    let at = r.last.cursor;
    let res = r.feed("every line you write is a line", true);
    assert_eq!(
        res.cursor,
        at,
        "backtracked on a single update: {res:?} ({})",
        r.reason()
    );
    assert_eq!(r.reason(), "backtrack pending");
    let res = r.feed("someone has to read", true);
    assert_eq!(res.cursor, w("has to read"), "{res:?} ({})", r.reason());
    assert_eq!(res.state, TrackState::Jumped);
}

#[test]
fn quoting_an_earlier_phrase_in_an_ad_lib_does_not_backtrack() {
    let mut r = rig();
    let words = spoken_words(SPEECH);
    r.read(
        &words[w("the first idea") as usize - 2..=w("our cleverness") as usize].join(" "),
        6,
    );
    let at = r.last.cursor;
    // One brief callback, then off-script again: votes never agree twice.
    r.feed("like I said write less code", true);
    let res = r.feed("okay where was I", true);
    assert_eq!(res.cursor, at, "{res:?} ({})", r.reason());
}

#[test]
fn align_result_serializes_to_contract_shape() {
    let r = aligner::Tracker::new("hello world").feed("hello", false);
    let v = serde_json::to_value(r).unwrap();
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(keys.len(), 5);
    for k in ["cursor", "lead", "confidence", "state", "changed"] {
        assert!(v.get(k).is_some(), "missing {k}");
    }
    assert_eq!(v["state"], "tracking");
}
