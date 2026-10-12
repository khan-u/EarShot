"use strict";
const { streams } = require("./audio-probes.cjs");
const epochMs = () => performance.timeOrigin + performance.now();

// Serialized by Playwright; keep browser dependencies inside the function.
async function readReceiver({ captureId }) {
    const ctl = window.wsnVoiceCtl;
    if (typeof ctl?.audioStats !== "function" || typeof ctl?.receiverStats !== "function") throw new Error("revised receiver telemetry API unavailable");
    const sender = await ctl.audioStats();
    if (sender.peers.length !== 1 || sender.peers[0].error || sender.peers[0].connectionState !== "connected") throw new Error("capture requires exactly one connected phone peer");
    const reply = await ctl.receiverStats(sender.peers[0].peerIndex, captureId);
    const senderAfter = await ctl.audioStats();
    if (senderAfter.sessionId !== sender.sessionId || senderAfter.peers.length !== 1 ||
        senderAfter.peers[0].connectionId !== sender.peers[0].connectionId || senderAfter.peers[0].error ||
        senderAfter.peers[0].connectionState !== "connected") throw new Error("sender connection changed during receiver probe");
    return { sender, senderAfter, reply };
}

function matchReceiver(sample) {
    const { sender, senderAfter, reply } = sample.exchange;
    const receiver = reply.snapshot;
    const builds = [sender.applicationBuildId, senderAfter.applicationBuildId, receiver.applicationBuildId];
    if (builds.some(Boolean) && (!builds.every(Boolean) || new Set(builds).size !== 1)) throw new Error("sender/receiver client build mismatch");
    if (reply.captureId !== sample.captureId || reply.peerIndex !== sender.peers[0]?.peerIndex ||
        sender.peers.length !== 1 || receiver.peers?.length !== 1 ||
        receiver.peers[0].connectionState !== "connected" || receiver.visibility !== "visible") throw new Error("capture, peer, receiver visibility or connection mismatch");
    const outbound = [...streams(sender, "outbound-rtp", "packetsSent").values()];
    const outboundAfter = [...streams(senderAfter, "outbound-rtp", "packetsSent").values()];
    const inbound = [...streams(receiver, "inbound-rtp", "packetsReceived").values()];
    if (outbound.length !== 1 || outboundAfter.length !== 1 || inbound.length !== 1 ||
        outbound[0].report.ssrc !== inbound[0].report.ssrc ||
        outbound[0].report.ssrc !== outboundAfter[0].report.ssrc ||
        outbound[0].report.id !== outboundAfter[0].report.id) throw new Error("ambiguous or mismatched sender/receiver audio SSRC");
    const stream = inbound[0];
    for (const key of ["jitterBufferDelay", "jitterBufferEmittedCount"]) {
        if (!Number.isFinite(stream.report[key]) || stream.report[key] < 0) throw new Error(`receiver lacks ${key}`);
    }
    const min = sample.hostStartedAtMs - reply.remoteReceivedAtMs;
    const max = sample.hostFinishedAtMs - reply.remoteSentAtMs;
    if (!Number.isFinite(receiver.startedAtMs) || !Number.isFinite(receiver.finishedAtMs) ||
        receiver.finishedAtMs < receiver.startedAtMs || !Number.isFinite(min) || !Number.isFinite(max) || min > max ||
        receiver.startedAtMs < reply.remoteReceivedAtMs || receiver.finishedAtMs > reply.remoteSentAtMs ||
        stream.timestamp > reply.remoteSentAtMs) throw new Error("invalid receiver clock bounds");
    const reports = receiver.peers[0].reports;
    const transport = reports.find(r => r.id === stream.report.transportId && r.type === "transport");
    const pair = reports.find(r => r.id === transport?.selectedCandidatePairId && r.type === "candidate-pair");
    return {
        identity: JSON.stringify([sender.applicationBuildId ?? null, receiver.applicationBuildId ?? null,
            sender.sessionId, outbound[0].peer.connectionId, outbound[0].report.id,
            receiver.sessionId, stream.peer.connectionId, stream.report.id, stream.report.ssrc]),
        receiverReport: stream.report,
        selectedPair: pair || null,
        remoteToHostOffsetBoundsMs: { min, max },
        receiverStatsHostBoundsMs: { min: stream.timestamp + min, max: stream.timestamp + max },
    };
}

async function sampleReceiver(page, captureId) {
    const sample = { schemaVersion: 1, captureId, hostStartedAtMs: epochMs(), valid: false };
    try {
        sample.exchange = await page.evaluate(readReceiver, { captureId });
        sample.hostFinishedAtMs = epochMs();
        sample.match = matchReceiver(sample);
        sample.valid = true;
    } catch (error) { sample.hostFinishedAtMs = epochMs(); sample.error = error.message; }
    return sample;
}

