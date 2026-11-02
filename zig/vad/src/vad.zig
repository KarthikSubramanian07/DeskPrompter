//! DeskPrompter voice gate: a tiny, allocation-free voice-activity detector.
//!
//! Signal chain (per input sample, then per 20 ms frame):
//!
//!   input @ fs ─▶ box decimate ÷D (≈16 kHz) ─▶ HPF 100 Hz ─┬─▶ Σx²  (total energy)
//!                                                          ├─▶ zero crossings
//!                                                          └─▶ HPF 300 ─▶ LPF 3k ─▶ Σx² (speech band)
//!
//!   frame ─▶ dB ─▶ noise floor (rising-minimum tracker)
//!          ─▶ cues: band SNR, ZCR (rejects hiss), spectral steadiness (rejects fans)
//!          ─▶ hysteresis: 60 ms attack, 350 ms hangover ─▶ speaking
//!          ─▶ level: band SNR mapped to 0..1 and smoothed (fast up, slow down)
//!
//! No allocator, no libc, no std.math at runtime: the wasm build stays a few KB.

/// Analysis frame length in seconds. All time constants below assume it.
pub const frame_s: f32 = 0.020;

/// Frames of speech-like signal needed to switch on (3 × 20 ms = 60 ms).
pub const attack_frames: u8 = 3;
/// Frames of hangover after the last speech-like frame (18 × 20 ms = 360 ms).
pub const release_frames: u8 = 18;
/// Initial frames used only to learn the room (300 ms); the gate stays closed.
pub const warmup_frames: u32 = 15;

/// Zero-crossing rate above which a frame is treated as hiss / fricative / white noise.
pub const zcr_max: f32 = 0.30;
/// Mean frame-to-frame change of band energy (dB) below which the signal is "steady".
pub const steady_flux_db: f32 = 1.25;
/// Absolute band-energy floor (dBFS): nothing quieter than this counts, even in digital silence.
pub const abs_floor_db: f32 = -70.0;
/// Extra margin removed from the threshold once speaking (Schmitt trigger).
pub const hold_margin_db: f32 = 4.0;

// Per-frame smoothing coefficients (backward-Euler: k = dt / (tau + dt)).
fn coef(comptime tau_s: f32) f32 {
    return frame_s / (tau_s + frame_s);
}
const k_warm: f32 = 0.3;
const k_floor_fall: f32 = coef(0.05);
const k_floor_rise_speech: f32 = coef(4.0);
const k_floor_rise_noise: f32 = coef(0.3);
const k_flux: f32 = coef(0.3);
const k_level_up: f32 = coef(0.02);
const k_level_down: f32 = coef(0.18);

pub const Flags = struct {
    pub const speaking: u32 = 1;
    pub const changed: u32 = 2;
    pub const frame: u32 = 4;
};

/// Transposed direct form II biquad.
pub const Biquad = struct {
    b0: f32 = 1,
    b1: f32 = 0,
    b2: f32 = 0,
    a1: f32 = 0,
    a2: f32 = 0,
    z1: f32 = 0,
    z2: f32 = 0,

    pub inline fn run(self: *Biquad, x: f32) f32 {
        const y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        return y;
    }

    /// Flush tiny state values so silence never drifts into denormals.
    pub fn flush(self: *Biquad) void {
        if (abs(self.z1) < 1e-20) self.z1 = 0;
        if (abs(self.z2) < 1e-20) self.z2 = 0;
    }

    /// RBJ cookbook, Butterworth Q (1/√2).
    pub fn design(comptime kind: enum { highpass, lowpass }, fc: f32, fs: f32) Biquad {
        const w0: f64 = 2.0 * pi * @as(f64, fc) / @as(f64, fs);
        const s = sin(w0);
        const c = cos(w0);
        const alpha = s / (2.0 * 0.7071067811865476);
        const a0 = 1.0 + alpha;
        const b0: f64, const b1: f64 = switch (kind) {
            .highpass => .{ (1.0 + c) / 2.0, -(1.0 + c) },
            .lowpass => .{ (1.0 - c) / 2.0, 1.0 - c },
        };
        return .{
            .b0 = @floatCast(b0 / a0),
            .b1 = @floatCast(b1 / a0),
            .b2 = @floatCast(b0 / a0),
            .a1 = @floatCast(-2.0 * c / a0),
            .a2 = @floatCast((1.0 - alpha) / a0),
        };
    }
};

