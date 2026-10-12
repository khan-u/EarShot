#!/usr/bin/env bash
# compare-rig-runs.sh — replication summary across archived rig captures.
# Re-analyzes every data/rig-rec-*.wav with the SAME gates (no est-median, so
# latencies are unshifted reference-to-electrical-return estimates).
set -euo pipefail
cd "$(dirname "$0")"
RIG=../rig
printf "%-38s %6s %10s %10s %10s\n" "capture" "kept" "median_ms" "p95_ms" "mean_ms"
for wav in data/rig-rec-*.wav; do
    out=$("$RIG/analyze" "$wav" --min-corr 0.9 --min-lag-ms 30) || { printf 'Analysis failed for %s\n' "$wav" >&2; exit 1; }
    n=$(echo "$out" | grep -oE "n=[0-9]+ kept of [0-9]+" | grep -oE "^n=[0-9]+" | cut -d= -f2)
    med=$(echo "$out" | awk '/median/{print $2}')
    p95=$(echo "$out" | awk '/p95/{print $2}')
    mean=$(echo "$out" | awk '/mean/{print $2}')
    printf "%-38s %6s %10s %10s %10s\n" "$(basename "$wav")" "${n:-0}" "${med:--}" "${p95:--}" "${mean:--}"
done
echo
echo "Sender KPIs in data/rig-software-medians.csv are unmatched diagnostics, not calibration references."
