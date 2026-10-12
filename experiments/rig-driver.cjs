/**
 * rig-driver.cjs — headful Device-A driver for the PROX-VOICE acoustic loopback rig.
 *
 * Runs a headful Chromium as Device A with the real built-in microphone, mutes
 * A's own playout so the phone's return audio cannot re-enter the reference or
 * the microphone, waits for the phone peer, then plays the click train, records
 * both UCA202 channels, and analyzes.
 *
 * Roles on this Mac:  capture host + Device A.   Phone = Device B (manual).
 * Audio routing (set here via SwitchAudioSource, restored on exit):
 *   default OUTPUT = "USB Audio CODEC" (UCA202)  -> afplay stimulus -> splitter ->
 *                                                   earbud @ built-in mic + ref -> IN L
 *   default INPUT  = "MacBook Pro Microphone"    -> Device A getUserMedia
 *   ffmpeg records the UCA202 explicitly by avfoundation index (default 1).
 *
 * Serve the minimal client in this repository, or supply an external game host
 * with the revised controller. This driver saves raw results
 * separately from the historical pilot artifacts. The analysis chain is reproducible standalone: rig/
 * (stimulus, analyze, self-test) plus the archived captures in data/ re-derive
 * the per-capture latency summaries via compare-rig-runs.sh.
 *
 * Usage:
 *   node experiments/rig-driver.cjs --dry
 *       # validate: launch A, login, enable voice, reach the peer-wait gate. No
 *       # audio switching, no capture. Safe to run without the phone/wiring.
 *   node rig-driver.cjs [--secs N] [--bursts N] [--amp 0.7] [--audio-index 1] [--no-restore]
 *       # full run: waits for the phone peer, then captures + analyzes.
 */
"use strict";
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync, execFileSync } = require("child_process");
const { stimulusArgs, analyzeCapture } = require("./lib/rig-analysis.cjs");
const { sampleReceiver, receiverInterval, startTelemetry, summarizeTelemetry, epochMs } = require("./lib/receiver-telemetry.cjs");

// ── config ──────────────────────────────────────────────────────────────────
const TS_CLIENT = process.env.TS_CLIENT || path.resolve(__dirname, "..");
const BASE = process.env.BASE_URL || "http://localhost:5001";
const RIG = process.env.RIG_DIR || path.join(__dirname, "..", "rig");
const DATA = process.env.RIG_DATA_DIR || path.join(__dirname, "runs");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def; };

const DRY = flag("--dry");
const AUDIO_INDEX = opt("--audio-index", null);          // explicit avfoundation index override
const OUT_DEV = process.env.RIG_OUT_DEV || "USB Audio CODEC";
const IN_DEV = process.env.RIG_IN_DEV || "MacBook Pro Microphone";
const BURSTS = parseInt(opt("--bursts", "60"), 10);      // 60 * 2 s = 120 s
const AMPLITUDE = Number(opt("--amp", "0.7"));
stimulusArgs(BURSTS, AMPLITUDE, "stimulus.wav"); // Fail before changing audio devices.
const SECS = parseInt(opt("--secs", String(BURSTS * 2 + 6)), 10);  // capture window (+tail)
const NO_RESTORE = flag("--no-restore");
const PEER_WAIT_MS = parseInt(opt("--peer-wait", "600"), 10) * 1000;  // default 10 min
const RUNS = parseInt(opt("--runs", "1"), 10);           // captures per session (login once, replicate N times)
if (!Number.isInteger(SECS) || SECS < 1 || !Number.isInteger(RUNS) || RUNS < 1 ||
    !Number.isFinite(PEER_WAIT_MS) || PEER_WAIT_MS <= 0) throw new Error("invalid capture duration, run count, or peer wait");
// A non-localhost BASE may sit behind an interactive access gate that cannot
// be filled programmatically. Pause after navigation; the operator clears the
// gate in the browser window and presses ENTER to resume. Force on/off with
// --manual-login / --no-manual-login.
const MANUAL_LOGIN = flag("--no-manual-login") ? false
    : (flag("--manual-login") || !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(BASE));

