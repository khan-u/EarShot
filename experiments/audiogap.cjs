/**
 * Packet-interruption proxy during an out-and-back trip, schema version 2.
 * Two clients, a continuous injected tone, serial packet-counter polling.
 * This does not measure listener-perceived silence or physical playout.
 * Usage from repository root: node experiments/audiogap.cjs [absenceSec]
 */
const path = require("path");
const fs   = require("fs");
const { performance } = require("node:perf_hooks");
const { PacketGap, readRxPackets } = require("./lib/packet-gap.cjs");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { ensureToneWav }  = require("./lib/tonegen.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE         = process.env.BASE_URL || "http://127.0.0.1:5001";
const ABSENCE_MS   = Number(process.argv[2] || "9") * 1000;
if (!Number.isFinite(ABSENCE_MS) || ABSENCE_MS < 3000) throw new Error("absenceSec must be at least 3");
const STALL_MS     = 1200;   // stall confirmation threshold, not an onset offset
const POLL_MS      = 200;
const STAMP        = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR      = process.env.EXPERIMENT_DATA_DIR || path.join(__dirname, "runs");
const UID          = Date.now().toString(36).slice(-6);
const ASSETS_DIR   = path.join(__dirname, "assets");
const TONE_WAV     = path.join(ASSETS_DIR, "wsn-tone-sweep-48k-180s.wav");

const FAKE_SENDER = FAKE_MEDIA_ARGS
    .filter((f) => !f.startsWith("--use-file-for-fake-audio-capture"))
    .concat([`--use-file-for-fake-audio-capture=${TONE_WAV}`]);

const rxPkts = page => page.evaluate(readRxPackets);

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    ensureToneWav(TONE_WAV);

    const rec = {
        schemaVersion: 2,
        method: "aggregate inbound packet-counter polling; not audible silence",
        exportedAt: new Date().toISOString(),
        applicationBuildId: process.env.APP_BUILD_ID || null,
        absenceMs: ABSENCE_MS, pollIntervalMs: POLL_MS, stallConfirmationMs: STALL_MS,
        clock: "monotonic Node performance.now(), milliseconds",
        valid: false, invalidReason: null,
    };
    let senderBrowser, listenerBrowser;
    try {
        senderBrowser = await chromium.launch({ headless: true, args: FAKE_SENDER });
        listenerBrowser = await chromium.launch({ headless: true, args: FAKE_MEDIA_ARGS });
        // Sender (A) uses the tone WAV; listener (B) uses the default fake mic.
        const ctxA = await bootContext(senderBrowser, BASE, { stripProcessing: true });
        const ctxB = await bootContext(listenerBrowser, BASE);
        const pA = await ctxA.newPage(), pB = await ctxB.newPage();
        await pA.goto(BASE, { waitUntil: "domcontentloaded" });
        await pB.goto(BASE, { waitUntil: "domcontentloaded" });
        await loginPage(pA, `ag${UID}a`, `agpass${UID}a`);
        await loginPage(pB, `ag${UID}b`, `agpass${UID}b`);
        await pA.evaluate(() => window.wsnVoiceCtl.enable());
        await pB.evaluate(() => window.wsnVoiceCtl.enable());
        log("clients online, waiting for packet flow");

        // Wait for B to receive packets (with a kick-retry if the first connect fails).
        let flowing = false;
        for (let attempt = 1; attempt <= 3 && !flowing; attempt++) {
            let prev = await rxPkts(pB);
            for (let t = 0; t < 15000; t += 1000) {
                await sleep(1000);
                const cur = await rxPkts(pB);
                if (cur > prev + 5) { flowing = true; break; }
                prev = cur;
            }
            if (!flowing && attempt < 3) {
                await pA.evaluate(() => window.wsnVoiceCtl.disable()); await sleep(700);
                await pA.evaluate(() => window.wsnVoiceCtl.enable());
                log(`  kicked A (attempt ${attempt})`);
            }
        }
        if (!flowing) { rec.invalidReason = "no baseline packet flow after 3 kick attempts"; }
        else {
            const posA = await pA.evaluate(() => window.wsnGame.pos());
            const packets = await rxPkts(pB);
            const tDepart = performance.now();
            const gap = new PacketGap(tDepart, packets, STALL_MS);
            rec.observations = gap.samples; // Also retained if a later probe fails.
            rec.departureCommandMs = tDepart;
            await pA.evaluate(p => window.wsnGame.teleport(-25, p.y), posA);
            log("A out WEST, watching B's packet stream");
            while (performance.now() < tDepart + ABSENCE_MS) {
                await sleep(Math.min(POLL_MS, Math.max(0, tDepart + ABSENCE_MS - performance.now())));
                const count = await rxPkts(pB);
                gap.observe(performance.now(), count);
            }
            const tReturn = performance.now();
            rec.returnCommandMs = tReturn;
            await pA.evaluate(p => window.wsnGame.teleport(p.x, p.y), posA);
            log("A back, watching packet recovery");
            while (performance.now() < tReturn + 30000) {
                const count = await rxPkts(pB);
                gap.observe(performance.now(), count);
                if (gap.resumeMs != null) break;
                await sleep(POLL_MS);
            }
            Object.assign(rec, gap.summary(tDepart, tReturn));

        }

    } catch (error) {
        rec.valid = false;
        rec.invalidReason = String(error);
        process.exitCode = 1;
    } finally {
        const file = path.join(OUT_DIR, `wsn-packetgap-v2-${STAMP}.json`);
        fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
        log(`wrote ${path.basename(file)}; valid=${rec.valid}`);
        if (!rec.valid) { log(rec.invalidReason); process.exitCode = 1; }
        await Promise.allSettled([senderBrowser?.close(), listenerBrowser?.close()]);
    }
})();
