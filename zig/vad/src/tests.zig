//! Synthetic-signal tests for the voice gate. Run with `zig build test`.
//!
//! Every test drives a fresh detector with 128-sample blocks (the AudioWorklet quantum)
//! and records `speaking` / `level` per block, then asserts on time windows.
const std = @import("std");
const vad = @import("vad.zig");
const Vad = vad.Vad;

test {
    _ = vad; // pull in vad.zig's own tests
}

const block = 128;
const max_blocks = 16384;

/// Deterministic signal sources.
const Gen = struct {
    fs: f32,
    t: f64 = 0,
    rng: u32 = 0x9E37_79B9,
    brown: f32 = 0,

    fn white(g: *Gen) f32 {
        // xorshift32 → uniform in [-1, 1)
        g.rng ^= g.rng << 13;
        g.rng ^= g.rng >> 17;
        g.rng ^= g.rng << 5;
        return @as(f32, @floatFromInt(g.rng)) / 2147483648.0 - 1.0;
    }

    /// A 200 Hz harmonic "vowel" with two formant bumps (≈700 Hz, ≈1200 Hz) and 1/k tilt.
    fn vowel(g: *Gen, f0: f64) f32 {
        var s: f64 = 0;
        var k: f64 = 1;
        while (k * f0 < 4000) : (k += 1) {
            const f = k * f0;
            const f1 = (f - 700) / 250;
            const f2 = (f - 1200) / 300;
            const a = (1 / k) * (1 + 3 * @exp(-f1 * f1) + 2 * @exp(-f2 * f2));
            s += a * @sin(2 * std.math.pi * f * g.t);
        }
        return @floatCast(s * 0.25);
    }

    /// A loud steady fan: brown-ish rumble, a motor hum with a harmonic, and broadband hiss.
    fn fan(g: *Gen) f32 {
        const c: f32 = 2 * std.math.pi * 400 / g.fs;
        g.brown += (g.white() - g.brown) * c;
        const hum = 0.12 * @sin(2 * std.math.pi * 120 * g.t) + 0.05 * @sin(2 * std.math.pi * 240 * g.t);
        return 2.5 * g.brown + @as(f32, @floatCast(hum)) + 0.03 * g.white();
    }
};

const Signal = union(enum) {
    silence,
    white: f32, // amplitude
    /// Voiced signal with a smooth syllable-rate envelope (raised cosine at `rate` Hz).
    syllables: struct { gain: f32, rate: f32 = 4 },
    /// Words: `on` seconds of voice (with soft edges), `gap` seconds of silence.
    words: struct { gain: f32, on: f32 = 0.22, gap: f32 = 0.16 },
    tone_burst: struct { gain: f32, dur: f32 },
};