const { chromium } = require(path.join(TS_CLIENT, "node_modules", "playwright-core"));

let audioIndex = null;   // avfoundation index of the UCA202, resolved at run start

const UID = Date.now().toString(36).slice(-6);
// ISO run stamp for archived artifacts (rig-rec-<STAMP>.wav); sortable and
// unique per run.
const runStamp = () => new Date().toISOString().replace(/[:.]/g, "-");
// Fixed account, reused across runs; the first run creates it and the server
// kicks a lingering previous session on re-login. Override with RIG_USER /
// RIG_PASS.
const USER = process.env.RIG_USER || "Macbook";
const PASS = process.env.RIG_PASS || "rigpass-macbook";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Block until the operator presses ENTER in this terminal.
function waitForEnter(msg) {
    return new Promise((resolve) => {
        console.log("\n" + "=".repeat(72));
        console.log(msg);
        console.log("  When the game login page is visible in the browser, press ENTER here.");
        console.log("=".repeat(72));
        const onData = (d) => {
            if (String(d).includes("\n")) {
                process.stdin.removeListener("data", onData);
                try { process.stdin.pause(); } catch (_) {}
                resolve();
            }
        };
        try { process.stdin.resume(); } catch (_) {}
        process.stdin.on("data", onData);
    });
}

// ── audio device switching (save/restore) ─────────────────────────────────────
// Resolve the UCA202's avfoundation index by name at run time. Indices are
// positional and shift as devices come and go (BlackHole, ZoomAudioDevice,
// AirPods); a stale index can point at a virtual device, which records as
// silence. --audio-index still overrides for manual selection.
function resolveAudioIndex(devName) {
    try {
        const r = spawnSync("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""], { encoding: "utf8" });
        const out = (r.stderr || "") + (r.stdout || "");
        const esc = devName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const m = out.match(new RegExp("\\[(\\d+)\\] " + esc));
        return m ? m[1] : null;
    } catch (_) { return null; }
}

function getDev(kind) { try { return execFileSync("SwitchAudioSource", ["-c", "-t", kind], { encoding: "utf8" }).trim(); } catch { return null; } }
function setDev(kind, name) { try { execFileSync("SwitchAudioSource", ["-t", kind, "-s", name]); log(`audio ${kind} -> ${name}`); return true; } catch (e) { log(`WARN could not set ${kind} to "${name}":`, String(e.message).slice(0, 120)); return false; } }

// ── page-side scripts ─────────────────────────────────────────────────────────
// Strip browser DSP so the 2 kHz click passes cleanly, keep the REAL default mic,
// and continuously mute every remote <audio> element so A never plays B out the UCA202.
function initScript() {
    try {
        localStorage.setItem("juva.world.classic", "1");
        localStorage.setItem("juva.login.bg", "classic");
        localStorage.setItem("juva.skip.voicegate", "1");   // skip the "Set Your Voice" gate
    } catch (_) {}
    try {
        const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (c) => {
            if (c && c.audio) c.audio = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
            return gum(c);
        };
    } catch (_) {}
    // Mute A's playout of the phone: kill any <audio> the client attaches.
    setInterval(() => { document.querySelectorAll("audio").forEach((a) => { a.muted = true; a.volume = 0; }); }, 250);
}

const snap = (page) => page.evaluate(async () => {
    const ctl = window.wsnVoiceCtl;
    let peers = 0;
    try { peers = ctl.peers(); } catch (_) {}
    // wsnVoiceCtl exposes no direct RTCPeerConnection access; rxAudio() is its
    // inbound-RTP probe (packets, emitted samples, loudest audioLevel).
    let rx = { pkts: 0, samples: 0, level: 0 };
    try { rx = await ctl.rxAudio(); } catch (_) {}
    return { peers, pkts: rx.pkts || 0, samples: rx.samples || 0, level: rx.level || 0 };
});

async function loginA(page) {
    if (await page.evaluate(() => typeof window.proxExperiment?.join === "function")) {
        await page.evaluate(name => window.proxExperiment.join(name), USER);
        log("joined the experimental room");
        return;
    }
    log("waiting for login screen…");
    await page.waitForFunction(() => {
        const b = [...document.querySelectorAll("button")].find((x) => /login/i.test(x.textContent || ""));
        return b && !b.disabled;
    }, null, { timeout: 240000 });
    const inp = page.locator("input");
    await inp.nth(0).fill(USER);
    await inp.nth(1).fill(PASS);
    await page.locator("button", { hasText: /^Login/ }).first().click();
    await page.waitForFunction(() => window.wsnGame && window.wsnGame.loggedIn && window.wsnGame.loggedIn() === true, null, { timeout: 60000 });
    log(`logged in as ${USER}`);
}

// ── capture + analyze (real run only) ─────────────────────────────────────────
function run(cmd, args, opts = {}) {
    log("$", path.basename(cmd), args.map(a => path.isAbsolute(a) ? path.basename(a) : a).join(" "));
    const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.status !== 0 && r.stderr) process.stderr.write(r.stderr);
    return r;
}

