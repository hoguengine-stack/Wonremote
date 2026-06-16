# WonRemote Production Update Release

This document covers the signed installer update flow. It does not replace the local test-mode updater used by E2E tests.

## Build Release Assets

```powershell
cd C:\Users\qpalz\Documents\remote\aether-link-app
npm run release:exes
```

Expected local assets:

- `release-exe/WonRemote Viewer_<version>_x64-setup.exe`
- `release-exe/WonRemote-Viewer-Setup.exe`
- `release-exe/WonRemote-Agent-Setup.exe`
- `release-exe/WonRemote-Viewer-Agent-Setup.exe`
- `release-exe/WonRemote-Viewer-Agent-Portable.zip`
- `release-exe/WonRemote-Agent-Portable.zip`

## Publish Release Gate

`release:publish` is locked by default. Do not publish a stable GitHub Release just because build and E2E tests pass.

Before publishing, confirm that all P0/P1 user-facing requirements are complete except explicitly deferred physical J1800/J1900 validation. Then run:

```powershell
$env:WONREMOTE_RELEASE_GATE_APPROVED="YES"
npm run release:publish
Remove-Item Env:\WONREMOTE_RELEASE_GATE_APPROVED -ErrorAction SilentlyContinue
```

For update/rollback E2E testing, use a local fixture/update server instead of publishing a production GitHub Release.

## Create Signing Keys

Run once per signing-key rotation:

```powershell
npm run release:keypair
```

Default output:

- private key: `.local-run/update-signing/update-signing-private.pem`
- public key: `.local-run/update-signing/update-signing-public.pem`

The private key must not be committed. The `.local-run` path is ignored by git.

The public verification key is not secret. It must match the bundled key in
`src/domain/updateTrust.ts` before producing a release installer. Rotate that
bundled key only when intentionally replacing the release signing key.

## Create Signed Manifest

Use an environment variable for the private key path. This avoids npm treating `--private-key` as an npm option on Windows.

```powershell
$env:WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY = ".local-run\update-signing\update-signing-private.pem"
npm run release:manifest
Remove-Item Env:\WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY
```

Default manifest output:

- `release-exe/wonremote-update-manifest.json`

The default update download URL points to the stable latest installer asset:

```text
https://github.com/hoguengine-stack/Wonremote/releases/latest/download/WonRemote-Viewer-Setup.exe
```

Upload these files to the same GitHub Release tag:

- `WonRemote.Viewer_<version>_x64-setup.exe`
- `WonRemote-Viewer-Setup.exe`
- `WonRemote-Agent-Setup.exe`
- `WonRemote-Viewer-Agent-Setup.exe`
- `WonRemote-Viewer-Agent-Portable.zip`
- `WonRemote-Agent-Portable.zip`
- `wonremote-update-manifest.json`

User-facing Firebase Hosting download links:

- Viewer installer: `https://wonremote-a7fd3.web.app/download/viewer`
- Agent installer: `https://wonremote-a7fd3.web.app/download/agent`
- Viewer + Agent installer: `https://wonremote-a7fd3.web.app/download/viewer-agent`
- Viewer + Agent portable zip: `https://wonremote-a7fd3.web.app/download/portable`
- Agent portable zip: `https://wonremote-a7fd3.web.app/download/agent-portable`

## Runtime Verification Key

The packaged API server contains a bundled public verification key in
`src/domain/updateTrust.ts`, so installed EXEs can validate production manifests
without requiring a user-level environment variable.

`WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY` is only an override for tests, temporary
key rotation, or emergency recovery:

```powershell
$env:WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY = Get-Content .local-run\update-signing\update-signing-public.pem -Raw
```

## Local Manifest Verification

```powershell
@'
import { readFileSync } from "node:fs";
import { parseProductionUpdateManifest } from "./src/domain/updateManifest.ts";
const manifest = JSON.parse(readFileSync("release-exe/wonremote-update-manifest.json", "utf8"));
const publicKeyPem = readFileSync(".local-run/update-signing/update-signing-public.pem", "utf8");
console.log(parseProductionUpdateManifest(manifest, { publicKeyPem }));
'@ | npx tsx -
```
