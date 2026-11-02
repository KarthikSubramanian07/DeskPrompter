const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});

    // The voice gate: wasm32-freestanding, no entry point, exports only.
    const wasm = b.addExecutable(.{
        .name = "vad",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/exports.zig"),
            .target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding }),
            .optimize = optimize,
            .strip = optimize != .debug,
        }),
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    wasm.stack_size = 16 * 1024;
    b.installArtifact(wasm);

    // Tests run natively against synthetic signals.
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/tests.zig"),
            .target = b.graph.host,
            .optimize = optimize,
        }),
    });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run the voice gate tests");
    test_step.dependOn(&run_tests.step);
}
