import { describe, expect, it } from "vitest";
import { MeasurementRpc } from "./measurement-rpc";
import type { AudioSnapshot } from "./audio-stats";
const time = () => performance.timeOrigin + performance.now();
const snapshot = async (): Promise<AudioSnapshot> => ({ schemaVersion: 1, sessionId: "receiver", timeOriginMs: performance.timeOrigin,
    startedAtMs: time(), finishedAtMs: time(), visibility: "visible", peers: [] });

describe("opt-in receiver telemetry over signalling", () => {
    it("correlates two endpoints by peer, capture and request and records both clocks", async () => {
        let a: MeasurementRpc, b: MeasurementRpc;
        a = new MeasurementRpc({ hasPeer: i => i === 7, allowed: () => false, snapshot,
            send: (_, message) => { void b.handle(3, message); } });
        b = new MeasurementRpc({ hasPeer: i => i === 3, allowed: () => true, snapshot,
            send: (_, message) => { void a.handle(7, message); } });
        const reply = await a.request(7, "capture-one");
        expect(reply.captureId).toBe("capture-one"); expect(reply.peerIndex).toBe(7);
        expect(reply.snapshot.sessionId).toBe("receiver");
        expect(reply.requestSentAtMs).toBeLessThanOrEqual(reply.remoteReceivedAtMs);
        expect(reply.remoteSentAtMs).toBeLessThanOrEqual(reply.responseReceivedAtMs);
    });
    it("requires explicit sharing and never creates or probes unknown peers", async () => {
        const sent: any[] = []; let calls = 0;
        const rpc = new MeasurementRpc({ hasPeer: i => i === 1, allowed: () => false,
            snapshot: async () => { calls++; return snapshot(); }, send: (_, message) => { sent.push(message); } });
        const msg = { k: "measure-request", version: 1, requestId: "req", captureId: "capture" };
        await rpc.handle(9, msg); expect(sent).toHaveLength(0);
        await rpc.handle(1, msg); expect(sent[0].error).toContain("disabled"); expect(calls).toBe(0);
        await expect(rpc.request(9, "capture")).rejects.toThrow("unavailable");
        expect(await rpc.handle(1, { k: "offer" })).toBe(false);
    });
    it("ignores wrong-peer/capture responses and times out without a relay", async () => {
        let message: any;
        const rpc = new MeasurementRpc({ hasPeer: () => true, allowed: () => false, snapshot, timeoutMs: 15,
            send: (_, m) => { message = m; } });
        const pending = rpc.request(1, "capture");
        const rejected = expect(pending).rejects.toThrow("timed out");
        await rpc.handle(2, { ...message, k: "measure-response", error: "wrong peer" });
        await rpc.handle(1, { ...message, captureId: "other", k: "measure-response", error: "wrong capture" });
        await expect(rpc.request(1, "capture")).rejects.toThrow("pending");
        await rejected;
        // A late response is consumed without resurrecting the request.
        expect(await rpc.handle(1, { ...message, k: "measure-response", error: "late" })).toBe(true);
    });
    it("bounds stalled receiver collection and rejects malformed response clocks", async () => {
        const sent: any[] = [];
        const rpc = new MeasurementRpc({ hasPeer: () => true, allowed: () => true,
            snapshot: () => new Promise(() => {}), send: (_, message) => { sent.push(message); }, timeoutMs: 10 });
        await rpc.handle(1, { k: "measure-request", version: 1, requestId: "one", captureId: "capture" });
        expect(sent[0].error).toContain("unavailable");
        const pending = rpc.request(2, "capture"); const rejected = expect(pending).rejects.toThrow("invalid");
        await rpc.handle(2, { ...sent[1], k: "measure-response", receivedAtMs: 3, sentAtMs: 2, snapshot: await snapshot() });
        await rejected;
    });
});
