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

## Firestore Shape

```text
devices/{deviceId}
devices/{deviceId}/commands/{commandId}
sessions/{sessionId}
sessions/{sessionId}/webrtc/signal
sessions/{sessionId}/viewerCandidates/{candidateId}
sessions/{sessionId}/agentCandidates/{candidateId}
sessions/{sessionId}/fileReceipts/{transferId}
```

Current Firebase scope:

- Viewer Firebase Auth login.
- Viewer realtime Firestore subscription for registered devices.
- Agent first-run sign-in or auto sign-up with business number + password `1234`.
- The user-facing Agent password remains `1234`; the Firebase Auth password is internally derived as `wonremote-{10 digit business number}-1234` to satisfy Firebase password length requirements.
- Agent device registration and heartbeat updates in Firestore.
- Viewer command creation in `devices/{deviceId}/commands`.
- Agent command polling from Firestore with delivered-state marking.
- Viewer and Agent WebRTC data-channel signaling through Firestore for low-latency tile frames, with Firestore tile-frame queue as fallback.
- Agent file-transfer receive receipts in Firestore so the Viewer can distinguish uploaded, partially received, saved, and failed transfers.
- Agent heartbeat publishes display inventory, Wake-on-LAN MAC addresses, and OS input-control diagnostics.

Still legacy/local in this transition layer:

- The capture/input engine is still the Rust PoC binary and still depends on Windows session/UAC constraints.
- A production TURN service is not bundled. Restrictive NAT paths require real TURN credentials in the environment.
- Session history and installer update orchestration still use the local packaged API/process layer.
