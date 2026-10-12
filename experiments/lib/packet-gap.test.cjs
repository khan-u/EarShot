const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PacketGap, readRxPackets } = require("./packet-gap.cjs");

test("interruption spans absence and recovery, without adding stall confirmation delay", () => {
    const gap = new PacketGap(1000, 100, 1200);
    gap.observe(1200, 110);
    gap.observe(2400, 110);
    gap.observe(10000, 110);
    gap.observe(12500, 115);
    const result = gap.summary(1000, 10000);
    assert.equal(result.valid, true);
    assert.equal(result.packetStopAfterOutMs, 200);
    assert.equal(result.packetRecoveryAfterReturnMs, 2500);
    assert.equal(result.packetInterruptionMs, 11300);
    assert.equal(result.stopConfirmedMs, 2400);
});

test("counter removal and new connection recover without exceeding the old count", () => {
    const gap = new PacketGap(0, 5000, 1200);
    gap.observe(200, 0);
    gap.observe(1400, 0);
    gap.observe(9200, 3);
    const result = gap.summary(0, 9000);
    assert.equal(result.valid, true);
    assert.equal(result.packetRecoveryAfterReturnMs, 200);
    assert.equal(result.counterResets, 1);
});

test("missing events and recovery before return are invalid", () => {
    const gap = new PacketGap(0, 1, 1200);
    assert.equal(gap.summary(0, 9000).valid, false);
    gap.observe(1200, 1);
    assert.equal(gap.summary(0, 9000).valid, false);
    gap.observe(1400, 3);
    assert.equal(gap.summary(0, 9000).valid, false);
    assert.throws(() => gap.observe(1300, 4));
});

test("browser probe uses the shipped public API and fails on missing integration", async () => {
    const original = global.window;
    try {
        global.window = { wsnVoiceCtl: { rxAudio: async () => ({ pkts: 123 }) } };
        assert.equal(await readRxPackets(), 123);
        global.window = { wsnVoiceCtl: {} };
        await assert.rejects(readRxPackets, /unavailable/);
        global.window.wsnVoiceCtl.rxAudio = async () => ({ pkts: NaN });
        await assert.rejects(readRxPackets, /invalid/);
    } finally { global.window = original; }
});
