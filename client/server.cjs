"use strict";
const http = require("node:http"), https = require("node:https");
const fs = require("node:fs"), path = require("node:path");
const { createHash } = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");

// Room membership and tile movement replace the game server. Audio still flows
// between the browsers (or their configured TURN relay), never through this server.
function createExperimentServer({ directory = path.join(__dirname, "..", "client-dist"),
    iceServers = [{ urls: "stun:stun.l.google.com:19302" }], tls = null } = {}) {
    const manifestBytes = fs.readFileSync(path.join(directory, "build.json"));
    const manifest = JSON.parse(manifestBytes);
    const content = new Map([["build.json", manifestBytes]]);
    for (const [name, expected] of Object.entries(manifest.assets)) {
        const bytes = fs.readFileSync(path.join(directory, name));
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== expected) throw new Error("client build asset mismatch: " + name);
        content.set(name, bytes);
    }
    const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
        ['/client.js', ['client.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']],
        ['/build.json', ['build.json', 'application/json']]]);
    const handler = (req, res) => {
        res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
        if (req.method !== "GET") { res.writeHead(405).end(); return; }
        const pathname = new URL(req.url, "http://localhost").pathname;
        if (pathname === "/api/turn") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ iceServers })); return; }
        const asset = assets.get(pathname);
        if (!asset) { res.writeHead(404).end(); return; }
        res.setHeader("Content-Type", asset[1]); res.end(content.get(asset[0]));
    };
    const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
    const clients = new Map(); let nextId = 1;
    const send = (ws, message) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
    const broadcast = room => {
        const participants = [...clients.values()].filter(c => c.room === room).map(c => ({ id: c.id, name: c.name, x: c.x, y: c.y }));
        for (const [ws, c] of clients) if (c.room === room) send(ws, { type: "roster", participants });
    };
    server.on("upgrade", (req, socket, head) => {
        let origin;
        try { origin = req.headers.origin ? new URL(req.headers.origin).host : null; } catch { socket.destroy(); return; }
        if (req.url !== "/signal" || (origin && origin !== req.headers.host)) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
    });
    wss.on("connection", ws => {
        let alive = true, count = 0, since = Date.now();
        const joinDeadline = setTimeout(() => { if (!clients.has(ws)) ws.close(1008, "join required"); }, 10000);
        ws.on("pong", () => { alive = true; });
        const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 15000);
        ws.on("error", () => {});
        ws.on("message", (data, binary) => {
            if (binary) { ws.close(1003, "text messages required"); return; }
            if (Date.now() - since > 1000) { count = 0; since = Date.now(); }
            if (++count > 250) { ws.close(1008, "message rate exceeded"); return; }
            let m; try { m = JSON.parse(data.toString()); } catch { send(ws, { type: "error", error: "invalid JSON" }); return; }
            if (!m || typeof m !== "object") return;
            if (m.type === "join") {
                if (clients.has(ws)) { send(ws, { type: "error", error: "already joined" }); return; }
                if (typeof m.name !== "string" || !/^[A-Za-z0-9 _-]{1,32}$/.test(m.name) ||
                    typeof m.room !== "string" || !/^[A-Za-z0-9_-]{1,48}$/.test(m.room) || m.buildId !== manifest.buildId) {
                    send(ws, { type: "error", error: "invalid participant, room or build; reload the client" }); return;
                }
                if ([...clients.values()].filter(c => c.room === m.room).length >= 16) { send(ws, { type: "error", error: "room is full" }); return; }
                const c = { id: nextId++, name: m.name, room: m.room, x: 0, y: 0 };
                clients.set(ws, c); clearTimeout(joinDeadline);
                send(ws, { type: "joined", self: { id: c.id, name: c.name, x: c.x, y: c.y }, buildId: manifest.buildId }); broadcast(c.room);
            } else {
                const c = clients.get(ws); if (!c) { send(ws, { type: "error", error: "join first" }); return; }
                if (m.type === "move") {
                    if (![m.x, m.y].every(v => Number.isInteger(v) && Math.abs(v) <= 100000)) { send(ws, { type: "error", error: "invalid tile position" }); return; }
                    c.x = m.x; c.y = m.y; broadcast(c.room);
                } else if (m.type === "signal") {
                    if (typeof m.json !== "string" || Buffer.byteLength(m.json) > 60000) { send(ws, { type: "error", error: "invalid signalling payload" }); return; }
                    const target = [...clients].find(([, peer]) => peer.id === m.target && peer.room === c.room && peer.id !== c.id);
                    if (!target) { send(ws, { type: "error", error: "target is not in this room" }); return; }
                    // The source identity comes from the connection, never the supplied JSON.
                    send(target[0], { type: "signal", from: c.id, json: m.json });
                }
            }
        });
        ws.on("close", () => { clearTimeout(joinDeadline); clearInterval(heartbeat); const c = clients.get(ws); clients.delete(ws); if (c) broadcast(c.room); });
    });
    return { server, manifest, async close() {
        for (const ws of wss.clients) ws.terminate();
        await new Promise(resolve => wss.close(resolve));
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}
module.exports = { createExperimentServer };
if (require.main === module) {
    try {
        const tls = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null;
        if (!!process.env.TLS_CERT !== !!process.env.TLS_KEY) throw new Error("set both TLS_CERT and TLS_KEY");
        const iceServers = process.env.ICE_SERVERS_JSON ? JSON.parse(process.env.ICE_SERVERS_JSON) : undefined;
        if (iceServers && !Array.isArray(iceServers)) throw new Error("ICE_SERVERS_JSON must be an array");
        const app = createExperimentServer({ tls, iceServers });
        const port = Number(process.env.PORT || 5001), host = process.env.HOST || "127.0.0.1";
        app.server.listen(port, host, () => console.log(`Experiment server: ${tls ? "https" : "http"}://${host}:${port}; build ${app.manifest.buildId.slice(0, 16)}`));
        app.server.on("error", error => { console.error(error.code || "server error"); process.exitCode = 1; });
        for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { app.close().then(() => process.exit(0)); });
    } catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
}
