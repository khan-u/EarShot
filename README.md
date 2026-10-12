# PROX-VOICE

**PROX-VOICE: A Proximity-Driven WebRTC Voice Mesh for Wireless Sensor Network Emulation in Browser-Based Virtual Environments**

PROX-VOICE emulates proximity-based neighbour relationships in a browser-based virtual world. Browsers establish WebRTC audio links to nearby peers, with a grace window before departing links are removed. Media normally travels directly between peers, with TURN available as a relay. Discovery and signalling use the game server. This is a virtual proximity overlay, not a physical MANET routing implementation.

This branch contains a [minimal browser experiment client](client/README.md), a room signalling server, the revised voice modules, C++ measurement rig, harnesses and archived study data. Both experiment devices load the same revised voice code without the game application. The complete game still requires its external client and server. `DebugFlags.ts` and `HomeScreen.ts` provide integration stubs; the latter has a no-op UI update method.

<p align="center"><img src="docs/figures/architecture.png" width="420" alt="Game-server control plane, peer-to-peer media, and TURN fallback"></p>

## Repository layout

```text
client/                Minimal browser host, signalling server and source provenance
voice/                 TypeScript voice, negotiation, sensing and KPI modules
rig/                   C++17 stimulus generator, stereo WAV analyzer and fixtures
  tests/               C++ DSP/WAV unit tests and Python synthetic recovery checks
experiments/
  lib/                 Browser helpers, tone generation and measurement helpers/tests
  rig-driver.cjs       Live Mac/phone capture; unshifted analysis and run manifests
  audiogap.cjs         Revised packet-interruption proxy (not audible silence)
  RUNSHEET-rig.md       Wiring, revised capture procedure and pilot limitations
  compare-rig-runs.sh   Re-analyze archived WAVs and print capture summaries
  plot-rig.py          Re-analyze WAVs, verify raw CSVs and regenerate both figures
  aggregate.py         Print historical telemetry summaries with existing filters
  baseline/            RTP-forwarding SFU comparison (werift + ws; no audio mixing)
  data/                134 historical JSON/JSONL files and five WAV/CSV capture sets
  runs/                New rig/packet-gap outputs (generated, ignored by Git)
docs/figures/          Architecture and reproducible pilot figures
```

Other harnesses cover formation (`harness.cjs`), mobility, grace windows, DTX, sensing, and failure diagnostics. They use the read-only controller probes described under **Live experiments** below.

## Pilot result and measurement boundary

Five repeated captures of one device pair in one session yielded **201 accepted events out of 235 analyzed reference events**. The mean of the five capture medians is **143.6 ms**, with **sample SD 9.2 ms**. This is a descriptive summary of five captures, not a confidence interval, pooled event mean, or five independent device pairs. The pooled mean of accepted events is 155.3 ms.

| Capture on 2026-08-25 | Analyzed | Accepted | Unshifted median (ms) | Historical sender KPI (ms) |
|---|---:|---:|---:|---:|
| 21:40:38 | 56 | 53 | 151.680 | 80 |
| 21:42:56 | 52 | 47 | 148.618 | 81 |
| 21:45:14 | 40 | 32 | 130.977 | 82 |
| 21:47:31 | 45 | 39 | 149.827 | 73 |
| 21:49:50 | 42 | 30 | 136.7125 | 73 |

The recorded delay runs from the wired stimulus reference, through the earbud-to-Mac-microphone acoustic leg and WebRTC path, to the **phone adapter's electrical output**. It excludes the listener's final speaker/headphone acoustic output. The values therefore describe reference-to-electrical-return estimates for this setup; they are not a validated air-to-air mouth-to-ear measurement.

<p align="center"><img src="docs/figures/rig-latency.png" width="900" alt="All 201 accepted latency estimates, including the long tail, with a separate detail view and capture medians"></p>

