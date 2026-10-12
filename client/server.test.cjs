const { test } = require("node:test"), assert = require("node:assert/strict");
const { WebSocket } = require("ws"), { once } = require("node:events");
const { createExperimentServer } = require("./server.cjs");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createHash } = require("node:crypto");
async function peer(url) {
    const ws = new WebSocket(url), queue = [], waits = [];
    ws.on("message", data => { const message = JSON.parse(data); const index = waits.findIndex(w => w.type === message.type);
        if (index < 0) queue.push(message); else { const [w] = waits.splice(index, 1); clearTimeout(w.timer); w.resolve(message); } });
    await once(ws, "open");
    return { ws, send: m => ws.send(JSON.stringify(m)), next: type => {
        const index = queue.findIndex(m => m.type === type);
        if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
        return new Promise((resolve, reject) => { const w = { type, resolve, timer: setTimeout(() => { waits.splice(waits.indexOf(w), 1); reject(new Error("missing " + type)); }, 1500) }; waits.push(w); });
    } };
}
test("serves the verified build and relays identified telemetry only within a room", async () => {
    const app = createExperimentServer({ iceServers: [] });
    app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const people = [];
    try {
        const response = await fetch(base + "/build.json"); assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal((await response.json()).buildId, app.manifest.buildId);
        for (const [name, digest] of Object.entries(app.manifest.assets)) {
            const data = Buffer.from(await (await fetch(base + "/" + (name === "index.html" ? "" : name))).arrayBuffer());
            assert.equal(createHash("sha256").update(data).digest("hex"), digest);
        }
        assert.deepEqual(await (await fetch(base + "/api/turn")).json(), { iceServers: [] });
        assert.equal((await fetch(base + "/package.json")).status, 404);
        const url = base.replace("http:", "ws:") + "/signal";
        for (let i = 0; i < 3; i++) people.push(await peer(url));
        const [a, b, c] = people;
        const join = async (p, name, room) => { p.send({ type: "join", name, room, buildId: app.manifest.buildId }); return (await p.next("joined")).self; };
        const aa = await join(a, "a", "one"), bb = await join(b, "b", "one"), cc = await join(c, "c", "two");
        const telemetry = JSON.stringify({ k: "measure-response", captureId: "capture", payload: "x".repeat(12000) });
        a.send({ type: "signal", target: bb.id, from: cc.id, json: telemetry });
        const signal = await b.next("signal"); assert.equal(signal.from, aa.id); assert.equal(signal.json, telemetry);
        a.send({ type: "signal", target: cc.id, json: telemetry }); assert.match((await a.next("error")).error, /not in this room/);
        a.send({ type: "move", x: -25, y: 0 });
        let roster; do { roster = await b.next("roster"); } while (roster.participants.find(p => p.id === aa.id)?.x !== -25);
        assert.equal(roster.participants.find(p => p.id === aa.id).y, 0);
        a.send({ type: "move", x: 1.2, y: 0 }); assert.match((await a.next("error")).error, /invalid tile/);
        const bad = await peer(url); people.push(bad);
        bad.send({ type: "join", name: "bad", room: "one", buildId: "stale" }); assert.match((await bad.next("error")).error, /build/);
    } finally { for (const p of people) p.ws.terminate(); await app.close(); }
});
test("rejects modified build assets and keeps a running server on one verified build", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prox-client-test-"));
    let app;
    try {
        fs.cpSync(path.join(__dirname, "..", "client-dist"), directory, { recursive: true });
        app = createExperimentServer({ directory });
        app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
        const original = fs.readFileSync(path.join(directory, "client.js"), "utf8");
        fs.writeFileSync(path.join(directory, "client.js"), "changed");
        assert.throws(() => createExperimentServer({ directory }), /asset mismatch/);
        const response = await fetch(`http://127.0.0.1:${app.server.address().port}/client.js`);
        assert.equal(await response.text(), original);
    } finally { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