function record(args, timing, directory) {
    log("$ ffmpeg", args.join(" "));
    return new Promise(resolve => {
        timing.recorderRequestedAtMs = epochMs();
        const child = spawn("ffmpeg", args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
        child.once("spawn", () => { timing.recorderSpawnedAtMs = epochMs(); });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.once("error", error => resolve({ status: null, stdout, stderr: stderr + String(error) }));
        child.once("close", status => {
            timing.recorderClosedAtMs = epochMs(); resolve({ status, stdout, stderr });
        });
    });
}

async function capture(page, runIdx) {
    const stamp = runStamp();
    const directory = path.join(DATA, `rig-${stamp}`);
    fs.mkdirSync(directory, { recursive: true });
    const stim = path.join(directory, "stimulus.wav");
    const rec = path.join(directory, "recording.wav");
    const csv = path.join(directory, "latency-uncalibrated.csv");
    const git = (...args) => {
        try { return execFileSync("git", ["-C", path.join(__dirname, ".."), ...args], { encoding: "utf8" }).trim(); }
        catch (_) { return null; }
    };
    const status = git("status", "--porcelain");
    const manifest = {
        schemaVersion: 3, captureId: `rig-${stamp}`, startedAt: new Date().toISOString(), status: "incomplete",
        repositoryCommit: git("rev-parse", "HEAD"), repositoryDirty: status == null ? null : status !== "",
        applicationBuildId: process.env.APP_BUILD_ID || null,
        receiverApplicationBuildId: process.env.RECEIVER_APP_BUILD_ID || null,
        applicationBuildIdSource: "operator-supplied; not independently verified",
        bursts: BURSTS, amplitude: AMPLITUDE, periodSeconds: 2, captureSeconds: SECS,
        sampleRateHz: 48000, channels: 2, audioIndex,
        minCorrelation: .9, minQualityDb: 6, minLagMs: 30, maxLagMs: 1000,
        returnEndpoint: "phone adapter electrical output",
        senderDiagnostic: null,
        timing: { clock: "host performance.timeOrigin + performance.now(), milliseconds", wavSampleClockAligned: false },
        receiverTelemetry: { status: "incomplete", file: "receiver-telemetry.jsonl" },
    };
    let playback = null;
    let playbackDone = null, monitor = null;
    const cleanText = value => String(value).split(directory + path.sep).join("").split(RIG + path.sep).join("");
    const writeTelemetry = sample => fs.appendFileSync(path.join(directory, "receiver-telemetry.jsonl"), JSON.stringify(sample) + "\n");
    try {
        // Require forward receiver flow and emitted samples before playing.
        const first = await sampleReceiver(page, manifest.captureId);
        writeTelemetry(first);
        if (!first.valid) throw new Error("receiver telemetry preflight failed: " + first.error);
        await sleep(500);
        const second = await sampleReceiver(page, manifest.captureId);
        writeTelemetry(second);
        manifest.loadedClientBuilds = {
            sender: second.exchange?.sender?.applicationBuildId || null,
            receiver: second.exchange?.reply?.snapshot?.applicationBuildId || null,
            source: "self-reported identifiers embedded in the experimental browser build",
        };
        const preflight = receiverInterval(first, second);
        manifest.receiverTelemetry.preflight = preflight;
        if (!preflight.valid) throw new Error("receiver telemetry preflight failed: " + preflight.invalidReason);
        const clientBuild = await page.evaluate(async () => {
            if (!window.proxExperiment) return null;
            const response = await fetch("/build.json", { cache: "no-store" });
            if (!response.ok) throw new Error("client build manifest unavailable");
            const build = await response.json();
            if (build.buildId !== window.proxExperiment.build.buildId) throw new Error("loaded client and served build differ");
            return build;
        });
        if (clientBuild) {
            if (clientBuild.buildId !== manifest.loadedClientBuilds.sender || clientBuild.buildId !== manifest.loadedClientBuilds.receiver)
                throw new Error("capture endpoints do not match the served client build");
            fs.writeFileSync(path.join(directory, "client-build.json"), JSON.stringify(clientBuild, null, 2) + "\n");
            manifest.loadedClientBuilds.manifestFile = "client-build.json";
        }
        monitor = startTelemetry(page, manifest.captureId, writeTelemetry);
        monitor.samples.push(first, second);
        manifest.stimulusArguments = stimulusArgs(BURSTS, AMPLITUDE, "stimulus.wav");
        const generation = run(path.resolve(RIG, "stimulus"), manifest.stimulusArguments, { cwd: directory });
        if (generation.status !== 0) throw new Error("stimulus generation failed");
        log(`playing stimulus + recording UCA202 (avf index ${audioIndex}) for ${SECS}s…`);
        manifest.timing.playbackRequestedAtMs = epochMs();
        playback = spawn("afplay", [stim], { stdio: "ignore" });
        playbackDone = new Promise(resolve => {
            playback.once("error", error => resolve({ error: String(error) }));
            playback.once("close", (code, signal) => resolve({ code, signal }));
        });
        await new Promise((resolve, reject) => {
            playback.once("spawn", () => { manifest.timing.playbackSpawnedAtMs = epochMs(); resolve(); });
            playback.once("error", reject);
        });
        manifest.recorderArguments = ["-y", "-f", "avfoundation", "-i", `:${audioIndex}`,
            "-ar", "48000", "-ac", "2", "-t", String(SECS), "recording.wav"];
        const ff = await record(manifest.recorderArguments, manifest.timing, directory);
        fs.writeFileSync(path.join(directory, "recorder.log"), cleanText((ff.stdout || "") + (ff.stderr || "")));
        if (playback.exitCode == null) playback.kill();
        manifest.playback = await playbackDone;
        manifest.recorderExitStatus = ff.status;
        const samples = await monitor.stop();
        const window = { startMs: manifest.timing.recorderRequestedAtMs, endMs: manifest.timing.recorderClosedAtMs };
        const telemetry = summarizeTelemetry(samples, window);
        fs.writeFileSync(path.join(directory, "receiver-summary.json"), JSON.stringify(telemetry, null, 2) + "\n");
        manifest.receiverTelemetry = { ...manifest.receiverTelemetry, status: telemetry.valid ? "matched-command-window" : "invalid",
            summaryFile: "receiver-summary.json", commandWindow: window, issues: telemetry.issues };
        monitor = null;
        if (ff.status !== 0) throw new Error("ffmpeg failed; see recorder.log");
        if (manifest.playback.error || manifest.playback.code !== 0) throw new Error("stimulus playback failed or was truncated; inspect capture timing");

        // This laptop KPI observes local inbound traffic, not the measured
        // forward return at the phone. Keep it as an unmatched diagnostic.
        try {
            const k = await page.evaluate(() => window.wsnVoice.kpis());
            manifest.senderDiagnostic = { observedAt: new Date().toISOString(),
                latRawMedianMs: Number.isFinite(k?.latRawMedianMs) ? k.latRawMedianMs : null,
                role: "post-capture laptop inbound KPI; direction/window unmatched" };
        } catch (error) { manifest.senderDiagnostic = { error: String(error) }; }
        const analysis = analyzeCapture(RIG, rec, csv);
        manifest.analysisArguments = analysis.args.map(cleanText);
        manifest.analysisExitStatus = analysis.exitStatus;
        manifest.rawSummary = analysis.summary;
        fs.writeFileSync(path.join(directory, "analysis.log"), cleanText((analysis.stdout || "") + (analysis.stderr || "")));
        manifest.status = analysis.summary.kept ? "analyzed" : "no-accepted-events";
        if (!analysis.summary.kept) throw new Error("no events passed the gates; recording and CSV retained");
        if (!telemetry.valid) {
            manifest.status = "analyzed-telemetry-invalid";
            throw new Error("receiver telemetry incomplete; inspect receiver-summary.json before using this capture");
        }
        log(`run ${runIdx}: unshifted median=${analysis.summary.medianMs} ms; kept=${analysis.summary.kept}/${analysis.summary.analyzed}`);
        return { stamp, rigMedian: analysis.summary.medianMs };
    } catch (error) {
        manifest.error = cleanText(error.message);
        if (manifest.status === "incomplete") manifest.status = "failed";
        throw error;
    } finally {
        if (playback && playback.exitCode == null) playback.kill();
        if (playbackDone) manifest.playback = await playbackDone;
        if (monitor) {
            try {
                const samples = await monitor.stop();
                const window = manifest.timing.recorderClosedAtMs ? { startMs: manifest.timing.recorderRequestedAtMs, endMs: manifest.timing.recorderClosedAtMs } : null;
                const telemetry = summarizeTelemetry(samples, window);
                fs.writeFileSync(path.join(directory, "receiver-summary.json"), JSON.stringify(telemetry, null, 2) + "\n");
                manifest.receiverTelemetry.status = "capture-failed";
            } catch { manifest.receiverTelemetry.status = "collection-failed"; }
        }
        if (manifest.receiverTelemetry.status === "incomplete") manifest.receiverTelemetry.status = "preflight-failed";
        manifest.finishedAt = new Date().toISOString();
        fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
        log("capture artifacts saved in", path.basename(directory));
    }
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
    log(`Device-A driver | BASE=${BASE}`);
    log(DRY ? "MODE: dry (validate login + peer gate; no audio switch, no capture)" : `MODE: full run (bursts=${BURSTS}, amplitude=${AMPLITUDE}, capture=${SECS}s)`);

    let prevOut = null, prevIn = null;
    if (!DRY) {
        prevOut = getDev("output"); prevIn = getDev("input");
        setDev("output", OUT_DEV); setDev("input", IN_DEV);
        // Capture-device sanity: resolve the UCA202's CURRENT avfoundation index.
        audioIndex = AUDIO_INDEX != null ? AUDIO_INDEX : resolveAudioIndex(OUT_DEV);
        if (audioIndex == null) {
            log(`ERR cannot find "${OUT_DEV}" in ffmpeg's avfoundation device list — is the UCA202 plugged in?`);
            process.exit(1);
        }
        log(`capture device: [${audioIndex}] ${OUT_DEV}${AUDIO_INDEX != null ? " (explicit --audio-index)" : " (resolved by name)"}`);
    }

    // Persistent profile: Cache Storage (the large game-cache download) and
    // session cookies survive across runs, so the login-screen cache gate is
    // paid once, not per run — and never during the capture window.
    const PROFILE_DIR = path.join(__dirname, ".rig-profile");
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: "chrome",
        headless: false,
        viewport: { width: 390, height: 844 },
        args: ["--autoplay-policy=no-user-gesture-required", "--use-angle=metal", "--enable-gpu"],
    });
    const cleanup = async () => {
        try { await ctx.close(); } catch (_) {}
        if (!DRY && !NO_RESTORE) { if (prevOut) setDev("output", prevOut); if (prevIn) setDev("input", prevIn); }
    };
    process.on("SIGINT", async () => { log("interrupted"); await cleanup(); process.exit(130); });

    try {
        try { await ctx.grantPermissions(["microphone"], { origin: BASE }); } catch (_) {}
        await ctx.addInitScript(initScript);
        const page = ctx.pages()[0] || await ctx.newPage();
        const url = BASE + (BASE.includes("?") ? "&" : "?") + "wsnskipvoice=1";
        await page.goto(url, { waitUntil: "domcontentloaded" });
        if (MANUAL_LOGIN) {
            await waitForEnter(
                "  Manual step: clear any access gate in front of " + BASE + "\n" +
                "  In the headful browser window, sign through any access gate until\n" +
                "  the game's own login page is fully loaded. Automation cannot fill the\n" +
                "  hidden OAuth field, so this part is yours."
            );
            log("operator confirmed; resuming");
        }
        await loginA(page);
        try { const pos = await page.evaluate(() => window.wsnGame.pos && window.wsnGame.pos()); log("Device A spawn tile:", JSON.stringify(pos)); } catch (_) {}
        // Best-effort: dismiss the character-design modal (interface 3559) if it's open.
        try {
            const skip = page.locator("button", { hasText: /^(Skip|Confirm|Accept|Done)/i }).first();
            if (await skip.isVisible({ timeout: 1500 }).catch(() => false)) { await skip.click().catch(() => {}); log("dismissed character-design modal"); }
        } catch (_) {}
        await page.evaluate(() => window.wsnVoiceCtl.enable());
        log("voice enabled on Device A");

        console.log("\n" + "=".repeat(72));
        console.log("  On the phone (device B): log into " + BASE.replace("127.0.0.1", "<this-mac-LAN-IP>"));
        console.log("      append ?wsnmeasure=1 (or &wsnmeasure=1) to opt into receiver telemetry;");
        console.log("      spawn near Device A (shared home tile is in range), enable voice,");
        console.log("      and make sure its headphone-out is wired to the UCA202 RIGHT input.");
        console.log("=".repeat(72) + "\n");

        // Wait for a peer with flowing inbound RTP. If RTP has not advanced for
        // FLUSH_AFTER_MS, the client may be signaling a departed peer (stale
        // server index after a reconnect). Toggling voice off/on tears down all
        // peers and re-discovers whatever is in range. peerIndices + linkDebug
        // separate the failure modes: no peer discovered (out of range) vs a
        // peer whose inPkts stay flat (connected but not sending).
        const FLUSH_AFTER_MS = 15000;
        const t0 = Date.now(); let last = -1, lastProgress = Date.now(), flushes = 0, stallsWithPeer = 0;
        while (Date.now() - t0 < PEER_WAIT_MS) {
            const s = await snap(page);
            if (s.pkts !== last) { log(`peers=${s.peers} rxPkts=${s.pkts} rxSamp=${s.samples} lvl=${s.level.toFixed(3)}`); if (s.pkts > last) lastProgress = Date.now(); last = s.pkts; }
            if (s.peers >= 1 && s.pkts > 50) { log("peer link is up and RTP is flowing."); break; }
            if (Date.now() - lastProgress > FLUSH_AFTER_MS) {
                const dbg = await page.evaluate(async () => {
                    const ctl = window.wsnVoiceCtl; let idx = [], link = [];
                    try { idx = ctl.peerIndices ? ctl.peerIndices() : []; } catch (_) {}
                    try { link = ctl.linkDebug ? await ctl.linkDebug() : []; } catch (_) {}
                    return { idx, link };
                }).catch(() => ({ idx: [], link: [] }));
                log(`stall — peerIndices=${JSON.stringify(dbg.idx)} link=${JSON.stringify(dbg.link)}`);
                if (dbg.idx.length === 0) {
                    // No peer discovered: stale state or out of range. Flush to re-scan.
                    log(`no peer discovered; flushing voice to re-discover [#${++flushes}]`);
                    await page.evaluate(async () => { const c = window.wsnVoiceCtl; try { c.disable(); } catch (_) {} await new Promise((r) => setTimeout(r, 800)); try { c.enable(); } catch (_) {} }).catch(() => {});
                } else if (++stallsWithPeer % 4 !== 0) {
                    // Peer discovered, handshake not completing: the offer went out
                    // and no answer returned (phone-side: voice off, consent prompt
                    // pending, mic not granted, or tab backgrounded). Re-offering
                    // resets ICE, so hold the offer and report.
                    log(`peer ${JSON.stringify(dbg.idx)} discovered, no answer; on the phone: enable voice, accept any mic/consent prompt, keep the tab foregrounded`);
                } else {
                    // A discovered peer can itself be stale (dead session after a
                    // server restart). A live phone answers within seconds, so after
                    // three held stalls flush anyway: re-discovery drops indexes the
                    // server roster no longer has, and a blocked phone gets a fresh
                    // offer once it recovers.
                    log(`peer ${JSON.stringify(dbg.idx)} unanswered after ${stallsWithPeer} stalls; flushing voice and re-offering [#${++flushes}]`);
                    await page.evaluate(async () => { const c = window.wsnVoiceCtl; try { c.disable(); } catch (_) {} await new Promise((r) => setTimeout(r, 800)); try { c.enable(); } catch (_) {} }).catch(() => {});
                }
                lastProgress = Date.now();
            }
            await sleep(3000);
        }
        const s = await snap(page);
        if (!(s.peers >= 1 && s.pkts > 50)) { log("no peer / no RTP within the wait window — is the phone logged in and in range?"); await cleanup(); process.exit(1); }

        if (DRY) { log("DRY RUN OK — automation reached a live peer link. Stopping before capture."); await cleanup(); process.exit(0); }

        const results = [];
        for (let runIdx = 1; runIdx <= RUNS; runIdx++) {
            if (runIdx > 1) {
                // Between runs: confirm RTP is still flowing (the phone can
                // reload/sleep between captures). Wait up to 2 min for packets
                // to advance again before the next capture.
                log(`--- run ${runIdx}/${RUNS}: re-checking peer link…`);
                const t1 = Date.now(); let prevPkts = -1, okLink = false;
                while (Date.now() - t1 < 120000) {
                    const s2 = await snap(page);
                    if (prevPkts >= 0 && s2.pkts > prevPkts) { okLink = true; break; }
                    prevPkts = s2.pkts;
                    await sleep(3000);
                }
                if (!okLink) { log("peer RTP stalled between runs — stopping after " + results.length + " capture(s)"); break; }
            }
            await sleep(8000);   // let the link + software sampler settle
            const r = await capture(page, runIdx);
            if (r) results.push(r);
        }
        if (results.length > 1) {
            const medians = results.map(r => r.rigMedian);
            const mean = medians.reduce((x, y) => x + y, 0) / medians.length;
            log(`ensemble: ${medians.length} capture medians, mean=${mean.toFixed(3)} ms`);
            for (const r of results) log(`  ${r.stamp} unshifted median=${r.rigMedian} ms`);
        }
        log("done.");
        await cleanup();
        process.exit(0);
    } catch (e) {
        log("ERR", String(e).slice(0, 300));
        await cleanup();
        process.exit(1);
    }
})();
