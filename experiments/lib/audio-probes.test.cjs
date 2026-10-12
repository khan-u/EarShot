const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readAudioStats, packetProgress, uplinkRate } = require("./audio-probes.cjs");
const { PacketGap } = require("./packet-gap.cjs");
const { checkPosition } = require("./gap-trip.cjs");
function snap(value, timestamp, connectionId = "pc1", sessionId = "session") {
    return { schemaVersion: 1, sessionId, peers: [{ connectionId, peerIndex: 1, error: null, reports: [
        { id: "in", type: "inbound-rtp", ssrc: 1, packetsReceived: value, timestamp },
        { id: "out", type: "outbound-rtp", ssrc: 2, bytesSent: value, timestamp },
    ] }] };
}
test("rates use per-stream timestamps and reject unavailable/churn/reset windows", () => {
    assert.equal(uplinkRate(snap(100, 100), snap(200, 200)).kbps, 8);
    for (const end of [snap(50, 200), snap(200, 100), snap(200, 200, "pc2"), snap(200, 200, "pc1", "reload")]) {
        assert.equal(uplinkRate(snap(100, 100), end).valid, false);
        assert.equal(uplinkRate(snap(100, 100), end).kbps, null);
    }
    const empty = { schemaVersion: 1, sessionId: "s", peers: [] };
    assert.equal(uplinkRate(empty, empty).valid, false);
    const missing = snap(100, 100); delete missing.peers[0].reports[1].bytesSent;
    assert.equal(uplinkRate(missing, snap(200, 200)).valid, false);
});
test("replacement with an equal or higher counter needs a subsequent same-stream increment", () => {
    assert.equal(packetProgress(snap(10, 0), snap(10, 200, "pc2")).progress, false);
    assert.equal(packetProgress(snap(10, 0), snap(1000, 200, "pc2")).progress, false);
    assert.equal(packetProgress(snap(10, 200, "pc2"), snap(11, 400, "pc2")).progress, true);
    assert.equal(packetProgress(snap(10, 0), snap(3, 200)).resets, 1);
    assert.equal(packetProgress(snap(10, 0), snap(11, 0)).progress, false);
});
test("identified replacement does not shorten an interruption or add confirmation delay", () => {
    const gap = new PacketGap(0, 10, 1200);
    gap.observe(1200, 10, packetProgress(snap(10, 0), snap(10, 1200)));
    gap.observe(6200, 999, packetProgress(snap(10, 1200), snap(999, 6200, "new")));
    assert.equal(gap.resumeMs, null);
    gap.observe(6400, 1000, packetProgress(snap(999, 6200, "new"), snap(1000, 6400, "new")));
    assert.equal(gap.summary(0, 6000).packetRecoveryAfterReturnMs, 400);
    assert.equal(gap.summary(0, 6000).packetStopAfterOutMs, 0);
});
test("browser controller mismatch and per-peer errors fail explicitly", async () => {
    const original = global.window;
    try {
        global.window = { wsnVoiceCtl: {} };
        await assert.rejects(readAudioStats, /unavailable/);
        global.window.wsnVoiceCtl.audioStats = async () => snap(1, 1);
        assert.equal((await readAudioStats()).peers.length, 1);
        const failed = snap(1, 1); failed.peers[0].error = "getStats failed";
        global.window.wsnVoiceCtl.audioStats = async () => failed;
        await assert.rejects(readAudioStats, /failed/);
    } finally { global.window = original; }
});
test("movement checks reject wrong coordinates and unsupported hooks", () => {
    checkPosition({ x: 25, y: 3 }, { x: 25, y: 3 });
    assert.throws(() => checkPosition({ x: 0, y: 6 }, { x: 25, y: 3 }), /movement/);
    assert.throws(() => checkPosition(null, { x: 1, y: 1 }), /movement/);
});
