//! The voice-follow tracker: recognizer hypotheses in, script position out.
//!
//! Every feed aligns the last [`TAIL`] heard units against the script with a
//! word-level local alignment (Smith–Waterman over words, fuzzy similarity,
//! rarity weights, gap runs capped at [`MAX_GAP`]). Only paths that end on the
//! newest heard unit (or the one before, with a penalty) count, so the answer
//! is always "where is the reader *now*". Each candidate is then classified:
//!
//! - **follow**: the path starts at or just past where we were (≤ 3 words
//!   ahead): accept on modest evidence.
//! - **near jump** (≤ 30 words): needs 2 strong words starting at a sentence
//!   start, or 3 strong words anywhere, and a clear margin over the
//!   runner-up.
//! - **far jump**: 3 strong words, more evidence, a wider margin, and the
//!   same verdict on 2 consecutive updates.
//! - **backtrack**: any move behind the committed cursor: jump-level
//!   evidence, always confirmed twice, and only committed by a final result.
//!
//! Interim results move only `lead` (speculative, ≥ cursor); finals commit
//! `cursor`. Off-script talk leaves both where they are (`holding`); a long
//! run of it widens the search (`lost`).

use std::collections::HashMap;

use serde::Serialize;

use crate::model::ScriptModel;
use crate::normalize::{is_stopword, text_units};
use crate::similarity::{similarity, Heard};

/* ───────────────────────── knobs ───────────────────────── */

/// Heard units aligned per feed.
pub const TAIL: usize = 8;
/// Longest run of skipped script words or extra heard words inside one path.
pub const MAX_GAP: u8 = 2;
/// Words ahead of the reference position a follow path may start.
const FOLLOW_MAX: i64 = 3;
/// Search window around the reference position, in words.
const WINDOW_BACK: i64 = 40;
const WINDOW_AHEAD: i64 = 300;
const LOST_BACK: i64 = 200;
const LOST_AHEAD: i64 = 1500;
/// "Near" jumps stay within this many words.
const NEAR_WORDS: i64 = 30;
/// A target this close behind the cursor is jitter (a repeated word), not a re-read.
const DEAD_BAND: i64 = 2;
/// Fresh units heard without an accepted move before we call ourselves lost.
const LOST_AFTER_UNITS: u32 = 20;
/// Far-jump seeding: the rarest recent heard word may occur at most this often.
const MAX_SEED_POSITIONS: usize = 64;
/// Final-word history retained.
const HISTORY: usize = 32;

const MATCH_SIM: f32 = 0.7;
const STRONG_SIM: f32 = 0.78;
const STRONG_WEIGHT: f32 = 0.3;
const PREFIX_SIM: f32 = 0.6;
const MISMATCH: f32 = -0.7;
const GAP_HEARD: f32 = 0.6;
const GAP_SCRIPT: f32 = 0.35;
const LAST_WORD_PENALTY: f32 = 0.4;
const CANDIDATE_MIN: f32 = 0.3;

const FOLLOW_MIN_SCORE: f32 = 0.45;
const FOLLOW_NEW_EVIDENCE: f32 = 0.55;
const NEAR_MIN_EVIDENCE: f32 = 0.9;
const NEAR_MARGIN: f32 = 0.4;
const JUMP_MIN_EVIDENCE: f32 = 1.4;
const JUMP_MARGIN: f32 = 0.6;

