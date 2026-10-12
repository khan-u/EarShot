import { VoiceRTC } from "../voice/VoiceRTC";
import { SensorNode } from "../voice/SensorNode";
import { VoiceMetrics } from "../voice/VoiceMetrics";
import { neighbors, moved, Participant } from "./proximity";
declare const __EXPERIMENT_BUILD__: { buildId: string; sourceCommit: string };
const w = window as any;
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const status = (text: string) => { document.getElementById("status")!.textContent = text; };
const params = new URLSearchParams(location.search);
input("room").value = params.get("room") || "earshot";
input("name").value = params.get("name") || "MacBook";
input("measurement").checked = params.get("wsnmeasure") === "1";
input("grace").value = params.get("wsngrace") || "0";
input("dtx").checked = params.get("wsndtx") === "1";
document.getElementById("build")!.textContent = "Build " + __EXPERIMENT_BUILD__.buildId.slice(0, 16);
let socket: WebSocket | null = null, self: Participant | null = null, roster: Participant[] = [], joining = false;
let rtc: VoiceRTC | null = null;
function send(message: object): void {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error("room connection is closed");
    socket.send(JSON.stringify(message));
}
function render(): void {
    document.getElementById("position")!.textContent = self ? `(${self.x}, ${self.y}) tiles` : "Not connected";
    const list = document.getElementById("participants")!; list.replaceChildren();
    for (const peer of roster) { const li = document.createElement("li"); li.textContent = `${peer.name}: (${peer.x}, ${peer.y})${peer.id === self?.id ? " — this device" : ""}`; list.appendChild(li); }
    for (const id of ["voice", "play", "leave", "out", "back"]) button(id).disabled = !self;
    button("join-button").disabled = !!self || joining;
}
function disconnected(): void {
    rtc?.setEnabled(false); rtc?.setMuted(true); VoiceMetrics.stop();
    self = null; roster = []; joining = false; render();
    status("Disconnected. Reload the page before starting another session.");
}
async function join(name: string): Promise<void> {
    if (self) return;
    if (joining || socket) throw new Error("reload before starting another connection");
    if (!window.isSecureContext) throw new Error("Microphone access requires HTTPS or localhost.");
    if (!VoiceRTC.supported()) throw new Error("WebRTC microphone capture is unavailable.");
    joining = true; render();
    const url = new URL("/signal", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    rtc = VoiceRTC.init((target, json) => send({ type: "signal", target, json }),
        { showUi: false, applicationBuildId: __EXPERIMENT_BUILD__.buildId });
    if (!rtc) throw new Error("voice controller unavailable");
    w.wsnVoiceCtl.setMeasurementSharing(input("measurement").checked);
    w.wsnVoiceCtl.setGrace(Number(input("grace").value)); w.wsnVoiceCtl.setDtx(input("dtx").checked);
    SensorNode.wirePosition(() => self ? { x: self.x, y: self.y } : null);
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket?.close(); reject(new Error("room join timed out")); }, 10000);
        socket!.onopen = () => send({ type: "join", name, room: input("room").value, buildId: __EXPERIMENT_BUILD__.buildId });
        socket!.onmessage = event => {
            let message: any; try { message = JSON.parse(event.data); } catch { return; }
            if (message.type === "joined") { self = message.self; joining = false; clearTimeout(timer); resolve(); status("Joined. Enable the microphone on each device."); render(); }
            else if (message.type === "roster") { roster = message.participants; self = roster.find(p => p.id === self?.id) || self; render(); }
            else if (message.type === "signal") { void rtc!.onSignal(message.from, message.json); }
            else if (message.type === "error") { status(message.error); if (joining) { clearTimeout(timer); reject(new Error(message.error)); socket?.close(); } }
        };
        socket!.onerror = () => { clearTimeout(timer); reject(new Error("room connection failed")); status("Room connection failed."); };
        socket!.onclose = () => { clearTimeout(timer); reject(new Error("room connection closed")); disconnected(); };
    });
}
function teleport(dx: number, dy: number): { x: number; y: number } {
    if (!self) throw new Error("join a room before moving");
    const pos = moved(self, dx, dy); send({ type: "move", ...pos }); self = { ...self, ...pos }; render(); return pos;
}
// Retain the historical harness contract without loading game/cache/UI code.
w.wsnGame = { loggedIn: () => self != null, name: () => self?.name || "", pos: () => self ? { x: self.x, y: self.y } : null, teleport };
w.proxExperiment = { build: __EXPERIMENT_BUILD__, join, role: "minimal-proximity-client" };
setInterval(() => {
    const summary = w.wsnVoiceCtl?.connectionSummary();
    document.getElementById("connection")!.textContent = summary ? `${summary.linked} connected audio links; ${summary.negotiating} negotiating.` : "";
}, 500);
let updating = false;
setInterval(async () => {
    if (!self || !rtc || updating) return;
    updating = true;
    try { await rtc.updateProximity(neighbors(self, roster)); } finally { updating = false; }
}, 20);
document.getElementById("join")!.addEventListener("submit", event => { event.preventDefault(); join(input("name").value).catch(error => { joining = false; render(); status(error.message); }); });
button("voice").onclick = () => {
    if (!rtc) return;
    if (rtc.isEnabled()) { rtc.setEnabled(false); rtc.setMuted(true); button("voice").textContent = "Enable voice"; }
    else { rtc.setMuted(false); VoiceRTC.experimentEnable(); button("voice").textContent = "Disable voice"; }
};
button("play").onclick = () => {
    Promise.all([...document.querySelectorAll("audio")].map(el => el.play())).then(() => status("Received audio playback resumed."), () => status("Playback is blocked; check browser audio permission."));
};
button("leave").onclick = () => { socket?.close(); location.reload(); };
button("out").onclick = () => teleport(-25, 0); button("back").onclick = () => teleport(25, 0);
input("measurement").onchange = () => w.wsnVoiceCtl?.setMeasurementSharing(input("measurement").checked);
input("grace").onchange = () => w.wsnVoiceCtl?.setGrace(Number(input("grace").value));
input("dtx").onchange = () => { w.wsnVoiceCtl?.setDtx(input("dtx").checked); status("DTX applies to the next negotiation; disable and re-enable voice on both devices."); };
window.addEventListener("pagehide", () => { rtc?.setEnabled(false); socket?.close(); });