pub const Vad = struct {
    // Decimation.
    dec: u32 = 3,
    dec_n: u32 = 0,
    dec_acc: f32 = 0,
    // Framing.
    frame_len: u32 = 320,
    frame_pos: u32 = 0,
    acc_total: f32 = 0,
    acc_band: f32 = 0,
    crossings: u32 = 0,
    prev_pos: bool = false,
    // Filters.
    hp: Biquad = .{},
    band_hp: Biquad = .{},
    band_lp: Biquad = .{},
    // Frame statistics.
    frames: u32 = 0,
    floor_db: f32 = abs_floor_db,
    prev_band_db: f32 = abs_floor_db,
    flux_db: f32 = 0,
    // Outputs.
    level: f32 = 0,
    speaking: bool = false,
    on_count: u8 = 0,
    hang: u8 = 0,
    threshold_db: f32 = 11,

    // Last-frame diagnostics (handy in tests and for tuning).
    last_total_db: f32 = -120,
    last_band_db: f32 = -120,
    last_zcr: f32 = 0,

    pub fn init(sample_rate: f32) Vad {
        const fs_in = if (sample_rate >= 4000) sample_rate else 48000;
        var v: Vad = .{};
        // Integer decimation to roughly 16 kHz: 48k → 16k, 44.1k → 14.7k, 16k → 16k.
        const d = @as(u32, @intFromFloat(fs_in / 16000.0 + 0.5));
        v.dec = if (d < 1) 1 else d;
        const fs = fs_in / @as(f32, @floatFromInt(v.dec));
        v.frame_len = @intFromFloat(fs * frame_s + 0.5);
        v.hp = Biquad.design(.highpass, 100, fs);
        v.band_hp = Biquad.design(.highpass, 300, fs);
        v.band_lp = Biquad.design(.lowpass, @min(3000, fs * 0.45), fs);
        return v;
    }

    /// 0 = only loud, close speech; 1 = picks up soft speech. Default 0.5.
    pub fn setSensitivity(self: *Vad, s: f32) void {
        const c = if (s != s) 0.5 else @max(0, @min(1, s));
        self.threshold_db = 16 - 10 * c;
    }

    /// Feed samples at the input rate. Returns `Flags`.
    pub fn process(self: *Vad, samples: []const f32) u32 {
        const was = self.speaking;
        var flags: u32 = 0;
        for (samples) |x| {
            self.dec_acc += x;
            self.dec_n += 1;
            if (self.dec_n < self.dec) continue;
            const s = self.dec_acc / @as(f32, @floatFromInt(self.dec));
            self.dec_acc = 0;
            self.dec_n = 0;

            const y = self.hp.run(s);
            const b = self.band_lp.run(self.band_hp.run(y));
            self.acc_total += y * y;
            self.acc_band += b * b;
            const pos = y >= 0;
            if (pos != self.prev_pos) self.crossings += 1;
            self.prev_pos = pos;

            self.frame_pos += 1;
            if (self.frame_pos >= self.frame_len) {
                self.endFrame();
                flags |= Flags.frame;
            }
        }
        if (self.speaking) flags |= Flags.speaking;
        if (self.speaking != was) flags |= Flags.changed;
        return flags;
    }

    fn endFrame(self: *Vad) void {
        const n: f32 = @floatFromInt(self.frame_len);
        const total_db = db(self.acc_total / n + 1e-12);
        const band_db = db(self.acc_band / n + 1e-12);
        const zcr = @as(f32, @floatFromInt(self.crossings)) / n;
        self.acc_total = 0;
        self.acc_band = 0;
        self.crossings = 0;
        self.frame_pos = 0;
        self.hp.flush();
        self.band_hp.flush();
        self.band_lp.flush();
        self.last_total_db = total_db;
        self.last_band_db = band_db;
        self.last_zcr = zcr;

        self.frames +|= 1;
        const first = self.frames == 1;
        const warm = self.frames <= warmup_frames;

        // Spectral steadiness: mean |Δ band dB| between frames. Fans and hum barely move;
        // speech rises and falls with every syllable.
        const delta = if (first) 0 else abs(band_db - self.prev_band_db);
        self.prev_band_db = band_db;
        self.flux_db += (@min(delta, 30) - self.flux_db) * k_flux;
        const steady = self.flux_db < steady_flux_db;

        // Decide against the floor as it was before this frame.
        const floor_eff = @max(self.floor_db, abs_floor_db);
        const snr = band_db - floor_eff;
        const voiced = zcr <= zcr_max;
        const need = if (self.speaking) self.threshold_db - hold_margin_db else self.threshold_db;
        const cand = !warm and voiced and snr >= need and (self.speaking or !steady);

        // Noise floor: a minimum tracker that falls fast and rises slowly, faster when the
        // signal above it looks like noise (steady, or not voiced).
        if (first) {
            self.floor_db = band_db;
        } else if (warm) {
            self.floor_db += (band_db - self.floor_db) * k_warm;
        } else if (band_db < self.floor_db) {
            self.floor_db += (band_db - self.floor_db) * k_floor_fall;
        } else {
            const k = if (steady or !voiced) k_floor_rise_noise else k_floor_rise_speech;
            self.floor_db += (band_db - self.floor_db) * k;
        }
        // Never sit below the absolute floor: after digital silence, a fan switching on
        // must not have to climb 50 dB of meaningless headroom before it's absorbed.
        if (self.floor_db < abs_floor_db) self.floor_db = abs_floor_db;

        // Hysteresis.
        if (cand) {
            if (self.on_count < attack_frames) self.on_count += 1;
        } else if (self.on_count > 0) {
            self.on_count -= 1;
        }
        if (!self.speaking) {
            if (self.on_count >= attack_frames) {
                self.speaking = true;
                self.hang = release_frames;
            }
        } else if (cand) {
            self.hang = release_frames;
        } else if (self.hang > 0) {
            self.hang -= 1;
            if (self.hang == 0) {
                self.speaking = false;
                self.on_count = 0;
            }
        }

        // Level: dB above the floor is already perceptual; map ~3..39 dB onto 0..1.
        const target = if (warm) 0 else @max(0, @min(1, (snr - 3) / 36));
        const k = if (target > self.level) k_level_up else k_level_down;
        self.level += (target - self.level) * k;
    }
};

