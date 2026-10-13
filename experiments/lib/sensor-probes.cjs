"use strict";

// Self-contained for page.evaluate. Counts describe the retained report buffer,
// not lifetime totals; preserve the reports so the counts can be reproduced.
function readSensorStats() {
    const sense = window.wsnSense;
    if (!["stats", "dump", "energy"].every(key => typeof sense?.[key] === "function"))
        throw new Error("sensor stats, report dump or energy API unavailable");
    const stats = sense.stats(), reports = sense.dump(), energy = sense.energy();
    if (!stats || ![stats.samples, stats.reports, stats.suppressedPct].every(Number.isFinite) ||
        !Array.isArray(reports) || reports.some(report => typeof report?.kind !== "string" || !report.kind) ||
        !Number.isFinite(energy?.level) || typeof energy.source !== "string")
        throw new Error("invalid sensor snapshot");
    const kindCounts = {};
    for (const report of reports) kindCounts[report.kind] = (kindCounts[report.kind] || 0) + 1;
    return { stats, reports, kindCounts, energy, reportScope: "retained sensor report buffer" };
}
module.exports = { readSensorStats };
