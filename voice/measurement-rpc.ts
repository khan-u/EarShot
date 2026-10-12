import type { AudioSnapshot } from "./audio-stats";

export interface ReceiverReply {
    captureId: string; requestId: string; peerIndex: number;
    requestSentAtMs: number; responseReceivedAtMs: number;
    remoteReceivedAtMs: number; remoteSentAtMs: number;
    snapshot: AudioSnapshot;
}
interface Pending {
    peerIndex: number; captureId: string; sentAtMs: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (value: ReceiverReply) => void; reject: (error: Error) => void;
}
const token = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,96}$/.test(value);
const now = () => performance.timeOrigin + performance.now();

/** Opt-in stats requests use the existing opaque signalling relay. No media,
 *  addresses or credentials are sent. No connection is created by a request. */
export class MeasurementRpc {
    private pending = new Map<string, Pending>();
    private busy = new Set<number>();
    private lastRequest = new Map<number, number>();
    constructor(private options: {
        send: (peerIndex: number, message: object) => void;
        hasPeer: (peerIndex: number) => boolean;
        allowed: () => boolean;
        snapshot: (peerIndex: number) => Promise<AudioSnapshot>;
        timeoutMs?: number;
    }) {}

    request(peerIndex: number, captureId: string): Promise<ReceiverReply> {
        if (!token(captureId) || !this.options.hasPeer(peerIndex)) return Promise.reject(new Error("invalid capture or unavailable peer"));
        if (this.pending.size >= 4 || [...this.pending.values()].some(p => p.peerIndex === peerIndex)) return Promise.reject(new Error("receiver request already pending"));
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error("receiver telemetry timed out; verify both builds, receiver opt-in and signalling relay"));
            }, this.options.timeoutMs ?? 4000);
            this.pending.set(requestId, { peerIndex, captureId, sentAtMs: now(), timer, resolve, reject });
            try { this.options.send(peerIndex, { k: "measure-request", version: 1, requestId, captureId }); }
            catch { clearTimeout(timer); this.pending.delete(requestId); reject(new Error("receiver request send failed")); }
        });
    }

    async handle(peerIndex: number, message: any): Promise<boolean> {
        if (message?.k !== "measure-request" && message?.k !== "measure-response") return false;
        const receivedAtMs = now();
        if (message.version !== 1 || !token(message.requestId) || !token(message.captureId)) return true;
        if (message.k === "measure-response") {
            const pending = this.pending.get(message.requestId);
            if (!pending || pending.peerIndex !== peerIndex || pending.captureId !== message.captureId) return true;
            clearTimeout(pending.timer); this.pending.delete(message.requestId);
            if (message.error) pending.reject(new Error("receiver telemetry rejected: " + String(message.error).slice(0, 100)));
            else if (!this.options.hasPeer(peerIndex) || message.snapshot?.schemaVersion !== 1 ||
                !Number.isFinite(message.receivedAtMs) || !Number.isFinite(message.sentAtMs) || message.sentAtMs < message.receivedAtMs) {
                pending.reject(new Error("invalid receiver telemetry response"));
            } else pending.resolve({
                captureId: pending.captureId, requestId: message.requestId, peerIndex,
                requestSentAtMs: pending.sentAtMs, responseReceivedAtMs: receivedAtMs,
                remoteReceivedAtMs: message.receivedAtMs, remoteSentAtMs: message.sentAtMs,
                snapshot: message.snapshot,
            });
            return true;
        }
        if (!this.options.hasPeer(peerIndex)) return true;
        const reply = (extra: object) => {
            try { this.options.send(peerIndex, { k: "measure-response", version: 1,
                requestId: message.requestId, captureId: message.captureId,
                receivedAtMs, sentAtMs: now(), ...extra }); } catch { /* requester times out */ }
        };
        if (!this.options.allowed()) { reply({ error: "measurement sharing is disabled" }); return true; }
        for (const [index, time] of this.lastRequest) if (receivedAtMs - time > 10000) this.lastRequest.delete(index);
        if (this.busy.has(peerIndex) || receivedAtMs - (this.lastRequest.get(peerIndex) ?? -Infinity) < 250) {
            reply({ error: "measurement request rate exceeded" }); return true;
        }
        this.lastRequest.set(peerIndex, receivedAtMs); this.busy.add(peerIndex);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const snapshot = await Promise.race([
                this.options.snapshot(peerIndex),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), this.options.timeoutMs ?? 4000); }),
            ]);
            if (!this.options.allowed() || !this.options.hasPeer(peerIndex)) reply({ error: "measurement access or peer changed" });
            else reply({ snapshot });
        } catch { reply({ error: "receiver stats unavailable" }); }
        finally { if (timer) clearTimeout(timer); this.busy.delete(peerIndex); }
        return true;
    }
}
