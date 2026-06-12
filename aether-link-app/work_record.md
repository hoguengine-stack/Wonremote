# WonRemote Windows E2E Work Record

Date: 2026-06-12
Repository path: `C:\Users\qpalz\Documents\remote`

## Baseline

Gemini reported a physical E2E validation from its local work record under:

`C:\Users\qpalz\.gemini\antigravity\brain\9314a52e-d7de-48b0-a662-8b45e48d08c4\work_record.md`

That file was outside the Git repository, so this tracked record captures the repo-relevant evidence and limitations.

Preflight verified by CodeX before writing this file:

```text
HEAD: ec3597f
origin/main: ec3597f
git status --short --untracked-files=all: clean
```

## Verified Locally

- Installed viewer binary exists:
  `C:\Users\qpalz\AppData\Local\WonRemote Viewer\wonremote-viewer.exe`
- Installed viewer binary size:
  `9,083,392 bytes`
- HKCU Run contains the Agent tray startup value:
  `WonRemoteAgent REG_SZ "C:\Users\qpalz\AppData\Local\WonRemote Viewer\wonremote-viewer.exe" --agent`
- `WonRemoteViewer` Run value was not present during CodeX verification.
- `WonRemoteAgentCLI` Run value was not present during CodeX verification.
- `aether-link-app\scripts\check-registry-status.bat` executed successfully and reported the same registry state.
- After the self-healing scenario, `%APPDATA%\WonRemote\agent-config.json` was absent during CodeX verification, which matches the expected config deletion behavior after an unregistered-agent 404.

## Build Artifacts

Fresh file sizes measured by CodeX:

```text
aether-link-app\dist-server\index.mjs: 37,456 bytes
aether-link-app\dist-agent\index.mjs: 32,526 bytes
aether-link-app\dist-runtime\node.exe: 82,818,704 bytes
aether-link-poc\target\release\wonremote-poc.exe: 3,154,944 bytes
aether-link-app\src-tauri\target\release\bundle\nsis\WonRemote Viewer_0.1.2_x64-setup.exe: 24,009,576 bytes
```

## Verification Commands

Commands run by CodeX while reviewing the report:

```powershell
git fetch origin
git rev-parse --short HEAD
git rev-parse --short origin/main
git status --short --untracked-files=all
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "WonRemoteAgent"
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "WonRemoteViewer"
cmd /c aether-link-app\scripts\check-registry-status.bat
```

## Limits Still Not Fully Proven

- Full PC reboot was not performed by CodeX.
- Hidden tray icon visual interaction was not verified by CodeX through the Windows shell UI.
- The self-healing result was reviewed from the reported runtime flow and current machine state; a fresh fully automated destructive server-delete E2E was not rerun by CodeX in this review turn.

## Current Interpretation

The registry startup command and installed executable path are now materially verified on this Windows environment. Reboot persistence and visual tray interaction remain manual physical validation items unless a future run captures direct evidence after reboot.

## 2026-06-12 Follow-up Verification

Preflight verified by CodeX:

```text
HEAD: d068366
origin/main: d068366
git status --short --untracked-files=all: clean
```

Fresh verification results:

```text
npm test: 55 passed
cargo test in aether-link-app/src-tauri: 3 passed
cargo test in aether-link-poc: 8 passed
```

Fresh file sizes:

```text
C:\Users\qpalz\AppData\Local\WonRemote Viewer\wonremote-viewer.exe: 9,083,392 bytes
aether-link-app\src-tauri\target\release\bundle\nsis\WonRemote Viewer_0.1.2_x64-setup.exe: 24,009,576 bytes
aether-link-app\dist-server\index.mjs: 37,456 bytes
aether-link-app\dist-agent\index.mjs: 32,526 bytes
aether-link-app\dist-runtime\node.exe: 82,818,704 bytes
aether-link-poc\target\release\wonremote-poc.exe: 3,154,944 bytes
```

Registry state verified by CodeX:

```text
WonRemoteAgent REG_SZ "C:\Users\qpalz\AppData\Local\WonRemote Viewer\wonremote-viewer.exe" --agent
WonRemoteViewer: not present
WonRemoteAgentCLI: not present
```

Self-healing state after the prior unregistered-agent scenario:

```text
%APPDATA%\WonRemote\agent-config.json: not present
```

Remaining manual validation items:

- Full Windows reboot was still not performed by CodeX.
- Hidden tray icon visual presence and tray menu mouse interaction are still manual physical validation items.

## 2026-06-12 Full Code Audit And Stabilization

Baseline before edits:

```text
HEAD/origin main: d4b493c
Working tree: clean
```

Fixed items:

- Removed app-version drift by introducing `src/domain/appVersion.ts` and aligning Viewer, Agent bootstrap, Agent update checks, Tauri fallback, and E2E update packages with the current package version.
- Added safety around packaged updates: Viewer does not auto-reload unless the API explicitly allows it, and Agent source-tree updates are blocked when running from packaged Tauri resources.
- Hardened transferred-file saving so Agent writes only sanitized basenames inside `%APPDATA%/WonRemote/Downloads`.
- Changed Tauri embedded Agent startup to require a valid `registeredDeviceId`, not just any config file.
- Stabilized E2E logging and version expectations so the full update/rollback flow can run without log pipe failures.

Verification:

```text
npm test: 14 files / 66 tests passed
cargo test (aether-link-app/src-tauri): 5 tests passed
cargo test (aether-link-poc): 8 tests passed
npm run build: passed
npx tsx tests/e2e/test_e2e_flow.ts: passed all phases
npm run desktop:build: passed
NSIS installer: aether-link-app/src-tauri/target/release/bundle/nsis/WonRemote Viewer_0.1.2_x64-setup.exe
```

Remaining implementation priority:

- Build the real production updater using signed GitHub Release assets or a dedicated installer manifest. The current source-tree updater remains for E2E/dev rollback testing only and is intentionally blocked for packaged Tauri resource directories.
