# AetherLink Windows E2E Work Record

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
  `C:\Users\qpalz\AppData\Local\AetherLink Viewer\aether-link-viewer.exe`
- Installed viewer binary size:
  `9,083,392 bytes`
- HKCU Run contains the Agent tray startup value:
  `AetherLinkAgent REG_SZ "C:\Users\qpalz\AppData\Local\AetherLink Viewer\aether-link-viewer.exe" --agent`
- `AetherLinkViewer` Run value was not present during CodeX verification.
- `AetherLinkAgentCLI` Run value was not present during CodeX verification.
- `aether-link-app\scripts\check-registry-status.bat` executed successfully and reported the same registry state.
- After the self-healing scenario, `%APPDATA%\AetherLink\agent-config.json` was absent during CodeX verification, which matches the expected config deletion behavior after an unregistered-agent 404.

## Build Artifacts

Fresh file sizes measured by CodeX:

```text
aether-link-app\dist-server\index.mjs: 37,456 bytes
aether-link-app\dist-agent\index.mjs: 32,526 bytes
aether-link-app\dist-runtime\node.exe: 82,818,704 bytes
aether-link-poc\target\release\aether-link-poc.exe: 3,154,944 bytes
aether-link-app\src-tauri\target\release\bundle\nsis\AetherLink Viewer_0.1.1_x64-setup.exe: 24,009,576 bytes
```

## Verification Commands

Commands run by CodeX while reviewing the report:

```powershell
git fetch origin
git rev-parse --short HEAD
git rev-parse --short origin/main
git status --short --untracked-files=all
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "AetherLinkAgent"
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "AetherLinkViewer"
cmd /c aether-link-app\scripts\check-registry-status.bat
```

## Limits Still Not Fully Proven

- Full PC reboot was not performed by CodeX.
- Hidden tray icon visual interaction was not verified by CodeX through the Windows shell UI.
- The self-healing result was reviewed from the reported runtime flow and current machine state; a fresh fully automated destructive server-delete E2E was not rerun by CodeX in this review turn.

## Current Interpretation

The registry startup command and installed executable path are now materially verified on this Windows environment. Reboot persistence and visual tray interaction remain manual physical validation items unless a future run captures direct evidence after reboot.
