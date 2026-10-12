/** Grace on both endpoints. Usage: node experiments/gracegap.cjs [graceMs] [absenceSec] */
const { runGapHarness } = require("./lib/gap-harness.cjs");
runGapHarness("gracegap", Number(process.argv[2] || "0"), Number(process.argv[3] || "6") * 1000)
    .catch(error => { console.error(error.message); process.exitCode = 1; });
