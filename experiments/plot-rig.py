#!/usr/bin/env python3
"""Re-analyze the five pilot WAVs, check the archived raw CSVs, then draw figures."""
import csv
import io
import os
import statistics as stats
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "experiments" / "data"
FIGURES = ROOT / "docs" / "figures"
# Avoid requiring a writable user-library cache during offline reproduction.
os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "prox-voice-matplotlib"))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def read_csv(text):
    return list(csv.DictReader(io.StringIO(text)))


def main():
    with (DATA / "rig-software-medians.csv").open() as handle:
        software_rows = list(csv.DictReader(handle))
    captures = []
    with tempfile.TemporaryDirectory(prefix="rig-plots-") as directory:
        for record in software_rows:
            stamp = record["capture"]
            output = Path(directory) / f"{stamp}.csv"
            subprocess.run([str(ROOT / "rig" / "analyze"), str(DATA / f"rig-rec-{stamp}.wav"),
                            "--min-corr", "0.9", "--min-lag-ms", "30", "--csv", str(output)],
                           check=True, stdout=subprocess.DEVNULL)
            rows = read_csv(output.read_text())
            archived = read_csv((DATA / f"rig-latency-{stamp}-uncalibrated.csv").read_text())
            if rows != archived:
                raise RuntimeError(f"Analyzer differs from archived CSV: {stamp}; inspect before changing figures")
            kept = [float(row["latency_ms"]) for row in rows if row["kept"] == "1"]
            captures.append({"stamp": stamp, "rows": rows, "kept": kept,
                             "median": stats.median(kept), "software": float(record["software_median_ms"])})

    medians = [capture["median"] for capture in captures]
    differences = [capture["median"] - capture["software"] for capture in captures]
    pooled = [value for capture in captures for value in capture["kept"]]
    total = sum(len(capture["rows"]) for capture in captures)
    print("capture,analyzed,kept,median_ms,sender_diagnostic_ms,unmatched_difference_ms")
    for capture, difference in zip(captures, differences):
        print(f"{capture['stamp']},{len(capture['rows'])},{len(capture['kept'])},{capture['median']:.4f},{capture['software']:.1f},{difference:.4f}")
    print(f"Accepted {len(pooled)}/{total}; capture medians: mean {stats.mean(medians):.4f}, sample SD {stats.stdev(medians):.4f} ms")
    print(f"Pooled accepted mean: {stats.mean(pooled):.4f} ms; >190 ms: {sum(v > 190 for v in pooled)}; >400 ms: {sum(v > 400 for v in pooled)}")
    print(f"Unmatched differences: mean {stats.mean(differences):.4f}, sample SD {stats.stdev(differences):.4f} ms")
    FIGURES.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10,
                         "axes.spines.top": False, "axes.spines.right": False})
    colors = ["#176B87", "#417A3D", "#91528D", "#BD602D", "#3B60A0"]
    fig, axes = plt.subplots(1, 2, figsize=(9.2, 4.9))
    for axis in axes:
        for i, capture in enumerate(captures, 1):
            values = capture["kept"]
            positions = [i + (((j * 17) % 31) / 30 - .5) * .42 for j in range(len(values))]
            axis.scatter(positions, values, s=15, color=colors[(i - 1) % len(colors)], alpha=.65, edgecolors="none")
            axis.plot([i - .28, i + .28], [capture["median"]] * 2, color="#15202b", linewidth=2.2)
        axis.set_xticks(range(1, len(captures) + 1), [f"{i}\n{len(c['kept'])}/{len(c['rows'])}" for i, c in enumerate(captures, 1)])
        axis.set_xlim(.4, len(captures) + .6)
        axis.set_xlabel("Capture / accepted of analyzed events")
        axis.set_ylabel("Reference-to-electrical-return delay (ms)")
        axis.grid(axis="y", alpha=.2)
    axes[0].set_ylim(0, max(pooled) * 1.08)
    axes[0].set_title("Full range: all accepted events")
    axes[1].set_ylim(100, 190)
    axes[1].set_title("Detail: 100–190 ms (same data)")
    fig.suptitle("Pilot recordings: unshifted latency estimates", fontsize=14, y=.97)
    fig.text(.5, .035, f"Bars: capture medians. Mean ± sample SD of {len(captures)} medians: {stats.mean(medians):.1f} ± {stats.stdev(medians):.1f} ms.\n"
             "Repeated captures of one device pair; numerical reproduction does not establish physical accuracy.", ha="center", fontsize=9)
    fig.subplots_adjust(left=.09, right=.98, top=.82, bottom=.25, wspace=.32)
    fig.savefig(FIGURES / "rig-latency.png", dpi=180)
    plt.close(fig)

    fig, axis = plt.subplots(figsize=(7.3, 4.6))
    positions = list(range(1, len(captures) + 1))
    axis.scatter(positions, differences, s=65, color="#176B87", zorder=3)
    average = stats.mean(differences)
    axis.axhline(average, color="#67727E", linestyle="--", label=f"Mean difference: {average:.1f} ms")
    for x, difference in zip(positions, differences):
        axis.annotate(f"{difference:.1f}", (x, difference), xytext=(0, 10), textcoords="offset points", ha="center")
    axis.set(xlim=(.5, len(captures) + .5), ylim=(0, 100), xticks=positions, xlabel="Capture",
             ylabel="Raw median − sender diagnostic (ms)")
    axis.grid(axis="y", alpha=.2)
    axis.legend(loc="lower left", frameon=False)
    fig.suptitle("Historical software comparison: unmatched differences", fontsize=13, y=.96)
    fig.text(.5, .04, f"Mean ± sample SD: {average:.1f} ± {stats.stdev(differences):.1f} ms across five captures.\n"
             "Direction and time window are unmatched; these are not validated device constants.", ha="center", fontsize=9)
    fig.subplots_adjust(left=.13, right=.96, top=.85, bottom=.25)
    fig.savefig(FIGURES / "rig-c.png", dpi=180)
    plt.close(fig)


if __name__ == "__main__":
    main()