function receiverInterval(before, after, window) {
    try {
        if (!before.valid || !after.valid || before.captureId !== after.captureId) throw new Error("missing or failed telemetry sample");
        const a = before.match, b = after.match;
        if (a.identity !== b.identity) throw new Error("connection or RTP stream changed");
        if (window && (a.receiverStatsHostBoundsMs.min < window.startMs || b.receiverStatsHostBoundsMs.max > window.endMs)) return { valid: false, outsideWindow: true, invalidReason: "interval not fully inside recorder command window under clock bounds" };
        const first = a.receiverReport, last = b.receiverReport;
        if (!(last.timestamp > first.timestamp)) throw new Error("receiver stats timestamp did not advance");
        if (last.packetsReceived <= first.packetsReceived || last.jitterBufferEmittedCount <= first.jitterBufferEmittedCount ||
            last.jitterBufferDelay < first.jitterBufferDelay) throw new Error("counter reset or no received/emitted progress");
        const jitterBufferMs = 1000 * (last.jitterBufferDelay - first.jitterBufferDelay) /
            (last.jitterBufferEmittedCount - first.jitterBufferEmittedCount);
        const pair = b.selectedPair;
        const rttMs = pair && a.selectedPair?.id === pair.id && Number.isFinite(pair.currentRoundTripTime) && pair.currentRoundTripTime >= 0
            ? pair.currentRoundTripTime * 1000 : null;
        return { valid: true, invalidReason: null, identity: a.identity,
            receiverStartMs: first.timestamp, receiverEndMs: last.timestamp,
            startHostBoundsMs: a.receiverStatsHostBoundsMs, endHostBoundsMs: b.receiverStatsHostBoundsMs,
            durationMs: last.timestamp - first.timestamp, jitterBufferMs,
            selectedPairRttMsAtEnd: rttMs,
            modelWithAssumed40Ms: rttMs == null ? null : rttMs / 2 + jitterBufferMs + 40 };
    } catch (error) { return { valid: false, invalidReason: error.message }; }
}

function summarizeTelemetry(samples, window, pollMs = 500) {
    const intervals = samples.slice(1).map((s, i) => ({ fromSample: i, toSample: i + 1,
        ...receiverInterval(samples[i], s, window) }));
    const usable = intervals.filter(i => i.valid);
    const models = usable.map(i => i.modelWithAssumed40Ms).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = samples.slice(1).map((s, i) => s.hostStartedAtMs - samples[i].hostStartedAtMs);
    const changes = new Set(samples.filter(s => s.valid).map(s => s.match.identity)).size > 1;
    // Nominal cadence plus RPC/collection time is observable, not assumed.
    const issues = [];
    if (!window || !(window.endMs > window.startMs)) issues.push("recorder command window unavailable");
    if (intervals.some(i => !i.valid && !i.outsideWindow)) issues.push("unusable receiver intervals");
    if (usable.length && window && (usable[0].startHostBoundsMs.max - window.startMs > pollMs * 4 ||
        window.endMs - usable.at(-1).endHostBoundsMs.min > pollMs * 4)) issues.push("receiver coverage does not approach both command-window boundaries");
    if (samples.some(s => !s.valid)) issues.push("failed telemetry samples");
    if (changes) issues.push("connection or stream identity changed within capture");
    if (!usable.length) issues.push("no contained receiver intervals with packet and emitted-sample progress");
    if (!models.length) issues.push("no selected-pair RTT for the receiver model");
    else if (usable.some(i => i.selectedPairRttMsAtEnd == null)) issues.push("selected-pair RTT unavailable for some contained intervals");
    if (gaps.some(g => g > pollMs * 4)) issues.push("sampling gap exceeded four nominal poll intervals");
    return { schemaVersion: 1, valid: issues.length === 0, issues,
        scope: "identified forward receiver stats inside recorder command window; WAV sample-clock alignment unverified",
        assumedDeviceTermMs: 40, estimator: "selected-pair RTT at interval end / 2 + delta jitter-buffer residence + assumed device term",
        pollIntervalMs: pollMs, sampleCount: samples.length, failedSamples: samples.filter(s => !s.valid).length,
        maxRequestStartGapMs: Math.max(0, ...gaps),
        containedIntervalCount: usable.length,
        receiverStatsDurationRepresentedMs: usable.reduce((sum, i) => sum + i.durationMs, 0),
        intervalModelMedianMs: models.length ? (models[Math.floor((models.length - 1) / 2)] + models[Math.floor(models.length / 2)]) / 2 : null,
        intervals };
}

// One request at a time. stop() waits for the in-flight request and takes a
// final boundary sample; every sample is written before the next is requested.
function startTelemetry(page, captureId, write, { pollMs = 500, firstSample = null } = {}) {
    const samples = firstSample ? [firstSample] : [];
    if (firstSample) write(firstSample);
    let stopped = false, wake, failure, stopPromise;
    const task = (async () => {
        while (!stopped) {
            await new Promise(resolve => {
                const timer = setTimeout(resolve, pollMs);
                wake = () => { clearTimeout(timer); resolve(); };
            });
            if (stopped) break;
            const sample = await sampleReceiver(page, captureId);
            samples.push(sample); write(sample);
        }
    })().catch(error => { failure = error; stopped = true; });
    return { samples, stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
        stopped = true; wake?.(); await task;
        if (failure) throw failure;
        const remaining = pollMs - (epochMs() - (samples.at(-1)?.hostFinishedAtMs ?? 0));
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
        const final = await sampleReceiver(page, captureId);
        samples.push(final); write(final);
        return samples;
        })();
        return stopPromise;
    } };
}
module.exports = { readReceiver, matchReceiver, sampleReceiver, receiverInterval, summarizeTelemetry, startTelemetry, epochMs };
