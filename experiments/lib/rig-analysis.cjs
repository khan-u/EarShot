"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function stimulusArgs(bursts, amplitude, output) {
    if (!Number.isInteger(bursts) || bursts < 1) throw new Error("--bursts must be a positive integer");
    if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 1) throw new Error("--amp must be in (0, 1]");
    return ["--bursts", String(bursts), "--amp", String(amplitude), "--out", output];
}

function summarizeCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.shift() !== "burst,t_ref_s,latency_ms,corr_peak,quality_db,kept") throw new Error("unexpected rig CSV header");
    const rows = lines.filter(Boolean).map(line => line.split(","));
    if (rows.some(row => row.length !== 6 || !["0", "1"].includes(row[5]) ||
        row.some(value => value.trim() === "" || !Number.isFinite(Number(value))))) throw new Error("invalid rig CSV row");
    const kept = rows.filter(row => row[5] === "1").map(row => Number(row[2])).sort((a, b) => a - b);
    const n = kept.length;
    return { analyzed: rows.length, kept: n, rejected: rows.length - n,
        medianMs: n ? (kept[Math.floor((n - 1) / 2)] + kept[Math.floor(n / 2)]) / 2 : null };
}

function analyzeCapture(rig, recording, csv, execute = spawnSync) {
    // No software estimate enters the measurement calculation.
    const args = [recording, "--min-corr", "0.9", "--min-lag-ms", "30", "--csv", csv];
    const result = execute(path.join(rig, "analyze"), args, { encoding: "utf8" });
    if (result.error || ![0, 3].includes(result.status)) throw new Error(`analyzer failed: ${result.error || result.stderr || result.status}`);
    const summary = summarizeCsv(fs.readFileSync(csv, "utf8"));
    if ((result.status === 0) !== (summary.kept > 0)) throw new Error("analyzer status and accepted count disagree");
    return { args, exitStatus: result.status, stdout: result.stdout, stderr: result.stderr, summary };
}
module.exports = { stimulusArgs, summarizeCsv, analyzeCapture };
