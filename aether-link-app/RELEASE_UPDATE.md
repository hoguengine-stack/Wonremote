# WonRemote Production Update Release

This document covers the signed installer update flow. It does not replace the local test-mode updater used by E2E tests.

## Build Release Assets

```powershell
cd C:\Users\qpalz\Documents\remote\aether-link-app
npm run release:exes
```

Expected local assets:

- `release-exe/WonRemote Viewer_<version>_x64-setup.exe`
- `release-exe/WonRemote Viewer.exe`
- `release-exe/WonRemote Agent.exe`

## Create Signing Keys

Run once per signing-key rotation:

```powershell
npm run release:keypair
```

Default output:

- private key: `.local-run/update-signing/update-signing-private.pem`
- public key: `.local-run/update-signing/update-signing-public.pem`

The private key must not be committed. The `.local-run` path is ignored by git.

## Create Signed Manifest

Use an environment variable for the private key path. This avoids npm treating `--private-key` as an npm option on Windows.

```powershell
$env:WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY = ".local-run\update-signing\update-signing-private.pem"
npm run release:manifest
Remove-Item Env:\WONREMOTE_UPDATE_MANIFEST_PRIVATE_KEY
```

Default manifest output:

- `release-exe/wonremote-update-manifest.json`

The default download URL points to:

```text
https://github.com/hoguengine-stack/Wonremote/releases/download/v<version>/WonRemote%20Viewer_<version>_x64-setup.exe
```

Upload both files to the same GitHub Release tag:

- `WonRemote Viewer_<version>_x64-setup.exe`
- `wonremote-update-manifest.json`

## Runtime Verification Key

Configure the packaged API server environment with the public PEM:

```powershell
$env:WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY = Get-Content .local-run\update-signing\update-signing-public.pem -Raw
```

Without `WONREMOTE_UPDATE_MANIFEST_PUBLIC_KEY`, production update checks intentionally return no update.

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
