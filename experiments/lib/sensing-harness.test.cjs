const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { readSensorStats } = require("./sensor-probes.cjs");
const filename = path.join(__dirname, "..", "sensing.cjs");
async function runHarness({ missingSensor = false, scenario = "idle" } = {}) {
    const writes = []; let closed = false;
    const sense = { stats: () => ({ samples: 3, reports: 2, suppressedPct: 33 }),
        dump: () => [{ kind: "heartbeat" }, { kind: "link" }],
        energy: () => ({ level: 0.9, source: "virtual" }) };
    const page = { goto: async () => {}, evaluate: async (fn, arg) => vm.runInNewContext(
        "(" + fn.toString() + ")(arg)", { arg, window: { proxExperiment: {},
            wsnVoiceCtl: { enable() {} }, wsnSense: missingSensor ? undefined : sense } }) };
    const browser = { close: async () => { closed = true; } };
    const processStub = { argv: ["node", "sensing.cjs", scenario], env: {} };
    const context = vm.createContext({ __dirname: path.dirname(filename), process: processStub,
        setInterval, clearInterval,
        require(name) {
            if (name === "path") return path;
            if (name === "fs") return { mkdirSync() {}, writeFileSync(file, value) { writes.push({ file, record: JSON.parse(value) }); } };
            if (name === "./lib/sensor-probes.cjs") return { readSensorStats };
            if (name === "./lib/tonegen.cjs") return { ensureSpeechWav() {} };
            if (name === "./lib/wsn-client.cjs") return { TS_CLIENT: ".", FAKE_MEDIA_ARGS: [],
                sleep: async () => {}, log() {}, loginPage: async () => {},
                bootContext: async () => ({ newPage: async () => page }) };
            if (name.endsWith("playwright-core")) return { chromium: { launch: async () => browser } };
            throw new Error("unexpected dependency");
        } });
    await vm.runInContext(fs.readFileSync(filename, "utf8"), context);
    assert.equal(closed, true); assert.equal(writes.length, 1);
    assert.equal(path.basename(path.dirname(writes[0].file)), "runs");
    return { record: writes[0].record, exitCode: processStub.exitCode };
}
test("sensing harness saves reports and derived counts from both clients outside the archive", async () => {
    const { record, exitCode } = await runHarness();
    assert.equal(record.valid, true); assert.equal(exitCode, undefined);
    assert.deepEqual(record.kindCounts, { heartbeat: 2, link: 2 });
    assert.equal(record.clients.A.reports.length, 2);
    assert.equal(record.clients.B.energy.source, "virtual");
});
test("sensing harness retains a failed record when sensor probes are unavailable", async () => {
    const { record, exitCode } = await runHarness({ missingSensor: true });
    assert.equal(record.valid, false); assert.equal(exitCode, 1);
    assert.equal(record.invalidReasons.length, 2);
});
test("conversation scenario on the minimal host records an explicit unsupported result", async () => {
    const { record, exitCode } = await runHarness({ scenario: "conv" });
    assert.equal(record.valid, false); assert.equal(exitCode, 1);
    assert.match(record.invalidReasons[0], /full game host/);
});
