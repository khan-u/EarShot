# Minimal browser experiment client

This client provides a room, integer tile positions, proximity discovery and the audio controls needed by the rig and packet-gap experiments. Both devices load the same bundle and the same revised `voice/VoiceRTC.ts`; there is no separate receiver implementation to keep in sync. No game assets, accounts or game server are required.

## Start the client

Use Node.js 22.12 or later and an installed standard Google Chrome for the Mac automation. Browser installation is not part of `npm ci`. Run these commands from the repository root:

```bash
npm ci
npm run build:client
npm run start:client
```

Open `http://localhost:5001` on the Mac. Enter a participant name and room, join, then enable voice. Each device joins the same room with a different name. Leave reloads the page and releases that page's microphone capture. Disabling voice stops the links and mutes the track; leave or close the page to release capture entirely.

A phone needs a reachable HTTPS origin trusted by that phone. Plain HTTP to the Mac's LAN address does not provide microphone access. Supply an existing trusted certificate and key, or use a trusted HTTPS reverse proxy that forwards `/signal` WebSocket upgrades as well as HTTP requests. For direct TLS, place your own certificate files in the ignored `client-secrets/` directory and run:

```bash
HOST=0.0.0.0 TLS_CERT=client-secrets/cert.pem TLS_KEY=client-secrets/key.pem npm run start:client
```

Use the certificate's hostname on both devices. This is a small experiment server for controlled participants; rooms are not authenticated accounts. It defaults to loopback and holds at most 16 participants per room.

The default ICE configuration supplies a STUN server. If the devices require TURN, set `ICE_SERVERS_JSON` to an array of valid browser `RTCIceServer` configurations before starting the server. Credentials are supplied at runtime, not committed. `/api/turn` serves that configuration to the clients. `?wsnforcerelay=1` requests relay-only media; it needs an actual working TURN configuration. Confirm the selected candidate pair in the receiver telemetry before labelling a run as direct or relayed.

## Run experiments

On the phone, open the experiment URL with `?room=earshot&name=Phone&wsnmeasure=1`, join and enable voice. Keep the page visible and the phone awake. If playback is blocked, use **Resume received audio**. The receiver measurements checkbox is an explicit opt-in to requests from room peers.

Set `BASE_URL` to that same HTTPS origin and room on the Mac, then use the [rig runsheet](../experiments/RUNSHEET-rig.md). For example, after setting `BASE_URL`:

```bash
make -C rig check
node experiments/rig-driver.cjs --dry --peer-wait 60
node experiments/rig-driver.cjs --runs 5 --bursts 60 --amp 0.4
```

The dry run still requires a connected phone and starts the real browser microphone; it does not play the stimulus or record the interface. Full captures also need the physical wiring and macOS audio tools listed in the runsheet. `TS_CLIENT` is optional: the harnesses now use this repository's Playwright dependency by default. It remains an override for a legacy external client installation. Harnesses explicitly select installed standard Chrome, not Chrome for Testing.

Formation, DTX, packet-gap and grace harnesses can join this client through the existing `loginPage` adapter. `wsnGame.teleport(dx, dy)` retains relative integer tile movement. `wsnVoiceCtl` exposes the revised identified stream probes and receiver request/reply API. Sensing retains position and link sampling; the game conversation commands `speakTo` and `speakAccept` are absent, and the conversation scenario refuses this host. Game-scene failure reproduction, game rendering load, cluster/election experiments and the separate SFU baseline are outside this minimal host.

Peers within a Euclidean distance of 15 tiles are neighbours; the local participant is excluded. A nominal 20 ms timer reconciles the mesh. Moving 25 tiles west and then 25 east is an out-and-back trip, not two absolute destinations.

## Build and capture identity

`build:client` creates the ignored `client-dist/` directory. `build.json` records the Git commit, dirty status, compiler/runtime versions, relative input filenames and SHA-256 hashes, plus checksums of the served assets. The content-derived build ID is embedded in the browser bundle. Build after committing for a clean, reproducible source reference. Restart the server after rebuilding: the server verifies the files once and holds that complete build in memory for its lifetime.

The server rejects joins from a different build ID. The audio snapshots on both endpoints carry the loaded build ID, and receiver preflight rejects unequal or partially identified builds. The rig saves those reported IDs in `manifest.json` and copies the served manifest to `client-build.json`. Retain that file with the raw capture and telemetry. This is recorded build provenance, not remote attestation. Legacy hosts without build IDs remain explicitly unidentified; optional operator-provided identifiers are recorded separately.

## Host behaviour and experimental limits

See [the provenance note](PROVENANCE.md) for the source reference and the limits of identifying the historical browser builds.

Removed components include game cache loading, map and character rendering, game audio, account/login infrastructure, binary game networking, and conversation/cluster coordination. A room WebSocket replaces the binary game signalling transport. Voice messages, including receiver measurement requests, are relayed as opaque JSON with the sender's server-assigned identity. Media continues through WebRTC, directly or through configured TURN, rather than through the room server.

Microphone capture, Opus negotiation, nonce-based glare handling, peer teardown/grace behaviour, sensing and existing KPI sampling remain in the shared revised voice modules. Browser capture processing remains enabled by default; the rig driver requests disabled AEC/NS/AGC on the sender as documented in its procedure. Check actual track settings on each device.

Removing the game changes CPU, rendering and signalling workload, including the cadence of proximity updates. Establish a new baseline and measure telemetry overhead before comparing with the pilot; do not pool these new measurements with the five historical captures. A passing build and server test do not establish browser interoperability, physical timing accuracy or agreement between telemetry and the acoustic rig.

## Automated checks

```bash
npm run typecheck
npm test
node --test experiments/lib/*.test.cjs
npm run build:client
npm run test:client
```

The client tests cover the proximity boundary, relative movement, served build integrity, room membership, source identity, large measurement messages and rejection of stale builds. The remaining suite covers the controller's pure helpers and capture telemetry. A two-device microphone/playout smoke test and physical rig validation remain required before collecting study data.
