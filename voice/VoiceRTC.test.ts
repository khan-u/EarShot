import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./VoiceMetrics", () => ({ VoiceMetrics: { wirePeers: vi.fn(), start: vi.fn(), markDetected: vi.fn(), markState: vi.fn(), markGlare: vi.fn() } }));
vi.mock("./SensorNode", () => ({ SensorNode: { wirePeers: vi.fn(), start: vi.fn(), stop: vi.fn(), recordLinkState: vi.fn() } }));
class FakePeer {
    static instances: FakePeer[] = [];
    connectionState = "new"; iceConnectionState = "new"; signalingState = "stable";
    onconnectionstatechange: (() => void) | null = null;
    onicecandidate = null; ontrack = null; onnegotiationneeded = null;
    constructor(readonly configuration: RTCConfiguration) { FakePeer.instances.push(this); }
    addTrack() {}
    close() { this.connectionState = "closed"; this.onconnectionstatechange?.(); }
    getStats() { return Promise.resolve(new Map()); }
}
let getUserMedia: ReturnType<typeof vi.fn>;
const stream = { getAudioTracks: () => [{ enabled: true }] } as unknown as MediaStream;
beforeEach(() => {
    vi.resetModules(); FakePeer.instances = [];
    getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("window", { RTCPeerConnection: FakePeer, location: { search: "" } });
    vi.stubGlobal("RTCPeerConnection", FakePeer);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ iceServers: [] }) }));
});
afterEach(() => vi.unstubAllGlobals());
async function controller() {
    const { VoiceRTC } = await import("./VoiceRTC");
    const rtc = VoiceRTC.init(() => {})!; rtc.setEnabled(true); return rtc;
}
async function opened(rtc: Awaited<ReturnType<typeof controller>>) {
    await rtc.updateProximity(new Set([7]));
    await vi.waitFor(() => expect(rtc.peerCount()).toBe(1));
    return FakePeer.instances[FakePeer.instances.length - 1]!;
}
it("does not create a late peer after microphone permission resolves following disable", async () => {
    let resolve!: (s: MediaStream) => void;
    getUserMedia.mockImplementation(() => new Promise<MediaStream>(r => { resolve = r; }));
    const rtc = await controller();
    await rtc.updateProximity(new Set([7])); rtc.setEnabled(false); resolve(stream);
    await new Promise(r => setTimeout(r, 0));
    expect(rtc.peerCount()).toBe(0); expect(FakePeer.instances).toHaveLength(0);
});
it("a retired connection callback cannot close a replacement at the same peer index", async () => {
    const rtc = await controller(), old = await opened(rtc), staleCallback = old.onconnectionstatechange!;
    rtc.setEnabled(false); rtc.setEnabled(true);
    const replacement = await opened(rtc);
    staleCallback();
    expect(rtc.peerCount()).toBe(1); expect(replacement.connectionState).toBe("new");
    expect(old.onconnectionstatechange).toBeNull(); rtc.setEnabled(false);
});
it("re-enabling during a pending microphone request creates only the current generation", async () => {
    let resolve!: (s: MediaStream) => void;
    getUserMedia.mockImplementation(() => new Promise<MediaStream>(r => { resolve = r; }));
    const rtc = await controller();
    await rtc.updateProximity(new Set([7])); rtc.setEnabled(false); rtc.setEnabled(true);
    await rtc.updateProximity(new Set([7])); resolve(stream);
    await vi.waitFor(() => expect(rtc.peerCount()).toBe(1));
    expect(FakePeer.instances).toHaveLength(1); rtc.setEnabled(false);
});
it("retains relay-only policy after an ICE configuration failure", async () => {
    window.location.search = "?wsnforcerelay=1";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unavailable")));
    const rtc = await controller(), peer = await opened(rtc);
    expect(peer.configuration.iceTransportPolicy).toBe("relay"); rtc.setEnabled(false);
});
it("honours an explicitly empty ICE server list", async () => {
    const rtc = await controller(), peer = await opened(rtc);
    expect(peer.configuration.iceServers).toEqual([]); rtc.setEnabled(false);
});
