const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readSensorStats } = require("./sensor-probes.cjs");
const run = sense => vm.runInNewContext("(" + readSensorStats.toString() + ")()", { window: { wsnSense: sense } });
function fixture() {
    return { stats: () => ({ samples: 8, reports: 3, suppressedPct: 62.5 }),
        dump: () => [{ kind: "move", t: 1 }, { kind: "link", t: 2 }, { kind: "move", t: 3 }],
        energy: () => ({ level: 0.8, source: "battery" }) };
}
test("sensor probe derives report counts from the supported dump API and retains evidence", () => {
    const snapshot = run(fixture());
    assert.equal(snapshot.kindCounts.move, 2);
    assert.equal(snapshot.kindCounts.link, 1);
    assert.equal(snapshot.reports.length, 3);
    assert.equal(snapshot.energy.level, 0.8);
    assert.equal(snapshot.reportScope, "retained sensor report buffer");
});
test("sensor probe rejects missing APIs instead of silently reporting no events", () => {
    assert.throws(() => run(undefined), /API unavailable/);
    for (const key of ["stats", "dump", "energy"]) {
        const sense = fixture(); delete sense[key];
        assert.throws(() => run(sense), /API unavailable/);
    }
});
test("sensor probe distinguishes an empty report buffer from malformed telemetry", () => {
    assert.equal(Object.keys(run({ ...fixture(), dump: () => [] }).kindCounts).length, 0);
    assert.throws(() => run({ ...fixture(), dump: () => [{ t: 1 }] }), /invalid sensor snapshot/);
    assert.throws(() => run({ ...fixture(), stats: () => null }), /invalid sensor snapshot/);
    assert.throws(() => run({ ...fixture(), energy: () => ({ level: NaN }) }), /invalid sensor snapshot/);
});
