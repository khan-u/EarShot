const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const filename = path.join(__dirname, "..", "rig-driver.cjs");
const realRequire = createRequire(filename);
async function failedStartup({ missingInterface = false, failedOutput = false } = {}) {
    const changes = [], exits = []; let launches = 0;
    const child = {
        execFileSync(command, args) {
            assert.equal(command, "SwitchAudioSource");
            if (args[0] === "-c") return args[2] === "output" ? "Original output" : "Original input";
            changes.push([args[1], args[3]]);
            if (failedOutput && args[3] === "USB Audio CODEC") throw new Error("routing unavailable");
            return "";
        },
        spawnSync(command) { assert.equal(command, "ffmpeg"); return { stderr: missingInterface ? "" : "[0] USB Audio CODEC" }; },
        spawn() { throw new Error("capture must not start"); },
    };
    const context = vm.createContext({
        require: name => name === "child_process" ? child : name.endsWith("playwright-core") ? {
            chromium: { async launchPersistentContext() { launches++; throw new Error("browser unavailable"); } },
        } : realRequire(name),
        __dirname: path.dirname(filename), console: { log() {} },
        process: { argv: ["node", filename], env: {}, once() {}, exit: code => exits.push(code), stdout: { write() {} }, stderr: { write() {} } },
        setTimeout, clearTimeout,
    });
    await vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename: "rig-driver.cjs" });
    return { changes, exits, launches };
}
test("restores both initial audio routes when browser startup fails", async () => {
    const r = await failedStartup();
    assert.equal(r.launches, 1); assert.deepEqual(r.exits, [1]);
    assert.deepEqual(r.changes.slice(-2), [["output", "Original output"], ["input", "Original input"]]);
});
test("restores routes and never launches a browser when the capture interface is absent", async () => {
    const r = await failedStartup({ missingInterface: true });
    assert.equal(r.launches, 0); assert.deepEqual(r.exits, [1]);
    assert.deepEqual(r.changes.slice(-2), [["output", "Original output"], ["input", "Original input"]]);
});
test("a failed output selection stops startup instead of recording the wrong route", async () => {
    const r = await failedStartup({ failedOutput: true });
    assert.equal(r.launches, 0); assert.deepEqual(r.exits, [1]);
    assert.deepEqual(r.changes, [["output", "USB Audio CODEC"], ["output", "Original output"], ["input", "Original input"]]);
});