The analyzer selects the highest normalized cross-correlation (NCC) peak within its lag-search window. The pilot reproduction uses `--min-corr 0.9 --min-lag-ms 30`, with default quality threshold 6 dB and maximum lag 1000 ms. The quality score compares the selected return-envelope level with the initial recording-envelope RMS; it is not a local signal-to-noise measurement. The 30 ms floor is a search restriction intended to exclude near-zero crosstalk, not a universal physical lower bound.

Nine accepted estimates exceed 190 ms and three exceed 400 ms. The long-tail estimates and within-capture clusters need further investigation; these recordings alone do not identify jitter-buffer excursions or audio-callback quantization as their cause. The mean being below 150 ms does not establish a per-event or per-device latency guarantee.

### Software comparison

The software model in `voice/metrics.ts` is `round(RTT/2 + jitter-buffer average + 40 ms)`. The sampler runs every two seconds and ordinarily uses changes in cumulative jitter-buffer counters; initial or reset/non-advancing counters fall back to the lifetime ratio. `latRawMedianMs` summarizes retained per-link estimates, including records from earlier links. It is not a time median over a recording.

The pilot driver read the laptop's KPI once after each capture. Its local inbound jitter-buffer statistics describe the opposite direction from the measured laptop-to-phone path, with no matched measurement window. Subtracting these sender diagnostics from the five raw capture medians gives **65.8 ± 10.6 ms** (mean ± sample SD). These are descriptive, unmatched differences, not established device constants or a validated calibration.

<p align="center"><img src="docs/figures/rig-c.png" width="720" alt="Five raw-median minus sender-KPI differences, explicitly labelled as unmatched diagnostics"></p>

The software model already includes 40 ms. Adding the mean residual would give an effective additive term of 105.8 ms above RTT/2 and jitter buffering; that arithmetic does not validate either term physically. Assumed capture/output and codec delays do not provide an independent reference for this residual.

### Provenance and unresolved checks

