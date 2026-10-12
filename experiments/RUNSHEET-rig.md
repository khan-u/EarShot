# Rig capture runsheet

This procedure describes the revised driver. The five pilot captures and their outputs remain in `experiments/data/`; see the [data notes](data/README-rig-csv.md) for reproduction details. New output defaults to `experiments/runs/` and is not automatically incorporated into the pilot results.

## Requirements

- A running external game client/server reachable from the Mac and phone, with the controller hooks listed in the root README. Supply `TS_CLIENT` and `BASE_URL`; the phone needs a secure origin for microphone access.
- Playwright-core and Chromium in the external client installation. The Mac runs headful with a real microphone; the phone is operated manually.
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

1. Open the same world, log in near device A, enable voice and grant microphone permission.
2. Keep the tab foregrounded and the phone awake; disable Low Power Mode for a consistent session. Record OS/browser versions, volume, adapter and power state.
3. Confirm that the adapter output reaches interface IN R. Keep placement and volume fixed within a session.
4. Leave the phone connected between repeated captures, and verify RTP flow before continuing.

## Run from the repository root

First set `TS_CLIENT` to the external client path and `BASE_URL` to the world URL. Record the actual deployed application identifier in `APP_BUILD_ID` when available; omitting it leaves a documented null, not a verified build identity.

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

`--dry` still needs the external application and a responding phone peer. It can wait up to the configured peer timeout. Interactive access gates may require the operator to clear the page and press Enter. Audio input/output selection is normally restored after the session; inspect routing after an abnormal exit.

The nominal stimulus is a 2 kHz, 5 ms Hann-windowed burst every 2 s. The driver starts playback, then requests a 48 kHz stereo recording, so early stimulus events may precede acquisition. Neither the requested rate nor duration verifies continuity or physical elapsed time. This startup sequence and the recording time base need checking with the actual interface before collecting submission data.

Each `experiments/runs/rig-<timestamp>/` bundle contains the generated stimulus, recording, `latency-uncalibrated.csv`, logs and `manifest.json` when the corresponding stage completes. The manifest records settings, repository commit/dirty status, optional application build ID, process outcomes and an unshifted summary. Failed runs retain available artifacts and a failure reason. A successful analysis status means events passed numerical gates; it does not certify the physical setup.

The post-capture laptop KPI is stored separately as a sender diagnostic. No `--est-median` alignment is applied and no automatic software calibration is set. Collect receiver-side telemetry with the same direction, peer and time window separately before claiming estimator agreement.

## Analysis and checks

The historical reproduction command is:

```bash
bash experiments/compare-rig-runs.sh
```

The analyzer applies a 2 kHz band-pass (Q=4), 2 ms envelope smoothing, 16-fold decimation, a 30 ms NCC window and 5 ms pre-roll. It picks the highest NCC peak, with parabolic interpolation. The pilot settings search 30–1000 ms and require NCC >=0.9 and quality >=6 dB. Quality uses selected return-envelope amplitude divided by initial envelope RMS (up to the first 0.5 s); activity during that interval can bias the score. The 30 ms search floor excludes candidates by construction, not by a separate physical classification.

The revised `make check` asserts delay recovery at 40, 85, 150 and 450 ms under specified synthetic conditions, plus disconnected-return and silent-reference rejection. Do not infer physical accuracy, robustness to ambiguous multipath peaks, or timing continuity from these tests.

The pilot reference spacing is approximately 1.53–1.77 s rather than the nominal 2 s, and recorded durations/event counts differ from the requested sequence. Preserve the raw WAVs and investigate time-base integrity, capture continuity, clipping, crosstalk and actual stimulus settings. Do not globally rescale delays or identify long-tail peaks as network stalls without independent evidence. Establish physical known-delay controls and matched receiver telemetry before additional device/session/network replication.
