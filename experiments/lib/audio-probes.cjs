"use strict";

// Self-contained for Playwright page.evaluate. Never fall back to zero.
async function readAudioStats() {
    if (typeof window.wsnVoiceCtl?.audioStats !== "function") throw new Error("wsnVoiceCtl.audioStats() is unavailable; integrate the revised controller");
    const snapshot = await window.wsnVoiceCtl.audioStats();
    if (snapshot?.schemaVersion !== 1 || typeof snapshot.sessionId !== "string" || !Array.isArray(snapshot.peers)) throw new Error("invalid audioStats snapshot");
    if (snapshot.peers.some(peer => peer.error)) throw new Error("a peer getStats probe failed");
    return snapshot;
}

function streams(snapshot, type, field) {
    if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.peers)) throw new Error("invalid stats snapshot");
    const result = new Map();
    for (const peer of snapshot.peers) {
        if (peer.error) throw new Error("peer stats unavailable");
        for (const report of peer.reports.filter(r => r.type === type)) {
            if (!Number.isFinite(report[field]) || report[field] < 0 || !Number.isFinite(report.timestamp) ||
                typeof report.id !== "string" || !Number.isFinite(report.ssrc)) throw new Error(`missing/invalid ${field}, timestamp or stream identity`);
            const key = JSON.stringify([snapshot.sessionId, peer.connectionId, report.id, report.ssrc]);
            if (result.has(key)) throw new Error("duplicate stream identity");
            result.set(key, { value: report[field], timestamp: report.timestamp, peer, report });
        }
    }
    return result;
}

function packetProgress(before, after) {
    const a = streams(before, "inbound-rtp", "packetsReceived");
    const b = streams(after, "inbound-rtp", "packetsReceived");
    let delta = 0, resets = 0, changes = 0;
    for (const [key, next] of b) {
        const previous = a.get(key);
        // A new report's lifetime count does not prove reception in this poll.
        // Require another sample on the same connection/stream before progress.
        if (!previous) { changes++; continue; }
        if (next.timestamp < previous.timestamp) throw new Error("stats clock moved backwards");
        if (next.value < previous.value) { resets++; continue; }
        if (next.timestamp > previous.timestamp) delta += next.value - previous.value;
    }
    for (const key of a.keys()) if (!b.has(key)) changes++;
    return { progress: delta > 0, delta, resets, identityChanges: changes };
}

function uplinkRate(before, after) {
    try {
        const a = streams(before, "outbound-rtp", "bytesSent");
        const b = streams(after, "outbound-rtp", "bytesSent");
        if (!a.size || a.size !== b.size) throw new Error("missing streams or connection/stream change");
        const intervals = [];
        for (const [key, end] of b) {
            const start = a.get(key);
            if (!start) throw new Error("connection/stream changed");
            if (end.value < start.value) throw new Error("byte counter reset");
            const durationMs = end.timestamp - start.timestamp;
            if (!(durationMs > 0)) throw new Error("stats timestamp did not advance");
            intervals.push({ stream: key, startMs: start.timestamp, endMs: end.timestamp,
                bytes: end.value - start.value, kbps: (end.value - start.value) * 8 / durationMs });
        }
        return { valid: true, invalidReason: null, kbps: intervals.reduce((s, i) => s + i.kbps, 0), intervals };
    } catch (error) { return { valid: false, invalidReason: error.message, kbps: null, intervals: [] }; }
}

async function waitForFlow(page, { timeoutMs = 15000, pollMs = 500 } = {}) {
    let previous = await page.evaluate(readAudioStats);
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
        const current = await page.evaluate(readAudioStats);
        if (packetProgress(previous, current).delta > 2) return current;
        previous = current;
    }
    throw new Error("no baseline inbound packet progress on an identified stream");
}
module.exports = { readAudioStats, streams, packetProgress, uplinkRate, waitForFlow };
