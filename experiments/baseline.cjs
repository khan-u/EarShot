/**
 * PROX-VOICE RTP-forwarding SFU harness — samples client-to-server RTT.
 *
 * Boots the SFU (baseline/sfu.js), connects N headless browser peers to it,
 * and reads each browser's candidate-pair RTT to the server (the added hop).
 * Audio is forwarded through the server, so this is the client→server→client
 * topology that the P2P mesh replaces.
 *
 * One-way network delay could be approximated by the sum of the endpoint
 * half-RTTs under symmetry assumptions. The output here is a mean hop RTT,
 * not end-to-end audio delay; near-zero loopback RTT does not validate timing.
 *
 * Usage:  node baseline.cjs [N] [holdSec] [port]     (defaults: 2, 12, 8090)
 */
const path  = require("path");
const fs    = require("fs");
const { spawn } = require("child_process");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log } = require("./lib/wsn-client.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const N       = Math.max(1, parseInt(process.argv[2] || "2", 10));
const HOLD_MS = Math.max(5, parseInt(process.argv[3] || "12", 10)) * 1000;
const PORT    = parseInt(process.argv[4] || "8090", 10);
const BASE    = "http://127.0.0.1:" + PORT + "/";
const OUT_DIR = process.env.EXPERIMENT_DATA_DIR || path.join(__dirname, "runs");
const STAMP   = new Date().toISOString().replace(/[:.]/g, "-");

// Headless-media args without the game-specific flags (no metal/angle needed
// for this standalone SFU client).
const FAKE = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
              "--autoplay-policy=no-user-gesture-required"];

function startSfu() {
    return new Promise((resolve, reject) => {
        const child = spawn("node", [path.join(__dirname, "baseline", "sfu.js"), String(PORT)],
                            { stdio: ["ignore", "pipe", "pipe"] });
        let up = false;
        const onData = (b) => {
            const s = b.toString(); process.stdout.write("  " + s);
            if (!up && /listening/.test(s)) { up = true; resolve(child); }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("exit", (c) => { if (!up) reject(new Error("sfu exited " + c)); });
        setTimeout(() => { if (!up) reject(new Error("sfu start timeout")); }, 10000);
    });
}

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    log(`starting SFU on port ${PORT}`);
    const sfu     = await startSfu();
    const browser = await chromium.launch({ channel: "chrome", headless: true, args: FAKE });
    const stat    = (pg) => pg.evaluate(() => window.baselineStats());

    try {
        const pages = [];
        for (let i = 0; i < N; i++) {
            const ctx = await browser.newContext();
            try { await ctx.grantPermissions(["microphone"], { origin: BASE }); } catch (_) {}
            const pg = await ctx.newPage();
            await pg.goto(BASE, { waitUntil: "domcontentloaded" });
            pages.push(pg);
            log(`peer ${i} opened`);
        }

        // Wait for all peers to reach the connected state.
        for (let t = 0; t < 30000; t += 500) {
            const st = await Promise.all(pages.map(stat));
            if (st.every((s) => s.connected)) { log(`all ${N} connected`); break; }
            await sleep(500);
        }

        log(`holding ${HOLD_MS / 1000} s for RTT and forwarding to settle`);
        await sleep(HOLD_MS);

        const snaps  = await Promise.all(pages.map(stat));
        const rtts   = snaps.map((s) => s.rttMs).filter((v) => v >= 0);
        const outPkts = snaps.map((s) => s.outPkts);
        const meanRtt = rtts.length
            ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)
            : -1;

        const rec = {
            exportedAt: new Date().toISOString(),
            topology: "rtp-forwarding-sfu",
            N,
            hopRttMs: snaps.map((s) => s.rttMs),
            hopRttMeanMs: meanRtt,
            // Legacy field name retained for readers; value is a network proxy.
            serverMixedOneWayMs: meanRtt >= 0 ? meanRtt : -1,
            outPktsPerPeer: outPkts,
            note: "RTP forwarding without audio mixing; RTT-derived network proxy, not validated end-to-end audio delay",
        };
        const file = path.join(OUT_DIR, `wsn-baseline-N${N}-${STAMP}.json`);
        fs.writeFileSync(file, JSON.stringify(rec, null, 1));
        log(`wrote ${path.basename(file)}`);
        console.log("\n===== BASELINE SUMMARY =====\n" + JSON.stringify({
            N, hopRttMeanMs: meanRtt, serverMixedOneWayMs: rec.serverMixedOneWayMs,
            outPktsPerPeer: outPkts, connected: snaps.map((s) => s.connected),
        }, null, 1));
    } catch (e) {
        log("BASELINE ERROR:", String(e).slice(0, 300));
        process.exitCode = 1;
    } finally {
        await browser.close();
        try { sfu.kill(); } catch (_) {}
    }
})();