const Sim = struct {
    v: Vad,
    g: Gen,
    n: usize = 0,
    t: [max_blocks]f32 = undefined,
    on: [max_blocks]bool = undefined,
    lvl: [max_blocks]f32 = undefined,
    changes: u32 = 0,

    fn create(fs: f32) *Sim {
        const S = struct {
            var sim: Sim = undefined;
        };
        S.sim = .{ .v = Vad.init(fs), .g = .{ .fs = fs } };
        return &S.sim;
    }

    fn now(s: *const Sim) f32 {
        return @floatCast(s.g.t);
    }

    /// Mix `sig` (and optionally a fan bed) for `dur` seconds.
    fn run(s: *Sim, dur: f32, sig: Signal, fan_gain: f32) void {
        const start = s.g.t;
        const dt = 1.0 / @as(f64, s.g.fs);
        const total: usize = @intFromFloat(dur * s.g.fs);
        var done: usize = 0;
        var buf: [block]f32 = undefined;
        while (done < total) {
            const m = @min(block, total - done);
            for (buf[0..m]) |*x| {
                const lt: f32 = @floatCast(s.g.t - start); // time within this segment
                var y: f32 = switch (sig) {
                    .silence => 0,
                    .white => |a| a * s.g.white(),
                    .syllables => |p| blk: {
                        const e = 0.5 - 0.5 * @cos(2 * std.math.pi * p.rate * lt);
                        break :blk p.gain * e * s.g.vowel(200);
                    },
                    .words => |p| blk: {
                        const ph = @mod(lt, p.on + p.gap);
                        if (ph >= p.on) break :blk 0;
                        const e = @sin(std.math.pi * ph / p.on); // soft attack and decay
                        break :blk p.gain * e * s.g.vowel(180);
                    },
                    .tone_burst => |p| if (lt < p.dur) p.gain * @as(f32, @floatCast(@sin(2 * std.math.pi * 440 * s.g.t))) else 0,
                };
                if (fan_gain > 0) y += fan_gain * s.g.fan();
                x.* = y;
                s.g.t += dt;
            }
            const flags = s.v.process(buf[0..m]);
            if (flags & vad.Flags.changed != 0) s.changes += 1;
            std.debug.assert((flags & vad.Flags.speaking != 0) == s.v.speaking);
            if (s.n < max_blocks) {
                s.t[s.n] = s.now();
                s.on[s.n] = s.v.speaking;
                s.lvl[s.n] = s.v.level;
                s.n += 1;
            }
            done += m;
        }
    }

    fn frac(s: *const Sim, t0: f32, t1: f32) f32 {
        var on: f32 = 0;
        var all: f32 = 0;
        for (s.t[0..s.n], s.on[0..s.n]) |t, o| {
            if (t < t0 or t >= t1) continue;
            all += 1;
            if (o) on += 1;
        }
        return if (all == 0) 0 else on / all;
    }

    fn firstOn(s: *const Sim, t0: f32) ?f32 {
        for (s.t[0..s.n], s.on[0..s.n]) |t, o| if (t >= t0 and o) return t;
        return null;
    }

    fn firstOff(s: *const Sim, t0: f32) ?f32 {
        for (s.t[0..s.n], s.on[0..s.n]) |t, o| if (t >= t0 and !o) return t;
        return null;
    }

    fn lastOn(s: *const Sim) ?f32 {
        var i = s.n;
        while (i > 0) {
            i -= 1;
            if (s.on[i]) return s.t[i];
        }
        return null;
    }

    fn maxLevel(s: *const Sim, t0: f32, t1: f32) f32 {
        var m: f32 = 0;
        for (s.t[0..s.n], s.lvl[0..s.n]) |t, l| {
            if (t >= t0 and t < t1) m = @max(m, l);
        }
        return m;
    }
};

const expect = std.testing.expect;

fn expectNear(want: f32, got: f32, tol: f32) !void {
    if (@abs(want - got) > tol) {
        std.debug.print("expected {d:.3} ± {d:.3}, got {d:.3}\n", .{ want, tol, got });
        return error.TestExpectedApproxEq;
    }
}

test "digital silence never speaks and the level stays at zero" {
    const s = Sim.create(48000);
    s.run(3, .silence, 0);
    try expect(s.frac(0, 3) == 0);
    try expect(s.maxLevel(0, 3) == 0);
}

test "white noise is rejected, from the start and as a sudden onset" {
    var s = Sim.create(48000);
    s.run(5, .{ .white = 0.3 }, 0);
    try expect(s.frac(0, 5) == 0);
    try expect(s.maxLevel(1, 5) < 0.1);

    s = Sim.create(48000);
    s.run(1, .silence, 0);
    s.run(4, .{ .white = 0.3 }, 0); // hiss switching on: high ZCR, never voiced
    try expect(s.frac(0, 5) == 0);
}