The EarShot artifact is [`ea7d2c6a6d880a1c41d97e4ca533b17441202c93`](https://github.com/khan-u/prox-voice/tree/ea7d2c6a6d880a1c41d97e4ca533b17441202c93), which identifies the archived code and data. The exact browser builds used during capture were not recorded; see the [source provenance note](client/PROVENANCE.md). The revised harnesses and minimal host postdate those recordings.

Recorded reference-event spacing is approximately 1.53–1.77 s across captures, despite a nominal 2 s stimulus period. Capture durations and event counts also differ from the nominal sequence. Recording continuity, stimulus configuration and time-base accuracy need physical checks before treating the estimates as validated timing. A single global rescaling is not justified by these observations.

Before stronger manuscript claims, validate the physical rig with independent timing and crosstalk/disconnected-return controls; collect receiver-side, direction- and time-matched telemetry with build identifiers; investigate ambiguous peaks and gate sensitivity; and repeat across independent sessions, device pairs and network conditions. Numerical reproduction is available now. Generalized endpoint calibration and physical timing accuracy remain to be established.

## Offline reproduction

Run all commands below from the repository root.

| Component | Requirement |
|---|---|
| Rig and recovery tests | C++17 compiler, `make`, Python >= 3.9 |
| TypeScript tests | Node.js >= 22.12 and dependencies installed with `npm ci` |
| Helper tests | Node.js >= 18; no browser/application needed |
| Historical aggregation | Python >= 3.9, standard library only |
| Figures | Python >= 3.9 and Matplotlib (requirements file below) |

### Build and test

```bash
make -C rig check
npm ci
npm test
npm run typecheck
node --test experiments/lib/*.test.cjs
npm run build:client
npm run test:client
```

The helper and client tests do not launch a browser; the server test binds a temporary loopback port. `make check` runs C++ unit tests and enforces unshifted synthetic recovery at 40, 85, 150 and 450 ms, with varied gain, noise and pre-roll: all 20 events must pass, median error must be <=0.1 ms, and each event's error <=0.25 ms. Disconnected-return and silent-reference controls must accept no events. These tolerances apply to the specified ideal fixtures, not to physical recordings. The analyzer exits with status 3 when no events pass its gates.

### Re-analyze recordings and regenerate figures

```bash
make -C rig
bash experiments/compare-rig-runs.sh
python3 -m venv .venv-figures
.venv-figures/bin/python -m pip install -r experiments/requirements-figures.txt
.venv-figures/bin/python experiments/plot-rig.py
```

The shell script prints per-capture summaries. The Python script independently invokes the analyzer on all five WAVs, checks every generated row against the archived `*-uncalibrated.csv` files, prints descriptive statistics, and writes both PNGs under `docs/figures/`. It never overwrites the archived recordings or CSVs. See [the data notes](experiments/data/README-rig-csv.md) for the historical shifted CSV variant.

### Historical telemetry tables

```bash
python3 experiments/aggregate.py
```

This prints seven groups: formation/KPI/uplink, mobility, legacy packet-gap results, sensing, network conditions, grace windows, and DTX. It retains the historical selection rules: the last lexicographically sorted summary file per client count; complete mobility cycles; `valid: true` legacy gap records; the latest timestamped report per `(condition, session)` for remote telemetry; and nonnegative reconnect gaps for the grace sweep, independently of that sweep's whole-run validity flag. Inspect these filters when interpreting sample sizes.

The aggregation reproduces stored telemetry rather than validating every label or measurement. Legacy `totalSilenceMs` records cannot be assumed to measure audible interruption; the artifact’s harness and stored record formats differ, and its stop-plus-recovery arithmetic omitted the absence interval. The revised packet-gap output uses a separate data format and is deliberately excluded from these historical tables. Software latency rows from single-host loopback and real-network conditions must be reported separately.

## Live experiments

Start the minimal host with `npm ci`, `npm run build:client` and `npm run start:client`. The [client instructions](client/README.md) cover joining, trusted HTTPS for the phone, optional TURN and supported scenarios. Set `BASE_URL` to its reachable secure URL and room; the harnesses use this repository's Playwright dependency and installed standard Chrome. The Mac rig also needs `afplay`, `ffmpeg` with AVFoundation support, `SwitchAudioSource`, and the physical wiring in the [runsheet](experiments/RUNSHEET-rig.md).

Full game experiments still require the external application with the revised controller. `TS_CLIENT` remains an optional dependency-location override for that installation. Removing the game workload changes the experimental conditions; validate a new baseline before comparing this client with the pilot.

| Runtime interface | Purpose |
|---|---|
| `wsnGame.loggedIn()`, `pos()`, `teleport()` | Login and controlled movement |
| `wsnVoice.kpis()` | Retained per-link KPI summary |
| `wsnVoiceCtl.audioStats()` | Identified audio streams, counters, timestamps and selected ICE-pair joins |
| `wsnVoiceCtl.receiverStats(peerIndex, captureId)` | Opt-in stats from the remote receiver over the signalling relay |
| `wsnVoiceCtl.rxAudio()` | Legacy aggregate diagnostic; new experiments use identified stats |
| `wsnVoiceCtl.peers()`, `peerIndices()`, `linkDebug()` | Peer and connection diagnostics |
| `wsnVoiceCtl.setGrace(ms)`, `grace()` | Apply and verify the grace window on both endpoints |
| `wsnSense.stats()`, `links`, `kindCounts?.()` | Sensing diagnostics supplied by the host |
| `wsnEnergy.total()` | Virtual energy debit supplied by the host |

`wsnVoice.setCalibrationMs(C)` remains a manual additive-offset API; calling it sets a software flag, not a scientific validation status. The revised capture driver does not call it or shift acoustic results to match software.

After starting the host and configuring the devices:

```bash
node experiments/rig-driver.cjs --runs 5 --amp 0.4
node experiments/audiogap.cjs 9
```

The rig saves separate per-run stimulus/WAV/raw CSV/log/manifest bundles under `experiments/runs/` (override with `RIG_DATA_DIR`). It records the repository commit, dirty status, and optional operator-supplied `APP_BUILD_ID` (sender) and `RECEIVER_APP_BUILD_ID` (phone). These optional identifiers remain operator assertions. For the minimal client, the driver also records the embedded build IDs reported by both endpoints and archives the matching served manifest as `client-build.json`; unequal or partially identified endpoint builds fail preflight. The sender KPI remains a separately labelled diagnostic. Each capture also saves `receiver-telemetry.jsonl` and `receiver-summary.json`. Both endpoints must contain the revised controller; the phone must opt in with `?wsnmeasure=1` (or `&wsnmeasure=1`), and the host signalling relay must pass the additional `measure-request` and `measure-response` JSON messages without truncation. The minimal room server included here forwards these messages. A legacy game host needs equivalent relay support. The capture preflight verifies request/reply operation, exactly one connected peer, matching sender-outbound/receiver-inbound SSRC, and advancing received/emitted counters. Missing support stops the run before stimulus playback.

Receiver samples retain browser-session, connection, report and SSRC identities, raw counters, request/reply timestamps, visibility and selected-pair joins. A bounded, serial request loop collects them around each recorder command window. Four timestamps bound the receiver-to-host clock offset without assuming symmetric signalling delays; browser stats timestamps are mapped with those bounds. Interval jitter-buffer residence uses counter differences only. Missing intervals, identity changes and long sampling gaps invalidate the telemetry summary. The interval model median keeps the assumed 40 ms term explicit and does not adjust the acoustic measurement.

**Timing boundary:** matching a capture ID and recorder command window does not establish the WAV sample clock's physical origin or continuity. Boundary-straddling intervals are excluded; retained interval durations and clock bounds remain in the summary. RTT/2 remains a path-symmetry assumption, and jitter-buffer residence is an interval average, not a burst-level delay. Validate the clock mapping, capture startup, telemetry overhead and a matched burst/window analysis on the physical setup before claiming agreement. `valid` in the telemetry summary means its software collection checks passed.

The gap and grace harnesses now use `audioStats()`, monotonic host timestamps and serial nominal 200 ms polling. Grace is applied and checked at both endpoints. Movement uses relative tile deltas and checks the outward and return positions. A packet increment is accepted only across observations of the same browser session, peer connection and RTP stream. A new or reset counter must advance on a subsequent poll; its lifetime count alone is not recovery evidence. The 1200 ms threshold confirms a stop and is not added to its onset estimate. Total packet interruption includes the absence. These are polling proxies, subject to browser stats refresh and command timing, and cannot establish audible silence.

New formation, DTX and gap records use `schemaVersion: 3` and `identified` filenames under `experiments/runs/` (override with `EXPERIMENT_DATA_DIR`). They retain raw stats and invalid reasons. Bandwidth uses per-stream byte and timestamp differences and becomes unavailable after stream changes, counter resets or missing reports. A grace absence rate spans the baseline and final absence snapshots, with their command/probe uncertainty; a closed connection makes that whole-window rate unavailable. Peer retention means presence at every sampled poll, not proof of uninterrupted connectivity. Historical aggregation remains separate.

**Live validation still required:** the minimal build includes the revised controller at both endpoints. Missing APIs and failed probes are errors. The game conversation protocol and scene-specific behaviour are absent from this host. Automated checks do not replace a two-device microphone/playout smoke test or a physical rig validation run.

The standalone SFU in `experiments/baseline/` forwards RTP; it does not decode and mix audio. Install its dependencies with `npm install --prefix experiments/baseline` before running `node experiments/baseline.cjs`. Its candidate-pair RTT output is a network proxy, not measured end-to-end audio delay. Historical names such as `serverMixedOneWayMs` should not be interpreted as evidence of mixing or validated one-way timing.

## License

MIT — see [LICENSE](LICENSE).
