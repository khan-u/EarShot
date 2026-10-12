import { describe, expect, it } from "vitest";
import { AudioStatsProbe } from "./audio-stats";
const fake = (reports: object[], fail = false) => ({
    connectionState: "connected", iceConnectionState: "connected",
    getStats: async () => { if (fail) throw new Error("private error"); return new Map(reports.map((r, i) => [i, r])); },
}) as unknown as RTCPeerConnection;

describe("identified audio stats", () => {
    it("keeps connection identity stable and changes it on replacement at the same peer index", async () => {
        const probe = new AudioStatsProbe(), pc = fake([]);
        const a = await probe.snapshot([{ index: 7, pc }]);
        const b = await probe.snapshot([{ index: 7, pc }]);
        const c = await probe.snapshot([{ index: 7, pc: fake([]) }]);
        expect(a.peers[0].connectionId).toBe(b.peers[0].connectionId);
        expect(a.peers[0].connectionId).not.toBe(c.peers[0].connectionId);
        expect(a.startedAtMs).toBeLessThanOrEqual(a.finishedAtMs);
    });
    it("retains counters and selected-pair joins without network addresses or fabricated fields", async () => {
        const probe = new AudioStatsProbe();
        const s = await probe.snapshot([{ index: 1, pc: fake([
            { id: "in", type: "inbound-rtp", kind: "audio", ssrc: 123, packetsReceived: 10, timestamp: 20 },
            { id: "tr", type: "transport", selectedCandidatePairId: "pair", dtlsCipher: "secret" },
            { id: "pair", type: "candidate-pair", currentRoundTripTime: 0.01, localCandidateId: "c" },
            { id: "c", type: "local-candidate", candidateType: "relay", address: "private", port: 1234, url: "secret" },
        ]) }]);
        const text = JSON.stringify(s);
        expect(text).not.toContain("private"); expect(text).not.toContain("secret");
        expect(s.peers[0].reports[0]).not.toHaveProperty("jitterBufferDelay");
        expect(s.peers[0].reports[1].selectedCandidatePairId).toBe("pair");
    });
    it("bounds stalled browser stats collection", async () => {
        const probe = new AudioStatsProbe(5);
        const pc = { getStats: () => new Promise(() => {}) } as unknown as RTCPeerConnection;
        expect((await probe.snapshot([{ index: 1, pc }])).peers[0].error).toBe("getStats failed");
    });
    it("distinguishes a failed probe from no peers", async () => {
        const probe = new AudioStatsProbe();
        expect((await probe.snapshot([])).peers).toEqual([]);
        expect((await probe.snapshot([{ index: 1, pc: fake([], true) }])).peers[0].error).toBe("getStats failed");
    });
});
