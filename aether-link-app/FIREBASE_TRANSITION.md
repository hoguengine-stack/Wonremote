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
```

## Firestore Shape

```text
devices/{deviceId}
devices/{deviceId}/commands/{commandId}
sessions/{sessionId}
```

Current Firebase scope:

- Viewer Firebase Auth login.
- Viewer realtime Firestore subscription for registered devices.
- Agent first-run sign-in or auto sign-up with business number + password `1234`.
- The user-facing Agent password remains `1234`; the Firebase Auth password is internally derived as `wonremote-{10 digit business number}-1234` to satisfy Firebase password length requirements.
- Agent device registration and heartbeat updates in Firestore.
- Viewer command creation in `devices/{deviceId}/commands`.
- Agent command polling from Firestore with delivered-state marking.

Still legacy/local in this transition layer:

- Raw screen tile transport.
- Clipboard, chat, file transfer, session history, and updater APIs.
- Final relay transport should move to WebRTC/QUIC instead of Firestore.
