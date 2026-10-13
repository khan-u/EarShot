# Minimal browser experiment client

This client provides a room, integer tile positions, proximity discovery and the audio controls needed by the rig and packet-gap experiments. Both devices load the same bundle and the same revised `voice/VoiceRTC.ts`; there is no separate receiver implementation to keep in sync. No game assets, accounts or game server are required.

The included server serves the browser client and coordinates room membership, tile positions, voice signalling and measurement messages. `npm run start:client` starts this single server process. Audio travels through WebRTC, directly or through TURN.

## Start the client

Use Node.js 22.12 or later and an installed standard Google Chrome for the Mac automation. Browser installation is not part of `npm ci`. Run these commands from the repository root:

```bash
npm ci
npm run build:client
npm run start:client
```

### Join on the Mac

1. Open `http://localhost:5001`.
2. Enter a participant name and room, join, then enable voice and allow microphone access.
3. Use the same room and a different name on each device.

- **Disable voice:** closes the links and mutes the microphone track.
- **Leave:** reloads the page and releases its microphone capture. Closing the page also releases capture.

### Make the server reachable from the phone

The phone needs a reachable HTTPS origin that it trusts. Plain HTTP to the Mac's LAN address does not provide microphone access.

- **Direct TLS:** supply an existing trusted certificate and key in the ignored `client-secrets/` directory, then run:

  ```bash
  HOST=0.0.0.0 TLS_CERT=client-secrets/cert.pem TLS_KEY=client-secrets/key.pem npm run start:client
  ```

- **Reverse proxy:** use trusted HTTPS and forward both HTTP requests and `/signal` WebSocket upgrades. Preserve the request host so the server's WebSocket origin check can succeed.
- **Device URLs:** use the certificate's hostname on both devices.
- **Server scope:** this is a small experiment server for controlled participants. It defaults to loopback, allows at most 16 participants per room, and does not provide authenticated accounts.

### Configure TURN when needed

- The default ICE configuration supplies a STUN server.
- To supply TURN, set `ICE_SERVERS_JSON` to an array of valid browser `RTCIceServer` configurations before starting the server.
  - `/api/turn` serves that configuration to the clients.
  - Supply credentials at runtime; do not commit them.
- `?wsnforcerelay=1` requests relay-only media and requires a working TURN configuration.
  - A failed configuration fetch cannot silently switch that run to a direct path.
  - Confirm the selected candidate pair in receiver telemetry before labelling a run direct or relayed.

## Run experiments

### Prepare the phone

1. Open the experiment URL with `?room=earshot&name=Phone&wsnmeasure=1`.
2. Join and enable voice. The receiver measurements checkbox opts into read-only requests from room peers.
3. Keep the page visible and the phone awake. If playback is blocked, select **Resume received audio**.

### Run the Mac sender

Set `BASE_URL` to the same HTTPS origin and room on the Mac, then follow the [rig runsheet](../experiments/RUNSHEET-rig.md). Close any manually joined Mac participant first: the harness opens and joins its sender automatically, and the phone should have exactly one peer.

After setting `BASE_URL`:

```bash
make -C rig check
node experiments/rig-driver.cjs --dry --peer-wait 60
node experiments/rig-driver.cjs --runs 5 --bursts 60 --amp 0.4
```

- **Dry run**
  - Requires an opted-in phone and starts the real browser microphone.
  - Checks the initial peer gate and advancing, identified forward receiver telemetry.
  - Does not play the stimulus or record the interface.
- **Full capture**
  - Requires the physical wiring and macOS audio tools in the runsheet.
  - Complete the two-device audio checks and physical validation before collecting study data.
- **Browser dependency**
  - Harnesses use this repository's Playwright dependency and explicitly select installed standard Chrome, not Chrome for Testing.
  - `TS_CLIENT` optionally points to an external installation's dependencies; it does not restore removed game APIs.

### Other experiment harnesses

