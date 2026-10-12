const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stimulusArgs, summarizeCsv, analyzeCapture } = require("./rig-analysis.cjs");
const header = "burst,t_ref_s,latency_ms,corr_peak,quality_db,kept\n";

test("capture amplitude reaches stimulus generation; invalid levels fail", () => {
    assert.deepEqual(stimulusArgs(60, .4, "stim.wav"), ["--bursts", "60", "--amp", "0.4", "--out", "stim.wav"]);
    for (const amplitude of [0, -1, 1.1, NaN]) assert.throws(() => stimulusArgs(60, amplitude, "x"));
    assert.throws(() => stimulusArgs(1.5, .4, "x"));
});

test("raw summary excludes rejected rows and retains even-count precision", () => {
    const rows = header + "1,1,136.712,0.99,9,1\n2,3,136.713,0.99,9,1\n3,5,700,0.99,2,0\n";
    const { medianMs, ...counts } = summarizeCsv(rows);
    assert.deepEqual(counts, { analyzed: 3, kept: 2, rejected: 1 });
    assert.ok(Math.abs(medianMs - 136.7125) < 1e-10);
    assert.equal(summarizeCsv(header).medianMs, null);
    assert.throws(() => summarizeCsv(header + "1,1,NaN,.99,9,1\n"));
});

test("analysis is unshifted and unsuccessful acquisition cannot reuse a CSV", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rig-analysis-"));
    try {
        const csv = path.join(directory, "result.csv");
        const result = analyzeCapture("rig", "rec.wav", csv, (command, args) => {
            assert.equal(command, path.join("rig", "analyze"));
            assert.ok(!args.includes("--est-median"));
            fs.writeFileSync(csv, header + "1,1,151.68,.99,9,1\n");
            return { status: 0, stdout: "raw output", stderr: "" };
        });
        assert.equal(result.summary.medianMs, 151.68);
        assert.throws(() => analyzeCapture("rig", "bad.wav", csv, () => ({ status: 1, stderr: "bad WAV" })), /bad WAV/);
        fs.writeFileSync(csv, header + "1,1,750,.99,2,0\n");
        assert.equal(analyzeCapture("rig", "rec.wav", csv, () => ({ status: 3 })).summary.kept, 0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