/* ───────────────────────── public types ───────────────────────── */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackState {
    Tracking,
    Holding,
    Lost,
    Jumped,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct AlignResult {
    pub cursor: i32,
    pub lead: i32,
    pub confidence: f32,
    pub state: TrackState,
    pub changed: bool,
}

/* ───────────────────────── DP internals ───────────────────────── */

#[derive(Clone, Copy, Default)]
struct Cell {
    h: f32,
    /// Σ weight·sim over matched units.
    ev: f32,
    /// Σ weight·sim over matched units past the reference position.
    ev_new: f32,
    /// Σ sim over matched units (for confidence).
    sims: f32,
    /// First matched unit, -1 for an empty cell.
    start: i32,
    strong: u8,
    new_matches: u8,
    /// Consecutive gap-free matches ending here.
    run: u8,
    sgap: u8,
    hgap: u8,
    /// The path's last step matched this cell.
    ends: bool,
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    end_wi: i64,
    start_wi: i64,
    score: f32,
    ev: f32,
    ev_new: f32,
    sims: f32,
    strong: u8,
    new_matches: u8,
    run: u8,
    /// The path ends on the newest heard unit (not the one before it).
    on_last: bool,
}

#[derive(Default)]
struct Scratch {
    rows: [Vec<Cell>; 2],
    prev_last: Vec<Cell>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
struct Pending {
    target: i64,
    votes: u32,
    backward: bool,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Follow,
    Near,
    Far,
    Back,
}

/* ───────────────────────── tracker ───────────────────────── */

pub struct Tracker {
    model: ScriptModel,
    cursor: i64,
    lead: i64,
    state: TrackState,
    history: Vec<Heard>,
    interim: Vec<Heard>,
    last_tail: Vec<String>,
    sim_cache: HashMap<String, Vec<f32>>,
    pending: Option<Pending>,
    miss_units: u32,
    scratch: Scratch,
    cands: Vec<Candidate>,
    /// Why the last feed decided what it did (diagnostics and test messages).
    pub reason: &'static str,
}

impl Tracker {
    pub fn new(script: &str) -> Tracker {
        Tracker {
            model: ScriptModel::new(script),
            cursor: -1,
            lead: -1,
            state: TrackState::Tracking,
            history: Vec::new(),
            interim: Vec::new(),
            last_tail: Vec::new(),
            sim_cache: HashMap::new(),
            pending: None,
            miss_units: 0,
            scratch: Scratch::default(),
            cands: Vec::new(),
            reason: "",
        }
    }

    pub fn model(&self) -> &ScriptModel {
        &self.model
    }

    pub fn word_count(&self) -> u32 {
        self.model.word_count()
    }

    pub fn cursor(&self) -> i32 {
        self.cursor as i32
    }

    pub fn lead(&self) -> i32 {
        self.lead as i32
    }

    pub fn state(&self) -> TrackState {
        self.state
    }

    /// Manual snap: the user tapped a word or scrolled by hand.
    pub fn set_cursor(&mut self, wi: i32) {
        let wc = self.word_count() as i64;
        let wi = (wi as i64).clamp(-1, (wc - 1).max(-1));
        self.cursor = wi;
        self.lead = wi;
        self.state = TrackState::Tracking;
        self.history.clear();
        self.interim.clear();
        self.last_tail.clear();
        self.pending = None;
        self.miss_units = 0;
        self.reason = "manual";
    }

    pub fn feed(&mut self, text: &str, is_final: bool) -> AlignResult {
        let (cursor0, lead0) = (self.cursor, self.lead);
        if self.word_count() == 0 {
            return self.result(cursor0, lead0, 0.0);
        }
        if self.state == TrackState::Jumped {
            self.state = TrackState::Tracking;
        }

        // ---- ingest: rolling buffer of finals + the current utterance ----
        let heard: Vec<Heard> = text_units(text, true).into_iter().map(Heard::new).collect();
        let prev_interim_len = self.interim.len();
        let new_len = heard.len();
        if is_final {
            self.history.extend(heard);
            self.interim.clear();
            if self.history.len() > HISTORY {
                let cut = self.history.len() - HISTORY;
                self.history.drain(..cut);
            }
        } else {
            self.interim = heard;
        }
        let tail: Vec<Heard> = {
            let need = TAIL.saturating_sub(self.interim.len());
            let from = self.history.len().saturating_sub(need);
            let mut t: Vec<Heard> = self.history[from..].to_vec();
            t.extend(self.interim.iter().cloned());
            let cut = t.len().saturating_sub(TAIL);
            t.drain(..cut);
            t
        };
        let tail_keys: Vec<String> = tail.iter().map(|h| h.key.clone()).collect();
        let tail_changed = tail_keys != self.last_tail;
        self.last_tail = tail_keys;
        let fresh = match (tail_changed, is_final) {
            (false, _) => 0,
            // A final usually repeats the last interim; only count what it adds.
            (true, true) => new_len.saturating_sub(prev_interim_len) as u32,
            (true, false) => new_len.saturating_sub(prev_interim_len).max(1) as u32,
        };

        if tail.is_empty() || (!tail_changed && !is_final) {
            self.reason = "no new words";
            return self.result(cursor0, lead0, 0.0);
        }

        // ---- align ----
        self.align(&tail, !is_final);

        // ---- decide ----
        let decision = self.decide(tail_changed, is_final, tail.len());
        let confidence = decision
            .map(|c| (c.sims / tail.len() as f32).clamp(0.0, 1.0))
            .unwrap_or(0.0);
        if is_final {
            // Finals commit whatever the utterance established.
            if self.lead > self.cursor {
                self.cursor = self.lead;
            }
            self.lead = self.cursor;
        }
        if self.cursor == cursor0 && self.lead == lead0 && decision.is_none() {
            self.miss_units += fresh;
            if self.state != TrackState::Lost {
                self.state = if self.miss_units >= LOST_AFTER_UNITS {
                    TrackState::Lost
                } else {
                    TrackState::Holding
                };
            }
        }
        self.result(cursor0, lead0, confidence)
    }

    fn result(&self, cursor0: i64, lead0: i64, confidence: f32) -> AlignResult {
        AlignResult {
            cursor: self.cursor as i32,
            lead: self.lead as i32,
            confidence,
            state: self.state,
            changed: self.cursor != cursor0 || self.lead != lead0,
        }
    }

    /* ───────────── decision ───────────── */

    /// Returns the accepted candidate (if any) after applying it.
    fn decide(&mut self, tail_changed: bool, is_final: bool, tail_len: usize) -> Option<Candidate> {
        let reference = self.lead.max(self.cursor);
        let cursor = self.cursor;
        let anchors = &self.model.anchors;
        let classify = |c: &Candidate| -> Kind {
            if c.end_wi >= cursor && c.start_wi <= reference + 1 + FOLLOW_MAX {
                Kind::Follow
            } else if c.end_wi < cursor {
                Kind::Back
            } else if c.end_wi - reference <= NEAR_WORDS {
                Kind::Near
            } else {
                Kind::Far
            }
        };
        let anchored = |c: &Candidate| {
            c.start_wi >= 0 && anchors.get(c.start_wi as usize).copied().unwrap_or(false)
        };
        let net = |c: &Candidate| -> f32 {
            let kind = classify(c);
            let cost = match kind {
                Kind::Follow => 0.0,
                Kind::Near if anchored(c) => 0.3,
                Kind::Near => 0.6,
                Kind::Back if cursor - c.end_wi <= NEAR_WORDS => 0.9,
                Kind::Back => 1.2,
                Kind::Far => 1.2,
            };
            // Tiny distance term: equal paths resolve to the nearest occurrence.
            c.score - cost - 0.0005 * (c.end_wi - reference).abs() as f32
        };

        let mut best: Option<(Candidate, f32)> = None;
        for c in &self.cands {
            let n = net(c);
            if best.is_none_or(|(_, bn)| n > bn) {
                best = Some((*c, n));
            }
        }
        let Some((best, best_net)) = best else {
            self.reason = "no match";
            return None;
        };
        let rival = self
            .cands
            .iter()
            .filter(|c| (c.end_wi - best.end_wi).abs() > 3)
            .map(net)
            .fold(0.0f32, f32::max);
        let margin = best_net - rival;
        let kind = classify(&best);
        let target = best.end_wi;

        match kind {
            Kind::Follow => {
                if best.score < FOLLOW_MIN_SCORE {
                    self.reason = "weak follow";
                    return None;
                }
                // Moving forward needs real new evidence: the newest word directly
                // continuing an already-read run (with a solid word or an unbroken
                // sequence), or two new matches. One lone script word heard out of
                // nowhere is how ad-libs sneak the cursor forward.
                let continues_run = best.run >= 2 && best.start_wi <= reference;
                // Exception: the very first word after a (re)start, exactly where expected.
                let clean_start = tail_len == 1
                    && best.start_wi == reference + 1
                    && best.ev_new >= FOLLOW_NEW_EVIDENCE;
                let enough = best.new_matches >= 2 || continues_run || clean_start;
                if target > reference && !enough {
                    self.reason = "follow lacks new evidence";
                    return None;
                }
                if target <= reference && !best.on_last {
                    self.reason = "newest word unmatched";
                    return None;
                }
                if target <= reference && !tail_changed && !is_final {
                    self.reason = "steady";
                    return None;
                }
                self.pending = None;
                self.reason = "follow";
                self.apply(target, is_final, TrackState::Tracking);
                Some(best)
            }
            Kind::Near => {
                let quick = anchored(&best) && best.strong >= 2;
                let solid = best.strong >= 3;
                if (quick || solid) && best.ev >= NEAR_MIN_EVIDENCE && margin >= NEAR_MARGIN {
                    self.pending = None;
                    self.reason = "near jump";
                    self.apply(target, is_final, TrackState::Jumped);
                    Some(best)
                } else {
                    self.reason = "weak near jump";
                    None
                }
            }
            Kind::Far => {
                if best.strong >= 3 && best.ev >= JUMP_MIN_EVIDENCE && margin >= JUMP_MARGIN {
                    if self.vote(target, false, tail_changed || is_final) >= 2 {
                        self.pending = None;
                        self.reason = "far jump";
                        self.apply(target, is_final, TrackState::Jumped);
                        return Some(best);
                    }
                    self.reason = "far jump pending";
                } else {
                    self.reason = "weak far jump";
                }
                None
            }
            Kind::Back => {
                if cursor - target <= DEAD_BAND {
                    self.reason = "dead band";
                    // Matching right where we are: tracking, not holding.
                    self.state = TrackState::Tracking;
                    self.miss_units = 0;
                    return None;
                }
                let near = cursor - target <= NEAR_WORDS;
                let ok = if near {
                    best.ev >= NEAR_MIN_EVIDENCE
                        && margin >= NEAR_MARGIN
                        && ((anchored(&best) && best.strong >= 2) || best.strong >= 3)
                } else {
                    best.strong >= 3 && best.ev >= JUMP_MIN_EVIDENCE && margin >= JUMP_MARGIN
                };
                if !ok {
                    self.reason = "weak backtrack";
                    return None;
                }
                let votes = self.vote(target, true, tail_changed || is_final);
                if votes >= 2 && is_final {
                    self.pending = None;
                    self.reason = "backtrack";
                    self.cursor = target;
                    self.lead = target;
                    self.state = TrackState::Jumped;
                    self.miss_units = 0;
                    return Some(best);
                }
                self.reason = "backtrack pending";
                None
            }
        }
    }

    /// Register a jump verdict; returns how many consecutive updates agree.
    fn vote(&mut self, target: i64, backward: bool, counts: bool) -> u32 {
        match self.pending {
            Some(ref mut p)
                if p.backward == backward && (-1..=6).contains(&(target - p.target)) =>
            {
                if counts {
                    p.votes += 1;
                }
                p.target = target;
                p.votes
            }
            _ => {
                self.pending = Some(Pending {
                    target,
                    votes: 1,
                    backward,
                });
                1
            }
        }
    }

    fn apply(&mut self, target: i64, is_final: bool, state: TrackState) {
        if is_final {
            self.cursor = target.max(self.cursor);
            self.lead = self.cursor;
        } else {
            self.lead = target.max(self.cursor);
        }
        self.state = state;
        self.miss_units = 0;
    }

    /* ───────────── alignment ───────────── */

    fn align(&mut self, tail: &[Heard], allow_prefix: bool) {
        self.cands.clear();
        let m = tail.len();
        let model = &self.model;
        let reference = self.lead.max(self.cursor);
        let lost = self.state == TrackState::Lost;
        let (back, ahead) = if lost {
            (LOST_BACK, LOST_AHEAD)
        } else {
            (WINDOW_BACK, WINDOW_AHEAD)
        };
        let base = reference.max(0);
        let mut ranges: Vec<(usize, usize)> = vec![model.unit_range(base - back, base + ahead)];

        // Far-jump seeds: occurrences of the rarest recent content word.
        let mut rarest: Option<Vec<u32>> = None;
        let (wlo, whi) = ranges[0];
        for h in tail.iter().rev().take(4) {
            if is_stopword(&h.key) || h.chars.len() < 3 {
                continue;
            }
            let mut pos: Vec<u32> = Vec::new();
            if let Some(&id) = model.vocab_ids.get(&h.key) {
                pos.extend_from_slice(&model.postings[id as usize]);
            }
            if !h.phon.is_empty() {
                if let Some(ids) = model.phon_ids.get(&h.phon) {
                    for &id in ids {
                        if model.vocab[id as usize].key != h.key {
                            pos.extend_from_slice(&model.postings[id as usize]);
                        }
                    }
                }
            }
            if pos.is_empty() || pos.len() > MAX_SEED_POSITIONS {
                continue;
            }
            if rarest.as_ref().is_none_or(|r| pos.len() < r.len()) {
                rarest = Some(pos);
            }
        }
        if let Some(pos) = rarest {
            let span = (MAX_GAP as usize + 1) * TAIL;
            for p in pos {
                let p = p as usize;
                if p >= wlo && p < whi {
                    continue;
                }
                let a = p.saturating_sub(span);
                let b = (p + span / 2 + 2).min(model.units.len());
                ranges.push((a, b));
            }
        }
        ranges.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::with_capacity(ranges.len());
        for r in ranges {
            match merged.last_mut() {
                Some(last) if r.0 <= last.1 => last.1 = last.1.max(r.1),
                _ => merged.push(r),
            }
        }

        // Similarity rows: one per heard key, kept while the key stays in the tail.
        self.sim_cache
            .retain(|k, _| tail.iter().any(|h| &h.key == k));
        let vlen = model.vocab.len();
        for h in tail {
            self.sim_cache
                .entry(h.key.clone())
                .or_insert_with(|| vec![f32::NAN; vlen]);
        }
        for &(a, b) in &merged {
            for h in tail {
                let row = self.sim_cache.get_mut(&h.key).unwrap();
                for u in &model.units[a..b] {
                    let v = u.vocab as usize;
                    if row[v].is_nan() {
                        row[v] = similarity(h, &model.vocab[v]);
                    }
                }
            }
        }
        let sims: Vec<&[f32]> = tail
            .iter()
            .map(|h| self.sim_cache[&h.key].as_slice())
            .collect();
        let ref_unit_end = if reference < 0 {
            0
        } else {
            model.unit_range(reference, reference).1
        };

        for &(a, b) in &merged {
            dp(
                model,
                tail,
                &sims,
                a,
                b,
                m,
                allow_prefix,
                ref_unit_end,
                &mut self.scratch,
                &mut self.cands,
            );
        }
    }
}

/// Local alignment of the heard tail onto `units[a..b]`, pushing candidates
/// for paths ending on the last (or second-to-last) heard unit.
#[allow(clippy::too_many_arguments, clippy::needless_range_loop)]
fn dp(
    model: &ScriptModel,
    tail: &[Heard],
    sims: &[&[f32]],
    a: usize,
    b: usize,
    m: usize,
    allow_prefix: bool,
    ref_unit_end: usize,
    scratch: &mut Scratch,
    out: &mut Vec<Candidate>,
) {
    let w = b - a;
    if w == 0 || m == 0 {
        return;
    }
    let empty = Cell {
        start: -1,
        ..Cell::default()
    };
    for r in scratch.rows.iter_mut() {
        r.clear();
        r.resize(w + 1, empty);
    }
    scratch.prev_last.clear();
    scratch.prev_last.resize(w + 1, empty);

    let units = &model.units;
    let last_heard = &tail[m - 1];
    let prefix_ok = allow_prefix && last_heard.chars.len() >= 3;

    for i in 0..m {
        let (lo, hi) = scratch.rows.split_at_mut(1);
        let (prev, cur) = if i % 2 == 0 {
            (&lo[0], &mut hi[0])
        } else {
            (&hi[0], &mut lo[0])
        };
        // `prev` holds row i-1 (all empty for i = 0).
        let srow = sims[i];
        cur[0] = empty;
        for j in 1..=w {
            let pos = a + j - 1;
            let u = units[pos];
            let mut weight = u.weight;
            let mut sim = srow[u.vocab as usize];
            let mut is_match = sim >= MATCH_SIM;
            let mut is_prefix = false;
            if !is_match && prefix_ok && i == m - 1 {
                let v = &model.vocab[u.vocab as usize];
                if v.chars.len() > last_heard.chars.len() && v.key.starts_with(&last_heard.key) {
                    is_match = true;
                    is_prefix = true;
                    sim = PREFIX_SIM;
                    weight *= 0.5;
                }
            }
            let strong = is_match && !is_prefix && sim >= STRONG_SIM && u.weight >= STRONG_WEIGHT;
            let is_new = pos >= ref_unit_end;

            let d = prev[j - 1];
            let up = prev[j];
            let left = cur[j - 1];

            let mut best = empty;
            // Diagonal: match or substitution.
            if is_match {
                let gain = weight * (1.0 + sim);
                let h = d.h.max(0.0) + gain;
                let fresh = d.h <= 0.0;
                let ev = weight * sim;
                best = Cell {
                    h,
                    ev: if fresh { 0.0 } else { d.ev } + ev,
                    ev_new: if fresh { 0.0 } else { d.ev_new } + if is_new { ev } else { 0.0 },
                    sims: if fresh { 0.0 } else { d.sims } + sim,
                    start: if fresh { pos as i32 } else { d.start },
                    strong: if fresh { 0 } else { d.strong } + u8::from(strong),
                    new_matches: if fresh { 0 } else { d.new_matches } + u8::from(is_new),
                    run: if d.ends && !fresh {
                        d.run.saturating_add(1)
                    } else {
                        1
                    },
                    sgap: 0,
                    hgap: 0,
                    ends: true,
                };
            } else if d.h > 0.0 && d.sgap < MAX_GAP && d.hgap < MAX_GAP {
                let h = d.h + MISMATCH;
                if h > best.h {
                    best = Cell {
                        h,
                        sgap: d.sgap + 1,
                        hgap: d.hgap + 1,
                        run: 0,
                        ends: false,
                        ..d
                    };
                }
            }
            // Up: an extra heard word (ad-lib, misrecognition).
            if up.h > 0.0 && up.hgap < MAX_GAP {
                let h = up.h - GAP_HEARD;
                if h > best.h {
                    best = Cell {
                        h,
                        hgap: up.hgap + 1,
                        run: 0,
                        ends: false,
                        ..up
                    };
                }
            }
            // Left: a skipped script word (cheap for function words).
            if left.h > 0.0 && left.sgap < MAX_GAP {
                let h = left.h - GAP_SCRIPT * u.weight.max(0.1);
                if h > best.h {
                    best = Cell {
                        h,
                        sgap: left.sgap + 1,
                        run: 0,
                        ends: false,
                        ..left
                    };
                }
            }
            if best.h <= 0.0 {
                best = empty;
            }
            cur[j] = best;
        }
        if i + 2 == m {
            scratch.prev_last.copy_from_slice(cur);
        }
    }
    let last = if (m - 1).is_multiple_of(2) {
        &scratch.rows[1]
    } else {
        &scratch.rows[0]
    };
    for j in 1..=w {
        let mut pick: Option<(Cell, f32, bool)> = None;
        let c = last[j];
        if c.ends && c.h > CANDIDATE_MIN {
            pick = Some((c, c.h, true));
        }
        if m >= 2 {
            let p = scratch.prev_last[j];
            let s = p.h - LAST_WORD_PENALTY;
            if p.ends && s > CANDIDATE_MIN && pick.is_none_or(|(_, ps, _)| s > ps) {
                pick = Some((p, s, false));
            }
        }
        if let Some((c, score, on_last)) = pick {
            let end_unit = a + j - 1;
            out.push(Candidate {
                end_wi: units[end_unit].wi as i64,
                start_wi: units[c.start.max(0) as usize].wi as i64,
                score,
                ev: c.ev,
                ev_new: c.ev_new,
                sims: c.sims,
                strong: c.strong,
                new_matches: c.new_matches,
                run: c.run,
                on_last,
            });
        }
    }
}