- **Supported entry points:** formation, mobility, sensing, DTX, packet-gap and grace harnesses join through the existing `loginPage` adapter.
- **Movement and proximity**
  - `wsnGame.teleport(dx, dy)` applies relative integer tile movement.
  - Peers within a Euclidean distance of 15 tiles are neighbours; the local participant is excluded.
  - A nominal 20 ms timer reconciles the mesh. Moving 25 tiles west and then 25 east is an out-and-back trip.
- **Measurements and outputs**
  - `wsnVoiceCtl` exposes identified stream probes and receiver request/reply telemetry.
  - Sensing retains position/link sampling. Event counts come from `wsnSense.dump()` and describe its retained report buffer; the raw reports are saved alongside the counts.
  - Mobility timings track peer-object presence, not verified ICE connection or audible recovery.
  - New harness results default to `experiments/runs/`, separate from historical aggregation. Use `EXPERIMENT_DATA_DIR` for other harnesses and `RIG_DATA_DIR` for the rig.
- **Outside this host**
  - Game conversation commands `speakTo` and `speakAccept` are absent; the conversation scenario refuses this client.
  - Game-scene failure reproduction, game rendering load, acoustic VAD/conversation sensing and cluster/election experiments require the full host.
  - The SFU baseline uses its own client and server.

## Build and capture identity

- **Build contents**
  - `build:client` creates the ignored `client-dist/` directory.
  - `build.json` records the Git commit, dirty status, build-tool/runtime versions, relative input filenames and SHA-256 hashes, plus served-asset checksums.
  - The content-derived build ID is embedded in the browser bundle. Build after committing for a clean source reference.
- **Server consistency**
  - Startup verifies the server source and served assets against the manifest.
  - The server holds that complete build in memory for its lifetime. Restart it after rebuilding.
  - Room joins reject a different build ID.
- **Capture identity**
  - Audio snapshots carry each endpoint's loaded build ID. Receiver preflight rejects unequal or partially identified builds.
  - The rig saves those IDs in `manifest.json` and the matching served manifest in `client-build.json`. Retain both with the raw capture and telemetry.
- **Limits**
  - These are recorded build identifiers, not remote attestation.
  - Legacy hosts without build IDs remain explicitly unidentified. Optional operator-provided identifiers are recorded separately.

## Host behaviour and experimental limits

See [the provenance note](PROVENANCE.md) for the source reference and the limits of identifying the historical browser builds.

- **Removed game components**
  - Game cache loading, map/character rendering, game audio and account/login infrastructure.
  - Binary game networking and conversation/cluster coordination.
- **Signalling and media**
  - A room WebSocket replaces binary game signalling.
  - Voice and receiver-measurement messages are addressed by peer index and relayed as opaque JSON.
  - The recipient passes the server-assigned sender index and unchanged message to `VoiceRTC.onSignal`.
  - Media travels through WebRTC, directly or through TURN.
- **Retained voice behaviour**
  - Microphone capture, Opus negotiation, nonce-based glare handling, peer teardown/grace behaviour, sensing and existing KPI sampling remain in the shared revised voice modules.
  - Capture processing is enabled by default. The rig requests disabled AEC/NS/AGC on the sender; check actual track settings on both devices.
- **Comparison with the pilot**
  - Removing the game changes CPU, rendering and signalling workload, including proximity-update cadence.
  - Establish a separate baseline and measure telemetry overhead before comparing results. Do not pool new measurements with the five historical captures without that assessment.
  - A passing build or server test does not establish browser interoperability, physical timing accuracy or telemetry/rig agreement.

## Automated checks

```bash
npm run typecheck
npm test
node --test experiments/lib/*.test.cjs
npm run build:client
npm run test:client
```

See [the review record](REVIEW.md) for corrections and remaining validation.

- **Client checks:** proximity boundaries, relative movement, served-build integrity, room membership, sender identity, large measurement messages and stale-build rejection.
- **Measurement checks:** controller helpers, lifecycle races with stubbed media APIs, capture telemetry, sensor report extraction and audio-route restoration after startup failures.
- **Still required:** two-device microphone/playout checks and independent physical rig validation before collecting study data.
