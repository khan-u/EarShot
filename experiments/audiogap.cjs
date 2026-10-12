/** Identified packet-interruption proxy. Usage: node experiments/audiogap.cjs [absenceSec] */
const { runGapHarness } = require("./lib/gap-harness.cjs");
runGapHarness("packetgap", 0, Number(process.argv[2] || "9") * 1000)
    .catch(error => { console.error(error.message); process.exitCode = 1; });
