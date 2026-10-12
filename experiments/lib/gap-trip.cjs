"use strict";
const { readAudioStats, streams, packetProgress, uplinkRate, waitForFlow } = require("./audio-probes.cjs");
const { PacketGap } = require("./packet-gap.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const count = snapshot => [...streams(snapshot, "inbound-rtp", "packetsReceived").values()].reduce((sum, s) => sum + s.value, 0);
const position = page => page.evaluate(() => window.wsnGame.pos());
function checkPosition(actual, expected) {
    if (!Number.isFinite(actual?.x) || !Number.isFinite(actual?.y) ||
        Math.abs(actual.x - expected.x) > 1 || Math.abs(actual.y - expected.y) > 1) throw new Error("movement did not reach the expected tile; verify teleport(dx, dy) integration");
}

// Both callers retain partial observations if a probe or movement fails.
async function gapTrip(sender, receiver, rec, { dx = -25, timeoutMs = 30000 } = {}) {
    const { absenceMs, pollIntervalMs, stallConfirmationMs, graceMs } = rec;
    if (!Number.isFinite(absenceMs) || absenceMs < stallConfirmationMs + pollIntervalMs) throw new Error("absence too short for the stall detector");
    if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > 2147483647) throw new Error("invalid grace window");
    for (const page of [sender, receiver]) {
        const actual = await page.evaluate(ms => { const c = window.wsnVoiceCtl; c.setGrace(ms); return c.grace(); }, graceMs);
        if (actual !== graceMs) throw new Error("grace setting did not take effect on both endpoints");
    }
    rec.actualGraceMs = { sender: graceMs, receiver: graceMs };
    await waitForFlow(receiver);
    const origin = await position(sender);
    checkPosition(origin, origin);
    rec.origin = origin;
    rec.observations = [];
    let previous = null, gap = null;
    async function sample(phase) {
        const startedMs = performance.now();
        const [tx, rx] = await Promise.all([sender.evaluate(readAudioStats), receiver.evaluate(readAudioStats)]);
        const timeMs = performance.now();
        const evidence = previous ? packetProgress(previous.rx, rx) : null;
        const observation = { phase, startedMs, timeMs, tx, rx, evidence };
        rec.observations.push(observation);
        if (gap) gap.observe(timeMs, count(rx), evidence);
        previous = observation;
        return observation;
    }
    const baseline = await sample("baseline");
    const depart = performance.now();
    gap = new PacketGap(depart, count(baseline.rx), stallConfirmationMs);
    rec.departureCommandMs = depart;
    // The host hook takes relative tile deltas, not absolute coordinates.
    await sender.evaluate(x => window.wsnGame.teleport(x, 0), dx);
    while (performance.now() < depart + absenceMs) {
        await sleep(Math.min(pollIntervalMs, Math.max(0, depart + absenceMs - performance.now())));
        await sample("absence");
    }
    rec.outPosition = await position(sender);
    checkPosition(rec.outPosition, { x: origin.x + dx, y: origin.y });
    const absent = rec.observations.filter(s => s.phase === "absence");
    // Whole-window rate is unavailable after a connection/report change. The
    // last counter of a closed PC cannot be recovered from endpoint snapshots.
    if (!absent.length) throw new Error("no absence observations; movement command exceeded the observation window");
    rec.absenceUplink = uplinkRate(baseline.tx, absent.at(-1).tx);
    const txSamples = [baseline, ...absent];
    const broken = txSamples.slice(1).map((s, i) => uplinkRate(txSamples[i].tx, s.tx)).find(rate => !rate.valid);
    if (broken) rec.absenceUplink = { ...broken, invalidReason: "absence sampling interval: " + broken.invalidReason };
    rec.absenceUplink.window = "baseline stats to final absence stats; includes command/probe uncertainty";
    rec.receiverPeerPresentEveryAbsencePoll = absent.every(s => s.rx.peers.length > 0);
    rec.receiverConnectionRetainedEveryAbsencePoll = absent.every(s =>
        s.rx.sessionId === baseline.rx.sessionId && s.rx.peers.length === baseline.rx.peers.length &&
        s.rx.peers.every(p => baseline.rx.peers.some(b => b.connectionId === p.connectionId)));
    const back = performance.now();
    rec.returnCommandMs = back;
    await sender.evaluate(x => window.wsnGame.teleport(-x, 0), dx);
    while (performance.now() < back + timeoutMs) {
        const current = await sample("return");
        if (current.evidence.progress) { rec.firstPostReturnProgressMs = current.timeMs; break; }
        await sleep(pollIntervalMs);
    }
    rec.returnPosition = await position(sender);
    checkPosition(rec.returnPosition, origin);
    Object.assign(rec, gap.summary(depart, back));
    rec.firstPostReturnProgressDelayMs = rec.firstPostReturnProgressMs == null ? null : rec.firstPostReturnProgressMs - back;
    rec.identityChanges = rec.observations.reduce((sum, s) => sum + (s.evidence?.identityChanges || 0), 0);
    rec.expectedGraceExceedsAbsence = graceMs > back - depart;
    return rec;
}
module.exports = { gapTrip, checkPosition };
