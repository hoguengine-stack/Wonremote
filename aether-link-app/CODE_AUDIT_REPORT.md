# Code Audit Report

Date: 2026-06-12
Baseline before edits: `d4b493c`

## Fixed Findings

1. Version drift between Viewer, Agent, Tauri, and update packages
   - Added a shared TypeScript app version constant and package.json alignment test.
   - Agent first-run, Agent bootstrap, update checks, and Viewer first-run config now use the same current app version.
   - Tauri config fallback now uses `CARGO_PKG_VERSION` instead of stale `0.1.0`.
   - E2E update package generation now rewrites `src/domain/appVersion.ts` together with package.json, preventing update loops.

2. Packaged app update safety
   - Viewer no longer reloads on every higher version unless the update response explicitly allows it.
   - Agent source-tree updater is now blocked for packaged Tauri resource directories.
   - This prevents future GitHub version bumps from corrupting installed resources or causing reload loops before a real installer-based updater exists.

3. Unsafe transferred-file save path
   - Agent file downloads now sanitize names and resolve paths inside `%APPDATA%/WonRemote/Downloads`.
   - Path traversal inputs such as `..\..\Windows\win.ini` are collapsed to a safe basename.

4. Invalid config auto-start path
   - Tauri embedded Agent start now requires a config with a non-empty `registeredDeviceId`, not just any config file.
   - This avoids hidden Agent processes blocking on prompts when the config file is incomplete or stale.

5. E2E verification stability
   - E2E expected versions now come from package.json.
   - Noisy heartbeat and tile merge logs are suppressed so the integration flow can complete without pipe/time-limit failures.

## Verification

Commands run successfully:

```powershell
npm test
cargo test # in aether-link-app/src-tauri
cargo test # in aether-link-poc
npm run build
npx tsx tests/e2e/test_e2e_flow.ts
npm run desktop:build
```

Observed results:

```text
Vitest: 14 files, 66 tests passed
Tauri Rust tests: 5 passed
PoC Rust tests: 8 passed
E2E: connection, checksum rejection, rollback, and 0.1.2 update success passed
NSIS installer built: src-tauri/target/release/bundle/nsis/WonRemote Viewer_0.1.2_x64-setup.exe
```

## Remaining Risks

- Production auto-update is now safe-gated, but not a real installer replacement pipeline yet.
- Full Windows reboot persistence and hidden tray icon visual interaction remain physical validation items.
- J1800/J1900 + 2GB RAM performance and ZOOK baseline comparison remain unmeasured on target hardware.
- Visual Ping `T_presented` is implemented as a PoC path, but physical display/fence-level validation is still not complete.

## Next Implementation Priority

Implement the real production updater:

1. Fetch a signed GitHub Release manifest rather than raw package.json.
2. Download the NSIS installer or a dedicated signed updater asset.
3. Verify SHA-256 and version before execution.
4. Launch the installer from the Tauri shell with a controlled handoff.
5. Preserve rollback behavior for source-tree E2E tests, but keep it separate from packaged production updates.
