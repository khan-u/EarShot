#!/usr/bin/env python3
"""Assert unshifted numerical recovery; these fixtures do not validate hardware."""
import csv
import statistics
import subprocess
import tempfile
import wave
from pathlib import Path

RIG = Path(__file__).resolve().parents[1]


def run(name, *args, expected=0):
    result = subprocess.run([str(RIG / name), *map(str, args)], capture_output=True, text=True)
    assert result.returncode == expected, result.stdout + result.stderr
    return result


with tempfile.TemporaryDirectory(prefix="rig-recovery-") as directory:
    root = Path(directory)
    stimulus, recording, output = [root / name for name in ("stimulus.wav", "recording.wav", "latency.csv")]
    run("stimulus", "--bursts", 20, "--out", stimulus)
    # Includes the original 85 ms / gain .5 / noise .03 / preroll 250 ms case.
    for delay, gain, noise, preroll in [(40, .3, .01, 750), (85, .5, .03, 250),
                                       (150, .6, .02, 750), (450, .4, .02, 750)]:
        run("synth_recording", "--in", stimulus, "--out", recording,
            "--delay-ms", delay, "--gain", gain, "--noise", noise, "--preroll-ms", preroll)
        run("analyze", recording, "--min-corr", .9, "--min-lag-ms", 30, "--csv", output)
        with output.open() as handle:
            rows = list(csv.DictReader(handle))
        kept = [float(row["latency_ms"]) for row in rows if row["kept"] == "1"]
        assert len(rows) == len(kept) == 20, (delay, len(rows), len(kept))
        median = statistics.median(kept)
        worst = max(abs(value - delay) for value in kept)
        assert abs(median - delay) <= .1, (delay, median)
        assert worst <= .25, (delay, worst)
        print(f"PASS delay={delay} ms, median={median:.3f}, worst error={worst:.3f} ms, kept=20/20")

    # Disconnected return: retain detected reference rows, accept no delay.
    for noise in (0, .03):
        run("synth_recording", "--in", stimulus, "--out", recording, "--gain", 0, "--noise", noise)
        run("analyze", recording, "--min-corr", .9, "--min-lag-ms", 30, "--csv", output, expected=3)
        with output.open() as handle:
            rows = list(csv.DictReader(handle))
        assert len(rows) == 20 and all(row["kept"] == "0" for row in rows)
        print(f"PASS disconnected return, noise={noise}, kept=0/20")

    # A silent reference must not invent clicks or report success.
    with wave.open(str(recording), "wb") as handle:
        handle.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
        handle.writeframes(bytes(48000 * 4))
    run("analyze", recording, "--csv", output, expected=3)
    with output.open() as handle:
        assert list(csv.DictReader(handle)) == []
    run("analyze", recording, "--csv", root / "missing" / "out.csv", expected=1)
    print("PASS silent reference and failed CSV output")
