/**
 * Sensing-scenario harness — suppression + report-kind profiling.
 *
 * Runs one of four scenarios:
 *   idle  — two clients, no movement or speech (baseline suppression)
 *   walk  — A moves ±7 tiles every 4 s (above MOVE_TILES=6; stays in range)
 *   conv  — A and B exchange speakTo/speakAccept; speech-pattern WAV injected
 *   churn — A moves ±22 tiles every 8 s (tears down and reforms the link)
 *
 * Collects wsnSense.stats() for each client after a 60 s hold and counts the
 * sensor report kinds emitted during the run.
 *
 * Counts come from the retained report dump. Keep the raw reports and inspect
 * speech/move/link events for the intended scenario; counts alone do not
 * establish that every commanded action occurred.
 *
 * Usage:  node sensing.cjs <idle|walk|conv|churn>
 */
const path = require("path");
const fs   = require("fs");
const { TS_CLIENT, FAKE_MEDIA_ARGS, sleep, log, bootContext, loginPage } = require("./lib/wsn-client.cjs");
const { readSensorStats } = require("./lib/sensor-probes.cjs");
const { ensureSpeechWav } = require("./lib/tonegen.cjs");
const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

const BASE       = process.env.BASE_URL || "http://127.0.0.1:5001";
const SCENARIO   = (process.argv[2] || "idle").toLowerCase();
if (!["idle", "walk", "conv", "churn"].includes(SCENARIO)) throw new Error("unknown sensing scenario");
const HOLD_MS    = 60000;
const STAMP      = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR    = process.env.EXPERIMENT_DATA_DIR || path.join(__dirname, "runs");
const ASSETS_DIR = path.join(__dirname, "assets");
const SPEECH_WAV = path.join(ASSETS_DIR, "wsn-speech-pattern-48k-180s.wav");
const UID        = Date.now().toString(36).slice(-6);

const FAKE_SPEECH = FAKE_MEDIA_ARGS
    .filter((f) => !f.startsWith("--use-file-for-fake-audio-capture"))
    .concat([`--use-file-for-fake-audio-capture=${SPEECH_WAV}`]);

(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    if (SCENARIO === "conv") ensureSpeechWav(SPEECH_WAV);

    const argsA = SCENARIO === "conv" ? FAKE_SPEECH : FAKE_MEDIA_ARGS;
    const browser = await chromium.launch({ channel: "chrome", headless: true, args: argsA });
    const kindCounts = {};
    const rec = { valid: false, invalidReasons: [], exportedAt: new Date().toISOString(), scenario: SCENARIO, clients: {}, kindCounts };

    const kindSamplers = [];
    try {
        const ctxA = await bootContext(browser, BASE, { stripProcessing: SCENARIO === "conv" });
        const ctxB = await bootContext(browser, BASE);
        const pA = await ctxA.newPage(), pB = await ctxB.newPage();
        await pA.goto(BASE, { waitUntil: "domcontentloaded" });
        await pB.goto(BASE, { waitUntil: "domcontentloaded" });
        await loginPage(pA, `sn${UID}a`, `snpass${UID}a`);
        await loginPage(pB, `sn${UID}b`, `snpass${UID}b`);
        if (SCENARIO === "conv" && await pA.evaluate(() => !!window.proxExperiment)) {
            throw new Error("conversation signalling requires the full game host; the minimal client does not implement speakTo/speakAccept");
        }
        await pA.evaluate(() => window.wsnVoiceCtl.enable());
        await pB.evaluate(() => window.wsnVoiceCtl.enable());
        log(`scenario=${SCENARIO}, hold=${HOLD_MS / 1000} s`);

        // Record movement failures and clear every timer during cleanup.

        if (SCENARIO === "walk") {
            // ±7 tiles every 4 s — stays within proximity range (15 tiles).
            let dir = 1;
            const walkLoop = setInterval(async () => {
                await pA.evaluate((d) => window.wsnGame.teleport(d, 0), dir * 7)
                    .catch(error => rec.invalidReasons.push(error.message));
                dir *= -1;
            }, 4000);
            kindSamplers.push(walkLoop);
        } else if (SCENARIO === "conv") {
            // Exchange speakTo/speakAccept so the sensor logs conversation-type reports.
            const convLoop = setInterval(async () => {
                await pA.evaluate(() => { if (typeof window.wsnGame.speakTo !== "function") throw new Error("speakTo unavailable"); window.wsnGame.speakTo(0); })
                    .catch(error => rec.invalidReasons.push(error.message));
                await sleep(200);
                await pB.evaluate(() => { if (typeof window.wsnGame.speakAccept !== "function") throw new Error("speakAccept unavailable"); window.wsnGame.speakAccept(); })
                    .catch(error => rec.invalidReasons.push(error.message));
            }, 5000);
            kindSamplers.push(convLoop);
        } else if (SCENARIO === "churn") {
            // ±22 tiles every 8 s — crosses the proximity border.
            let dir = 1;
            const churnLoop = setInterval(async () => {
                await pA.evaluate((d) => window.wsnGame.teleport(d, 0), dir * 22)
                    .catch(error => rec.invalidReasons.push(error.message));
                dir *= -1;
            }, 8000);
            kindSamplers.push(churnLoop);
        }

        await sleep(HOLD_MS);
        kindSamplers.forEach(clearInterval);

        // Collect final sensor stats from both clients.
        for (const [label, page] of [["A", pA], ["B", pB]]) {
            try {
                const snapshot = await page.evaluate(readSensorStats);
                rec.clients[label] = snapshot;
                for (const [k, v] of Object.entries(snapshot.kindCounts)) {
                    kindCounts[k] = (kindCounts[k] || 0) + v;
                }
            } catch (e) { rec.invalidReasons.push(`sensor ${label}: ${e.message}`); }
        }

        rec.valid = rec.invalidReasons.length === 0;
    } catch (error) { rec.invalidReasons.push(error.message); }
    finally {
        kindSamplers.forEach(clearInterval);
        const file = path.join(OUT_DIR, `wsn-sensing-${SCENARIO}-${STAMP}.json`);
        fs.writeFileSync(file, JSON.stringify(rec, null, 1));
        log(`wrote ${path.basename(file)}; valid=${rec.valid}`);
        if (!rec.valid) process.exitCode = 1;
        await browser.close();
    }
})();
