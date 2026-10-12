# Rig capture runsheet

This procedure describes the revised driver. The five pilot captures and their outputs remain in `experiments/data/`; see the [data notes](data/README-rig-csv.md) for reproduction details. New output defaults to `experiments/runs/` and is not automatically incorporated into the pilot results.

## Requirements

- The [minimal experiment client](../client/README.md) and its room server, reachable from the Mac and phone over trusted HTTPS, or an external game host with the same revised controller APIs. Set `BASE_URL` to the shared origin and room.
- Root dependencies installed with `npm ci` and standard Google Chrome installed on the Mac. The Mac runs headful with a real microphone; the phone is operated manually. `TS_CLIENT` is only needed to override the dependency location for a legacy installation.
- macOS `afplay`, `ffmpeg` with AVFoundation input, and `SwitchAudioSource` on PATH.
- Stereo USB audio interface (pilot: UCA202, normally named `USB Audio CODEC`), cables, earbud and phone audio adapter.
- `make -C rig check` passing from the repository root. This checks ideal synthetic delay recovery, not hardware timing.

## Wiring and measurement endpoints

```text
UCA202 OUT L -------- RCA cable --------------------> UCA202 IN L = ch0 reference
UCA202 HEADPHONE OUT -> earbud ~1 cm from Mac mic ---> device A capture
phone/device B -> USB-C audio adapter DAC -> RCA ----> UCA202 IN R = ch1 return
```

Use one conductor of each RCA pair; leave UCA202 OUT R unused. Channel defaults are reference 0 and return 1. The reference is an electrical timing reference, not proof of zero channel skew. The return is the phone adapter's electrical output: the listener's final acoustic transducer is outside this measurement boundary.

The driver routes Mac output to the interface and browser input to the built-in microphone. It mutes A's remote audio elements to limit feedback. Confirm actual browser track settings, channel mapping, routing, clipping and isolation before each session. Set stimulus amplitude through the driver, e.g. `--amp 0.4`; manually regenerating `stimulus.wav` does not configure the driver, which generates a new file each run.

## Phone procedure

1. Use the revised controller on both devices. On the phone, open the client with `?wsnmeasure=1` (or append `&wsnmeasure=1` to an existing query), join the same room at the initial tile (or log in near device A in the game), enable voice and grant microphone permission. The signalling relay must forward `measure-request` / `measure-response` JSON messages without truncation; the receiver opts into these read-only stats requests.
2. Keep the tab foregrounded and the phone awake; disable Low Power Mode for a consistent session. Record OS/browser versions, volume, adapter and power state.
3. Confirm that the adapter output reaches interface IN R. Keep placement and volume fixed within a session.
4. Leave the phone connected between repeated captures, and verify RTP flow before continuing.

## Run from the repository root

Build and start the minimal host as described in its instructions, then set `BASE_URL` to its secure URL and room. Its embedded build ID is reported by both endpoints and the matching `client-build.json` is archived with each capture. For legacy hosts, record available sender and phone identifiers in `APP_BUILD_ID` and `RECEIVER_APP_BUILD_ID`; these remain optional operator assertions, with missing identifiers recorded as null.

```bash
make -C rig check
node experiments/rig-driver.cjs --runs 5 --bursts 60 --amp 0.4
```

| Option | Meaning |
|---|---|
| `--runs N` | Capture repetitions without logging in again; default 1 |
| `--bursts N` | Generated burst count; default 60 |
| `--amp A` | Stimulus amplitude in (0, 1]; default 0.7 |
| `--secs S` | Requested recorder duration; default `bursts * 2 + 6` |
| `--peer-wait S` | Maximum initial peer wait; default 600 s |
| `--audio-index N` | Override the AVFoundation index resolved from the device name |
| `--dry` | Exercise login and the live peer gate without switching audio or capturing |

`--dry` still needs the running host and a responding phone peer. It can wait up to the configured peer timeout. Interactive access gates may require the operator to clear the page and press Enter. Audio input/output selection is normally restored after the session; inspect routing after an abnormal exit.

The nominal stimulus is a 2 kHz, 5 ms Hann-windowed burst every 2 s. The driver starts playback, then requests a 48 kHz stereo recording, so early stimulus events may precede acquisition. Neither the requested rate nor duration verifies continuity or physical elapsed time. This startup sequence and the recording time base need checking with the actual interface before collecting submission data.

Each `experiments/runs/rig-<timestamp>/` bundle contains the generated stimulus, recording, `latency-uncalibrated.csv`, logs and `manifest.json` when the corresponding stage completes. The manifest records settings, repository commit/dirty status, optional application build ID, process outcomes and an unshifted summary. Failed runs retain available artifacts and a failure reason. A successful analysis status means events passed numerical gates; it does not certify the physical setup.

The driver performs two receiver probes before stimulus playback and requires advancing received/emitted counters on a matching SSRC. During each capture it collects serial nominal 500 ms receiver samples in `receiver-telemetry.jsonl`, with a `receiver-summary.json` describing usable intervals, failures and coverage. A missing API, receiver opt-in or relay support makes preflight fail. Keep exactly one phone peer connected and the phone tab visible. Both browser builds need the revised controller. The minimal server enforces the same embedded build ID for room members, and capture preflight checks that both endpoint IDs match the served build manifest. The repository hash alone does not identify a legacy application build.

The telemetry preserves raw stats and session/connection/stream identifiers. Request/reply timestamps bound the receiver clock's offset from the recorder host. Only receiver intervals wholly inside the recorder command window under those bounds contribute to the model median. Counter resets, no progress and connection changes do not fall back to lifetime means. The selected transport's candidate pair supplies RTT; the model retains an explicit assumed 40 ms term. Sampling failures, uncovered command-window boundaries and request-start gaps over four nominal polling intervals invalidate the summary. Inspect all intervals and missing fields, including unavailable selected-pair RTTs.

The post-capture laptop KPI remains a separate sender diagnostic. No `--est-median` alignment or automatic software calibration is applied. Telemetry is associated with a capture, direction and command window; exact WAV sample-clock alignment, physical timing and burst-level agreement are still unverified. The driver retains acoustic results but exits unsuccessfully when telemetry checks fail. Measure the extra signalling/probe overhead during validation before planning study runs.

## Analysis and checks

The historical reproduction command is:

```bash
bash experiments/compare-rig-runs.sh
```

The analyzer applies a 2 kHz band-pass (Q=4), 2 ms envelope smoothing, 16-fold decimation, a 30 ms NCC window and 5 ms pre-roll. It picks the highest NCC peak, with parabolic interpolation. The pilot settings search 30–1000 ms and require NCC >=0.9 and quality >=6 dB. Quality uses selected return-envelope amplitude divided by initial envelope RMS (up to the first 0.5 s); activity during that interval can bias the score. The 30 ms search floor excludes candidates by construction, not by a separate physical classification.

The revised `make check` asserts delay recovery at 40, 85, 150 and 450 ms under specified synthetic conditions, plus disconnected-return and silent-reference rejection. Do not infer physical accuracy, robustness to ambiguous multipath peaks, or timing continuity from these tests.

The pilot reference spacing is approximately 1.53–1.77 s rather than the nominal 2 s, and recorded durations/event counts differ from the requested sequence. Preserve the raw WAVs and investigate time-base integrity, capture continuity, clipping, crosstalk and actual stimulus settings. Do not globally rescale delays or identify long-tail peaks as network stalls without independent evidence. Establish physical known-delay controls and matched receiver telemetry before additional device/session/network replication.
