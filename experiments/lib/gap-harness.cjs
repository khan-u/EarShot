"use strict";
const path = require("path");
const fs = require("fs");
const { TS_CLIENT, FAKE_MEDIA_ARGS, bootContext, loginPage, log } = require("./wsn-client.cjs");
const { ensureToneWav } = require("./tonegen.cjs");
const { gapTrip } = require("./gap-trip.cjs");

async function runGapHarness(kind, graceMs, absenceMs) {
    const directory = process.env.EXPERIMENT_DATA_DIR || path.join(__dirname, "..", "runs");
    fs.mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const uid = Date.now().toString(36).slice(-6);
    const tone = path.join(__dirname, "..", "assets", "wsn-tone-sweep-48k-180s.wav");
    fs.mkdirSync(path.dirname(tone), { recursive: true });
    ensureToneWav(tone);
    const args = FAKE_MEDIA_ARGS.filter(f => !f.startsWith("--use-file-for-fake-audio-capture"))
        .concat([`--use-file-for-fake-audio-capture=${tone}`]);
    const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));
    const base = process.env.BASE_URL || "http://127.0.0.1:5001";
    const rec = {
        schemaVersion: 3, exportedAt: new Date().toISOString(),
        method: "identified inbound RTP progress; polling proxy, not audible silence",
        applicationBuildId: process.env.APP_BUILD_ID || null,
        clock: "monotonic host performance.now(), milliseconds; browser stats retain their own clocks",
        graceMs, absenceMs, pollIntervalMs: 200, stallConfirmationMs: 1200,
        valid: false, invalidReason: null,
    };
    let a, b;
    try {
        a = await chromium.launch({ channel: "chrome", headless: !process.env.HEADED, args });
        b = await chromium.launch({ channel: "chrome", headless: !process.env.HEADED, args: FAKE_MEDIA_ARGS });
        const ca = await bootContext(a, base, { stripProcessing: true });
        const cb = await bootContext(b, base);
        const pa = await ca.newPage(), pb = await cb.newPage();
        for (const [i, page] of [pa, pb].entries()) {
            await page.goto(base, { waitUntil: "domcontentloaded" });
            await loginPage(page, `gp${uid}${i}`, `gppass${uid}${i}`);
            // Apply grace before either endpoint can form a voice connection.
            await page.evaluate(ms => { const c = window.wsnVoiceCtl; c.setGrace(ms); c.enable(); }, graceMs);
        }
        await gapTrip(pa, pb, rec);
    } catch (error) { rec.valid = false; rec.invalidReason = error.message; }
    finally {
        const file = `wsn-${kind}-identified-${stamp}.json`;
        fs.writeFileSync(path.join(directory, file), JSON.stringify(rec, null, 2) + "\n");
        log(`wrote ${file}; valid=${rec.valid}`);
        if (!rec.valid) { log(rec.invalidReason); process.exitCode = 1; }
        await Promise.allSettled([a?.close(), b?.close()]);
    }
}
module.exports = { runGapHarness };
