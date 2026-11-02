//! wasm32-freestanding entry: one static detector and one static input buffer.
//! The AudioWorklet writes up to `max_block` samples at `input_ptr()` and calls `process(n)`.
const vad = @import("vad.zig");

pub const max_block = 1024;

var input: [max_block]f32 = @splat(0);
var state: vad.Vad = vad.Vad.init(48000);

export fn init(sample_rate: f32) void {
    const s = state.threshold_db;
    state = vad.Vad.init(sample_rate);
    state.threshold_db = s; // sensitivity survives a re-init
}

export fn input_ptr() [*]f32 {
    return &input;
}

export fn input_len() u32 {
    return max_block;
}

/// Bit 0: speaking. Bit 1: speaking changed during this call. Bit 2: at least one frame analysed.
export fn process(n: u32) u32 {
    return state.process(input[0..@min(n, max_block)]);
}

export fn level() f32 {
    return state.level;
}

export fn speaking() u32 {
    return @intFromBool(state.speaking);
}

export fn set_sensitivity(s: f32) void {
    state.setSensitivity(s);
}
