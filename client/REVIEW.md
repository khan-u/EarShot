# Experiment implementation review

This review covers the minimal host, room server, shared voice controller, source provenance, build manifest, harness integration, and the related README and rig procedure. The original measurement archive is retained separately from all new outputs.

## Corrections made

- Removed the inherited game voice icon, floating panel, conversation/turn-taking methods and conversation-only VAD loop. The bundle retains proximity audio, link/position sensing, legacy KPI diagnostics and identified receiver telemetry.
- Invalidated asynchronous peer creation when voice is disabled. A pending microphone request cannot create a connection in an ended session, and an earlier creation promise cannot remove a later session's pending entry.
- Detached retired connection callbacks and checked peer identity before processing delayed events or sending offers/answers. Closing an old connection cannot close its replacement at the same peer index. Track replacement failures are caught and logged.
- Preserved relay-only ICE policy when configuration retrieval fails, bounded that fetch, and respected an explicitly empty server list. A requested relay experiment must not silently fall back to direct media.
- Verified and held the served assets in memory for the server's lifetime. Startup checks the server source against the build manifest; rebuilding requires a server restart. Room joins reject stale client build IDs. Capture preflight compares both endpoint IDs and saves the served build manifest.
- Restored audio routing on rig startup failures and stopped on failed route selection. The minimal HTTPS host no longer triggers the legacy game-login pause. A dry run now checks advancing, identified forward receiver telemetry as well as the initial peer gate.
- Corrected documentation of active sensing APIs, KPI sampling, unsupported game features, and the difference between a source candidate and a confirmed deployed build.

## Verification

Type checking, the browser bundle build, 56 TypeScript tests, 35 measurement/helper tests and two server integration tests pass. Controller lifecycle tests use stubbed media APIs. Rig startup tests substitute process/browser calls and do not change real audio routing or launch a browser. Server tests exercise actual local HTTP/WebSocket connections, room isolation, sender identity, receiver-message forwarding, stale-build rejection and asset integrity. All 150 archived WAV, CSV, JSON and JSONL measurement files remain byte-identical to the EarShot artifact.

## Remaining validation

No real browser microphone/playout test or new physical capture was performed during this work. Before study collection, check both target devices, microphone settings and permissions, playout, receiver opt-in, selected ICE route, grace teardown/recovery, telemetry coverage and instrumentation overhead. Resolve the pilot's recording time-base discrepancy and validate the physical rig independently.

The minimal host removes the game workload and replaces its signalling transport. Its results need a separate baseline; automated tests do not establish equivalence to the pilot, browser interoperability or physical timing accuracy. The server is intended for controlled experiments, with trusted HTTPS on the phone and TURN supplied when required. It does not provide game accounts, public-service authentication or the removed conversation protocol.
