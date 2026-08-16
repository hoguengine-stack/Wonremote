# WonRemote Production Update Release

This document covers the signed installer update flow. It does not replace the local test-mode updater used by E2E tests.

## Build Release Assets

```powershell
cd C:\Users\qpalz\Documents\remote\aether-link-app
npm run release:exes
```

Expected local assets:

- `release-exe/WonRemote-Viewer-Setup.exe`
- `release-exe/WonRemote-Agent-Setup.exe`

Build efficiency and isolation rules:

- For each architecture, the Viewer build produces the frontend and architecture-specific runtime resources; the following Agent build reuses those verified resources instead of rebuilding them.
- Release packaging builds only the `i686-pc-windows-msvc` target. Do not add an x64 release worker without changing and reviewing the signed update compatibility contract.
- GitHub Actions caches the x86 Rust target and downloaded build tools.

## Publish Release Gate

`release:publish` is locked by default. Do not publish a stable GitHub Release just because build and E2E tests pass.

Before publishing, confirm that all P0/P1 user-facing requirements are complete except explicitly deferred physical J1800/J1900 validation. Then run:

```powershell
$env:WONREMOTE_RELEASE_GATE_APPROVED="YES"
npm run release:publish
Remove-Item Env:\WONREMOTE_RELEASE_GATE_APPROVED -ErrorAction SilentlyContinue
```

For update/rollback E2E testing, use a local fixture/update server instead of publishing a production GitHub Release.

## Mandatory Failure Rules

- Any failed, timed-out, hung, or skipped build, test, signing, upload, or verification step blocks all later release steps.
- Never retry a failed release step until its root cause and focused regression proof are recorded.
- A release is incomplete until one tag contains exactly these three assets: the x86 Viewer installer, the x86 Agent installer, and `wonremote-update-manifest.json`.
- Each installer contains only the x86 runtime and supports both 32-bit and 64-bit Windows. The manifest signs that same x86 installer independently under x64 and x86 metadata so previously installed x64 clients can migrate without losing automatic updates.
- A published version is immutable. Never delete, replace, retag, or publish over exposed release assets. Every changed installer requires a strictly new version and tag so installed clients can detect it.
- The publisher must keep the release private until the exact three uploaded asset names and byte sizes match the local signed assets.
- Before publication, the publisher downloads every uploaded asset from GitHub's asset API and verifies the remote manifest, signatures, and installer checksums again. A failed remote check leaves the release private.
- Record the failed stage, tag, commit, uploaded assets, and recovery decision before retrying.

## Required Release Evidence

Before declaring a release usable, collect fresh evidence for the same commit and tag:

1. The two x86 installer filenames, sizes, SHA-256 values, x86 source payload identity, and product role.
2. The manifest version, signed asset URLs, checksums, signatures, and tag match.
3. The Viewer and Agent Firebase download redirects, including x86 compatibility aliases, resolve to the intended installers.
4. A previous installed Viewer and Agent can discover the release, verify it, install it, restart, and report the target version.

Build success alone is not release success. An update failure must retain the current installation and configuration, clear any update-in-flight lock, emit a stage-specific runtime log, and never execute an unverified installer.

Every resolved production defect must be appended to `../INCIDENT_REGISTRY.md` before a release is declared usable. The entry must include the symptom, root cause, fix commit, focused regression command, release evidence, and whether physical verification remains required.

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

The default update download URL is bound to the immutable release tag for the current version:

```text
https://github.com/hoguengine-stack/Wonremote/releases/download/v0.1.61/WonRemote-Viewer-Setup.exe
```

Upload these files to the same GitHub Release tag:

- `WonRemote-Viewer-Setup.exe`
- `WonRemote-Agent-Setup.exe`
- `wonremote-update-manifest.json`

User-facing Firebase Hosting download links:

- Viewer installer: `https://wonremote-a7fd3.web.app/download/viewer`
- Agent installer: `https://wonremote-a7fd3.web.app/download/agent`
- Legacy x86 download URLs remain compatibility aliases for the same two x86 installers.

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
