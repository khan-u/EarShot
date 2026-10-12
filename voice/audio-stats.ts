/** Read-only, address-free RTCStats export. Missing counters stay missing. */
export interface StatsPeer { index: number; pc: RTCPeerConnection }
export type StatsRecord = Record<string, string | number | boolean>;
export interface AudioSnapshot {
    schemaVersion: 1;
    sessionId: string;
    timeOriginMs: number;
    startedAtMs: number;
    finishedAtMs: number;
    visibility: string;
    peers: Array<{
        peerIndex: number; connectionId: string; connectionState: string;
        iceConnectionState: string; startedAtMs: number; finishedAtMs: number;
        error: string | null; reports: StatsRecord[];
    }>;
}

const fields = new Set((
    "id type timestamp kind mediaType ssrc mid trackIdentifier transportId codecId " +
    "packetsReceived packetsSent packetsLost bytesReceived bytesSent jitter " +
    "jitterBufferDelay jitterBufferTargetDelay jitterBufferMinimumDelay jitterBufferEmittedCount " +
    "totalSamplesReceived totalSamplesDuration concealedSamples silentConcealedSamples " +
    "concealmentEvents insertedSamplesForDeceleration removedSamplesForAcceleration audioLevel " +
    "selectedCandidatePairId localCandidateId remoteCandidateId state nominated " +
    "currentRoundTripTime totalRoundTripTime responsesReceived candidateType protocol relayProtocol " +
    "mimeType clockRate channels sdpFmtpLine"
).split(" "));

export class AudioStatsProbe {
    private ids = new WeakMap<RTCPeerConnection, string>();
    private nextId = 0;
    readonly sessionId = crypto.randomUUID();
    constructor(private timeoutMs = 2000) {}

    async snapshot(peers: StatsPeer[]): Promise<AudioSnapshot> {
        const now = () => performance.timeOrigin + performance.now();
        const snapshot: AudioSnapshot = {
            schemaVersion: 1, sessionId: this.sessionId, timeOriginMs: performance.timeOrigin,
            startedAtMs: now(), finishedAtMs: 0,
            visibility: typeof document === "undefined" ? "unknown" : document.visibilityState,
            peers: [],
        };
        for (const { index, pc } of peers) {
            let connectionId = this.ids.get(pc);
            if (!connectionId) { connectionId = `${this.sessionId}:${++this.nextId}`; this.ids.set(pc, connectionId); }
            const peer: AudioSnapshot["peers"][number] = {
                peerIndex: index, connectionId, connectionState: pc.connectionState,
                iceConnectionState: pc.iceConnectionState,
                startedAtMs: now(), finishedAtMs: 0, error: null, reports: [],
            };
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const stats = await Promise.race([
                    pc.getStats(),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("stats timeout")), this.timeoutMs); }),
                ]);
                stats.forEach((report: any) => {
                    const audio = (report.kind ?? report.mediaType) === "audio";
                    if (!((audio && ["inbound-rtp", "outbound-rtp"].includes(report.type)) ||
                        ["transport", "candidate-pair", "local-candidate", "remote-candidate", "codec"].includes(report.type))) return;
                    const clean: StatsRecord = {};
                    for (const [key, value] of Object.entries(report)) {
                        if (fields.has(key) && (typeof value === "string" || typeof value === "boolean" ||
                            (typeof value === "number" && Number.isFinite(value)))) clean[key] = value;
                    }
                    peer.reports.push(clean);
                });
            } catch { peer.error = "getStats failed"; }
            finally { if (timer) clearTimeout(timer); }
            peer.finishedAtMs = now();
            snapshot.peers.push(peer);
        }
        snapshot.finishedAtMs = now();
        return snapshot;
    }
}