// ───────────────────────── tiny math (no libm in the wasm) ─────────────────────────

const pi: f64 = 3.14159265358979323846;

inline fn abs(x: f32) f32 {
    return if (x < 0) -x else x;
}

/// 10·log10(x) for x > 0, accurate to ~1e-4 dB.
pub fn db(x: f32) f32 {
    const bits: u32 = @bitCast(x);
    const e: i32 = @as(i32, @intCast((bits >> 23) & 0xff)) - 127;
    const m: f32 = @bitCast((bits & 0x007f_ffff) | 0x3f80_0000); // [1, 2)
    const t = (m - 1) / (m + 1);
    const t2 = t * t;
    const ln_m = 2 * t * (1 + t2 * (1.0 / 3.0 + t2 * (1.0 / 5.0 + t2 * (1.0 / 7.0 + t2 / 9.0))));
    const log2x = @as(f32, @floatFromInt(e)) + ln_m * 1.4426950408889634;
    return 3.0102999566398120 * log2x;
}

/// Taylor series, fine for 0 ≤ x ≤ π (filter design only, run once at init).
fn sin(x: f64) f64 {
    const x2 = x * x;
    var term = x;
    var sum = x;
    var i: f64 = 1;
    while (i < 12) : (i += 1) {
        term *= -x2 / ((2 * i) * (2 * i + 1));
        sum += term;
    }
    return sum;
}

fn cos(x: f64) f64 {
    const x2 = x * x;
    var term: f64 = 1;
    var sum: f64 = 1;
    var i: f64 = 1;
    while (i < 12) : (i += 1) {
        term *= -x2 / ((2 * i - 1) * (2 * i));
        sum += term;
    }
    return sum;
}

test "tiny math matches std" {
    const std = @import("std");
    const xs = [_]f32{ 1e-12, 1e-6, 0.001, 0.5, 1, 2, 10, 12345 };
    for (xs) |x| {
        try std.testing.expectApproxEqAbs(10 * std.math.log10(x), db(x), 1e-3);
    }
    var w: f64 = 0;
    while (w <= pi) : (w += 0.1) {
        try std.testing.expectApproxEqAbs(std.math.sin(w), sin(w), 1e-9);
        try std.testing.expectApproxEqAbs(std.math.cos(w), cos(w), 1e-9);
    }
}
