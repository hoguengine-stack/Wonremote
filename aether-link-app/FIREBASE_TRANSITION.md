# WonRemote Firebase Transition

WonRemote can run the account, device list, heartbeat, and command queue through Firebase when Firebase environment variables are set. If they are not set, the app keeps the existing local API mode for development.

## Viewer Environment

These values are read by Vite at build time:

```powershell
$env:VITE_WONREMOTE_FIREBASE_API_KEY="..."
$env:VITE_WONREMOTE_FIREBASE_AUTH_DOMAIN="..."
$env:VITE_WONREMOTE_FIREBASE_PROJECT_ID="..."
$env:VITE_WONREMOTE_FIREBASE_APP_ID="..."
$env:VITE_WONREMOTE_FIREBASE_STORAGE_BUCKET="..."
$env:VITE_WONREMOTE_FIREBASE_MESSAGING_SENDER_ID="..."
$env:VITE_WONREMOTE_RTC_STUN_URLS="stun:stun.l.google.com:19302"
$env:VITE_WONREMOTE_RTC_TURN_URLS="turn:turn.example.com:3478"
$env:VITE_WONREMOTE_RTC_TURN_USERNAME="..."
$env:VITE_WONREMOTE_RTC_TURN_CREDENTIAL="..."
```

## Agent Environment

These values are read by the packaged Agent at runtime:

```powershell
$env:WONREMOTE_FIREBASE_API_KEY="..."
$env:WONREMOTE_FIREBASE_AUTH_DOMAIN="..."
$env:WONREMOTE_FIREBASE_PROJECT_ID="..."
$env:WONREMOTE_FIREBASE_APP_ID="..."
$env:WONREMOTE_FIREBASE_STORAGE_BUCKET="..."
$env:WONREMOTE_FIREBASE_MESSAGING_SENDER_ID="..."
$env:WONREMOTE_RTC_STUN_URLS="stun:stun.l.google.com:19302"
$env:WONREMOTE_RTC_TURN_URLS="turn:turn.example.com:3478"
$env:WONREMOTE_RTC_TURN_USERNAME="..."
$env:WONREMOTE_RTC_TURN_CREDENTIAL="..."
```

Set `VITE_WONREMOTE_RTC_RELAY_ONLY=true` and `WONREMOTE_RTC_RELAY_ONLY=true` only when the deployment must force TURN relay traffic for restrictive NAT/firewall tests.

Release builds read the matching GitHub Actions variables/secrets (`WONREMOTE_RTC_STUN_URLS`, `WONREMOTE_RTC_TURN_URLS`, `WONREMOTE_RTC_TURN_USERNAME`, `WONREMOTE_RTC_TURN_CREDENTIAL`, `WONREMOTE_RTC_RELAY_ONLY`, and `WONREMOTE_RTC_CONNECT_TIMEOUT_MS`). The Tauri host maps the build-time `VITE_` values into the packaged Agent process so Viewer and Agent cannot silently ship with different ICE settings.

TURN remains part of WebRTC. Configure an operating TURN service before claiming reliable first-connect behavior across symmetric NAT or UDP-blocked networks. Static TURN credentials embedded in an installer are extractable, so production should use short-lived credentials issued by a trusted backend.

Firestore tile streaming fallback is disabled by default because screen frames can consume Firestore writes, reads, and egress quickly. Use it only for short diagnostics:

```powershell
$env:WONREMOTE_ALLOW_FIRESTORE_STREAM_FALLBACK="1"
$env:WONREMOTE_FIRESTORE_STREAM_FALLBACK_MAX_FRAMES="60"
$env:WONREMOTE_FIRESTORE_STREAM_FALLBACK_MAX_MS="15000"
```

## Firestore Shape

```text
devices/{deviceId}
devices/{deviceId}/commands/{commandId}
secureChallenges/{challengeId}
sessions/{sessionId}
sessions/{sessionId}/webrtc/signal
sessions/{sessionId}/viewerCandidates/{candidateId}
sessions/{sessionId}/agentCandidates/{candidateId}
sessions/{sessionId}/fileReceipts/{transferId}
sessions/{sessionId}/files/{fileId}        # metadata only
storage: sessions/{sessionId}/files/{transferId}/{fileName}
```

Current Firebase scope:

- Viewer Firebase Auth login.
- Viewer realtime Firestore subscription for registered devices.
- Agent first-run sign-in or auto sign-up with business number + password `1234`.
- The user-facing Agent password remains `1234`; the Firebase Auth password is internally derived as `wonremote-{10 digit business number}-1234` to satisfy Firebase password length requirements.
- Agent device registration and heartbeat updates in Firestore.
- Viewer session open, secure session challenge, input command enqueue, and session close prefer callable Cloud Functions when they are available. Spark-plan development builds use a Firestore direct-write fallback constrained by `firestore.rules`.
- Agent command polling from Firestore with delivered-state marking.
- Optional secure connection flow: callable functions or the Spark fallback create `secureChallenges/{challengeId}`, queue `security-code <challengeId> 000 000` for the Agent, and open the session only after the Viewer-entered code matches.
- Viewer and Agent WebRTC data-channel signaling through Firestore for low-latency tile frames. Firestore tile-frame queue is a disabled-by-default diagnostic fallback, not the production stream path.
- Agent file-transfer receive receipts in Firestore so the Viewer can distinguish uploaded, partially received, saved, and failed transfers.
- Firebase online file transfer sends large payloads through Firebase Storage and stores only metadata in Firestore. The Agent resolves the authenticated `storagePath`, streams the download to disk, verifies size/checksum metadata when present, and posts a receipt.
- Firestore direct file documents are limited to small diagnostic fallback payloads. They are not the 500MB transfer path.
- Agent heartbeat publishes display inventory, Wake-on-LAN MAC addresses, and OS input-control diagnostics.

Still legacy/local in this transition layer:

- The capture/input engine is still the Rust PoC binary and still depends on Windows session/UAC constraints.
- A production TURN service is not bundled. Restrictive NAT paths require real TURN credentials in the environment.
- Session history and installer update orchestration still use the local packaged API/process layer.
- Cloud Functions require the Firebase Blaze plan. Spark-plan testing must use the direct Firestore fallback plus deployed rules/hosting.
- Firebase Storage rules must be deployed with Firestore rules before online 500MB file transfer is tested on separate PCs.
- If Firebase Storage has not been initialized in the Firebase console, `npm run firebase:deploy:spark:no-storage` can deploy Firestore rules and Hosting for core online login/device/session checks only. Do not use that path to validate 500MB file transfer.