test "a 200 Hz voiced signal with syllable-rate modulation is speech" {
    const s = Sim.create(48000);
    s.run(1, .silence, 0);
    s.run(3, .{ .syllables = .{ .gain = 0.1 } }, 0);
    const on = s.firstOn(1) orelse return error.NeverSpoke;
    try expect(on < 1.25); // the envelope needs ~50 ms to climb, then 60 ms attack
    try expect(s.frac(on, 4) == 1); // syllable dips never drop the gate
    try expect(s.maxLevel(1, 4) > 0.6);
}

test "speech then pause: words hold through gaps, release after ~350 ms" {
    const s = Sim.create(48000);
    s.run(0.8, .silence, 0);
    s.run(2.66, .{ .words = .{ .gain = 0.1 } }, 0); // 7 words, 160 ms gaps
    const end = s.now() - 0.16; // last word ends before the final gap
    s.run(2, .silence, 0);

    const on = s.firstOn(0.8) orelse return error.NeverSpoke;
    try expect(on < 0.95);
    try expect(s.frac(on, end) == 1); // 160 ms gaps between words never drop it
    const off = s.firstOff(end) orelse return error.NeverReleased;
    try expectNear(0.36, off - end, 0.1);
    try expect(s.frac(off, s.now()) == 0);
    try expect(s.changes == 2);
}

test "short clicks shorter than the attack do not trigger" {
    const s = Sim.create(48000);
    s.run(1, .silence, 0);
    s.run(0.5, .{ .tone_burst = .{ .gain = 0.3, .dur = 0.03 } }, 0);
    s.run(0.5, .{ .tone_burst = .{ .gain = 0.3, .dur = 0.03 } }, 0);
    try expect(s.frac(0, s.now()) == 0);
}

test "a loud steady fan adapts into the floor and never counts as speech" {
    const s = Sim.create(48000);
    s.run(10, .silence, 0.25);
    try expect(s.frac(0, 10) == 0);
    try expect(s.maxLevel(1, 10) < 0.1);
}

test "a fan switching on mid-session is absorbed within 1.5 s" {
    const s = Sim.create(48000);
    s.run(1, .silence, 0);
    s.run(8, .silence, 0.25);
    try expect(s.frac(2.5, 9) == 0);
    try expect(s.frac(1, 9) < 0.2);
}

test "speech over a loud fan is still detected" {
    const s = Sim.create(48000);
    s.run(4, .silence, 0.25);
    s.run(3, .{ .syllables = .{ .gain = 0.6 } }, 0.25); // ~14 dB above the fan in the speech band
    s.run(2, .silence, 0.25);
    try expect(s.frac(0, 4) == 0);
    const on = s.firstOn(4) orelse return error.NeverSpoke;
    try expect(on < 4.35);
    try expect(s.frac(on, 7) > 0.95);
    const last = s.lastOn() orelse unreachable;
    try expect(last < 7.6);
}

test "sensitivity moves the threshold" {
    // Soft speech over the fan, peaking about 9 dB above it in the speech band.
    var s = Sim.create(48000);
    s.v.setSensitivity(1);
    s.run(3, .silence, 0.25);
    s.run(2, .{ .syllables = .{ .gain = 0.35 } }, 0.25);
    try expect(s.frac(3, 5) > 0.5);

    s = Sim.create(48000);
    s.v.setSensitivity(0);
    s.run(3, .silence, 0.25);
    s.run(2, .{ .syllables = .{ .gain = 0.35 } }, 0.25);
    try expect(s.frac(3, 5) == 0);
}

test "other sample rates: 44.1, 16 and 96 kHz" {
    for ([_]f32{ 44100, 16000, 96000 }) |fs| {
        const s = Sim.create(fs);
        s.run(1, .silence, 0);
        s.run(2, .{ .syllables = .{ .gain = 0.1 } }, 0);
        s.run(1, .silence, 0);
        const on = s.firstOn(1) orelse return error.NeverSpoke;
        try expect(on < 1.25);
        try expect(s.frac(on, 3) == 1);
        try expect(s.frac(3.6, 4) == 0);
    }
}
