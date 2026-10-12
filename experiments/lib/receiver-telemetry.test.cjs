const { test } = require("node:test");
const assert = require("node:assert/strict");
const { matchReceiver, receiverInterval, summarizeTelemetry, startTelemetry, epochMs } = require("./receiver-telemetry.cjs");
function sample(t, value, changes = {}) {
    const tx = { schemaVersion: 1, sessionId: "sender", peers: [{ peerIndex: 7, connectionId: "a1", reports: [
        { id: "out", type: "outbound-rtp", ssrc: 42, packetsSent: value, timestamp: t },
    ] }] };
    const snapshot = { schemaVersion: 1, sessionId: "receiver", visibility: "visible", startedAtMs: t, finishedAtMs: t,
        peers: [{ peerIndex: 3, connectionId: "b1", connectionState: "connected", reports: [
            { id: "in", type: "inbound-rtp", ssrc: 42, packetsReceived: value, timestamp: t, transportId: "transport",
                jitterBufferDelay: value * 0.02, jitterBufferEmittedCount: value },
            { id: "transport", type: "transport", selectedCandidatePairId: "selected" },
            { id: "wrong", type: "candidate-pair", currentRoundTripTime: 99 },
            { id: "selected", type: "candidate-pair", currentRoundTripTime: 0.06 },
        ] }] };
    const s = { schemaVersion: 1, captureId: "capture", valid: true, hostStartedAtMs: t - 5, hostFinishedAtMs: t + 5,
        exchange: { sender: tx, senderAfter: structuredClone(tx), reply: { captureId: "capture", peerIndex: 7,
            remoteReceivedAtMs: t - 1, remoteSentAtMs: t + 1, snapshot } }, ...changes };
    s.match = matchReceiver(s); return s;
}
test("matches forward SSRC and bounds remote stats without assuming symmetric signalling", () => {
    const s = sample(1000, 10);
    assert.deepEqual(s.match.remoteToHostOffsetBoundsMs, { min: -4, max: 4 });
    assert.deepEqual(s.match.receiverStatsHostBoundsMs, { min: 996, max: 1004 });
    s.exchange.reply.snapshot.peers[0].reports[0].ssrc = 43;
    assert.throws(() => matchReceiver(s), /SSRC/);
});
test("uses interval counters and the selected pair, with an explicit assumed device term", () => {
    const interval = receiverInterval(sample(1000, 10), sample(1500, 20), { startMs: 900, endMs: 1600 });
    assert.equal(interval.valid, true); assert.equal(interval.jitterBufferMs, 20);
    assert.equal(interval.selectedPairRttMsAtEnd, 60); assert.equal(interval.modelWithAssumed40Ms, 90);
    assert.equal(receiverInterval(sample(1000, 10), sample(1500, 20), { startMs: 1000, endMs: 1500 }).outsideWindow, true);
});
test("never uses lifetime fallback on reset, no progress, missing data or a new connection", () => {
    const a = sample(1000, 10);
    for (const b of [sample(1500, 9), sample(1500, 10), { valid: false }]) assert.equal(receiverInterval(a, b).valid, false);
    const b = sample(1500, 20); b.match.identity = "replacement";
    assert.equal(receiverInterval(a, b).valid, false);
    const absent = sample(1500, 20); delete absent.exchange.reply.snapshot.peers[0].reports[0].jitterBufferDelay;
    assert.throws(() => matchReceiver(absent), /jitterBufferDelay/);
});
test("summary exposes missing samples, identity changes and incomplete temporal coverage", () => {
    const a = sample(1000, 10), b = sample(1500, 20);
    const good = summarizeTelemetry([a, b], { startMs: 900, endMs: 1600 });
    assert.equal(good.valid, true); assert.equal(good.intervalModelMedianMs, 90);
    assert.equal(summarizeTelemetry([a, { valid: false, hostStartedAtMs: 1200 }, b], { startMs: 900, endMs: 1600 }).valid, false);
    assert.equal(summarizeTelemetry([a, b], { startMs: 0, endMs: 9000 }).valid, false);
    assert.equal(summarizeTelemetry([a, b], null).valid, false);
    b.match.identity = "different";
    assert(summarizeTelemetry([a, b], { startMs: 900, endMs: 1600 }).issues.some(i => i.includes("identity")));
});
test("serial sampling and idempotent stop preserve every sample including failures", async () => {
    let active = 0, peak = 0, calls = 0; const written = [];
    const page = { evaluate: async () => {
        active++; peak = Math.max(peak, active); const n = ++calls;
        await new Promise(resolve => setTimeout(resolve, 8)); active--;
        if (n === 2) throw new Error("probe failed");
        return sample(epochMs(), n * 10).exchange;
    } };
    const monitor = startTelemetry(page, "capture", s => written.push(s), { pollMs: 3 });
    await new Promise(resolve => setTimeout(resolve, 35));
    const firstStop = monitor.stop(); assert.equal(monitor.stop(), firstStop);
    const result = await firstStop;
    assert.equal(peak, 1); assert.equal(written.length, calls); assert.equal(result.length, calls);
    assert(result.some(s => !s.valid && s.error === "probe failed"));
});

test("rejects hidden receiver, malformed clock bounds and partial model availability", () => {
    const hidden = sample(1000, 10); hidden.exchange.reply.snapshot.visibility = "hidden";
    assert.throws(() => matchReceiver(hidden), /visibility/);
    const badClock = sample(1000, 10); delete badClock.exchange.reply.snapshot.startedAtMs;
    assert.throws(() => matchReceiver(badClock), /clock/);
    const a = sample(1000, 10), b = sample(1500, 20), c = sample(2000, 30);
    c.match.selectedPair = null;
    const summary = summarizeTelemetry([a, b, c], { startMs: 900, endMs: 2100 });
    assert.equal(summary.valid, false);
    assert(summary.issues.some(i => i.includes("some contained intervals")));
});
